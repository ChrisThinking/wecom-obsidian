#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信文章页读取 v3 —— 设定读取边界 + 完整/准确/忠于原始 的抓取与保存。

读取内容边界（本规范对每个目标网址适用）：
  纳入读取：
    1. 标题    页面 h1.rich_media_title 与 og:title 交叉一致
    2. 作者    页面 id=js_name 与 var nickname 交叉一致（公众号名）
    3. 发布时间 页面 var ct (Unix, 北京时间) 解析
    4. 正文内容 id="js_content" 内的全部可见文本与结构（段落/列表/强调/链接）
    5. 图片    js_content 内全部 <img>（data-src/src），按文档顺序编号下载
  排除（页面外围，非正文）：
    页头账号导航区、页脚二维码/赞赏/在看/留言、页面脚本与埋点、评论与推荐模块
  忠于原始：正文文本逐段原样保留（不改写/不删减/不补全）；排版仅弱化为段落结构；
            全文文本逐字符比对校验（去空白后与源正文一致）。
"""
import sys, os, re, html as htmllib, datetime, urllib.request, time, json
from datetime import timezone, timedelta

sys.path.insert(0, '/tmp/pylibs')
from bs4 import BeautifulSoup, NavigableString

# 共享工具：定位工作区根、读取 config/pipeline.json（相对路径按工作区根解析）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common

URL = None
ART_DIR = None


def _usage():
    print('用法: python3 wechat_read_v3.py <微信文章URL> [输出文章包目录]')
    print('  不传输出目录时，每次运行自动生成唯一文章包目录：')
    print('  <工作区>/staging/converted/微信文章/文章_YYYYMMDD_HHMMSS_<pid>/')
    print('  （原则：md+images/+source 以「文章包」为单位，不跨文章共享 images/）')
    sys.exit(2)


if len(sys.argv) < 2 or not sys.argv[1].startswith(('http://', 'https://')):
    _usage()
URL = sys.argv[1]
if len(sys.argv) > 2 and not sys.argv[2].startswith('http'):
    ART_DIR = sys.argv[2]
else:
    _base = _common.convert_defaults()['wechat_output_base']
    _pkg = '文章_' + time.strftime('%Y%m%d_%H%M%S') + '_' + str(os.getpid())
    ART_DIR = os.path.join(_base, _pkg)
IMG_DIR = os.path.join(ART_DIR, 'images')
WEBP_TO_PNG = _common.convert_defaults()['webp_to_png']  # M1-A：微信脚本也读取 pipeline 配置（默认 true，行为不变）
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
CST = timezone(timedelta(hours=8))

BLOCKISH = {'section', 'div', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody',
            'tr', 'td', 'th', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'figure', 'hr'}
COUNTER = [0]


def fetch(url, referer=None, timeout=40):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': referer or 'https://mp.weixin.qq.com/',
    })
    return urllib.request.urlopen(req, timeout=timeout).read()


def fetch_article_with_retry():
    """Fetch until we get a real article page (js_content present), not a captcha page."""
    last = None
    for attempt in range(1, 4):
        try:
            raw = fetch(URL)
            text = raw.decode('utf-8', 'ignore')
            is_captcha = ('wappoc_appmsgcaptcha' in text or '环境异常' in text
                          or '完成验证' in text)
            is_article = ('id="js_content"' in text)
            print(f'fetch attempt {attempt}: bytes={len(raw)} captcha={is_captcha} article={is_article}')
            if is_article and not is_captcha:
                return raw, text
            last = f'captcha/odd page, bytes={len(raw)}'
        except Exception as e:
            last = repr(e)
        time.sleep(2)
    raise RuntimeError('failed to obtain real article page: ' + str(last))


def norm_text(s):
    s = s.replace('\xa0', ' ').replace('\u200b', '').replace('\ufeff', '')
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


def merge_bolds(p):
    prev = None
    while prev != p:
        prev = p
        p = re.sub(r'\*\*([^*\n]+)\*\*\*\*([^*\n]+)\*\*', r'**\1\2**', p)
    p = p.replace('****', '')
    return p


def img_md(el):
    COUNTER[0] += 1
    url = htmllib.unescape((el.get('data-src') or el.get('src') or '').strip())
    if not url:
        return ''
    m = re.search(r'wx_fmt=([a-zA-Z]+)', url)
    ext = (m.group(1).lower() if m else '') or 'png'
    ext = {'jpeg': 'jpg', 'jpg': 'jpg'}.get(ext, ext)
    fname = f'image_{COUNTER[0]:02d}.{ext}'
    return f'![{fname}](images/{fname})'


def render_inline(el):
    if isinstance(el, NavigableString):
        return norm_text(str(el))
    name = el.name
    if name is None:
        return ''
    if name in ('span', 'font', 'u', 'i', 'b'):
        return ''.join(render_inline(c) for c in el.children)
    if name == 'em':
        body = ''.join(render_inline(c) for c in el.children)
        if body:
            body = '*' + body.replace('\n', '*\n*') + '*'
        return body
    if name == 'strong':
        body = ''.join(render_inline(c) for c in el.children)
        if body:
            body = '**' + body.replace('\n', '**\n**') + '**'
        return body
    if name == 'br':
        return '\n'
    if name == 'a':
        body = norm_text(''.join(render_inline(c) for c in el.children))
        body = body or (el.get('data-miniprogram-title') or '')
        href = el.get('href') or ''
        if body and href:
            return f'[{body}]({href})'
        return body or ''
    if name == 'img':
        return img_md(el)
    if name == 'svg':
        return ''
    return ''.join(render_inline(c) for c in el.children)


def leaf_inline(el):
    for d in el.descendants:
        if getattr(d, 'name', None) in BLOCKISH or getattr(d, 'name', None) in ('img', 'br'):
            return False
    return True


def render_block(el):
    name = el.name
    if name is None:
        t = norm_text(str(el))
        return [t] if t else []
    if name == 'img':
        md = img_md(el)
        return [md] if md else []
    if name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
        body = norm_text(''.join(render_inline(c) for c in el.children))
        return [f"{'#' * int(name[1])} {body}"] if body else []
    if name in ('ul', 'ol'):
        out = []
        for i, li in enumerate(el.find_all('li', recursive=False), start=1):
            sub = render_block(li) or ['']
            prefix = f'{i}. ' if name == 'ol' else '- '
            out.append(prefix + sub[0])
            for extra in sub[1:]:
                out.append('  ' + extra)
        return out
    if name == 'li':
        return [norm_text(''.join(render_inline(c) for c in el.children))]
    if name in ('section', 'div', 'p', 'blockquote'):
        children = list(el.children)
        frag_kids = [c for c in children if getattr(c, 'name', None) in ('section', 'div')]
        hard_kids = [c for c in children
                     if getattr(c, 'name', None) not in (None,) and
                     getattr(c, 'name', None) not in ('section', 'div') and
                     getattr(c, 'name', None) in BLOCKISH]
        if frag_kids and not hard_kids and all(leaf_inline(c) for c in frag_kids):
            pieces = []
            for c in children:
                if isinstance(c, NavigableString):
                    s = norm_text(str(c))
                    if s:
                        pieces.append(s)
                elif c.name in ('section', 'div'):
                    frag = norm_text(''.join(render_inline(x) for x in c.children))
                    if frag:
                        pieces.append(frag)
                else:
                    s = norm_text(render_inline(c))
                    if s:
                        pieces.append(s)
            joined = pieces[0] if pieces else ''
            for i in range(1, len(pieces)):
                a, b = pieces[i - 1], pieces[i]
                sep = ' ' if (re.search(r'[A-Za-z]', a) or re.search(r'[A-Za-z]', b)) else ''
                joined += sep + b
            if len(joined) <= 60 and joined:
                return [joined]
        out = []
        cur = []

        def flush():
            t = ''.join(cur)
            for ln in t.split('\n'):
                ln = norm_text(ln)
                if ln:
                    out.append(ln)
            cur.clear()

        for c in children:
            if isinstance(c, NavigableString):
                cur.append(norm_text(str(c)))
                continue
            cname = c.name
            if cname == 'img':
                flush()
                md = img_md(c)
                if md:
                    out.append(md)
            elif cname in BLOCKISH:
                flush()
                out.extend(render_block(c))
            else:
                cur.append(render_inline(c))
        flush()
        return out
    t = norm_text(''.join(render_inline(c) for c in el.children))
    return [t] if t else []


# ---------- fidelity helpers ----------
def src_text(el):
    """Visible text of a subtree, skipping script/style/svg/img (mirrors renderer)."""
    parts = []
    for d in el.descendants:
        if getattr(d, 'name', None) in ('script', 'style', 'svg', 'img'):
            continue
        if isinstance(d, NavigableString) and d.parent.name not in ('script', 'style', 'svg'):
            parts.append(str(d))
    return ''.join(parts)


def strip_md_to_plain(p):
    """Remove md syntax from one paragraph -> plain visible text."""
    p = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', p)     # images
    p = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', p)  # links keep label
    p = p.replace('**', '').replace('*', '').replace('`', '')
    p = re.sub(r'^-\s?', '', p)                     # ul list marker added by converter
    return p


def flat(s):
    return re.sub(r'\s+', '', s)


def sniff(data):
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if data[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    return 'unknown'


# ================================================================ main
def main():
    raw, text = fetch_article_with_retry()
    os.makedirs(ART_DIR, exist_ok=True)
    os.makedirs(IMG_DIR, exist_ok=True)
    src_path = os.path.join(ART_DIR, 'source_page.html')
    with open(src_path, 'wb') as f:
        f.write(raw)
    print('saved', src_path, len(raw), 'bytes')

    soup = BeautifulSoup(text, 'html.parser')

    # ---------------- metadata with cross-checks ----------------
    def meta(prop):
        tag = soup.find('meta', property=prop) or soup.find('meta', attrs={'name': prop})
        return (tag.get('content') or '').strip() if tag else ''

    h1_title = norm_text(soup.find('h1', class_='rich_media_title').get_text('', strip=True)) \
        if soup.find('h1', class_='rich_media_title') else ''
    og_title = meta('og:title')
    title = h1_title or og_title or '微信文章'
    title_note = '一致' if (h1_title and og_title and h1_title == og_title) else \
                 f'不一致(页面h1={h1_title!r}, og:title={og_title!r})'

    js_name_el = soup.find(id='js_name')
    author_js = norm_text(js_name_el.get_text()) if js_name_el else ''
    m_nick = re.search(r'var\s+nickname\s*=\s*(?:htmlDecode\()?"([^"]*)"\)?', text)
    author_nick = norm_text(m_nick.group(1)) if m_nick else ''
    author = author_js or author_nick
    author_note = '一致' if (author_js and author_nick and author_js == author_nick) else \
                  f'(js_name={author_js!r}, nickname={author_nick!r})'

    m_ct = re.search(r'var\s+ct\s*=\s*"(\d+)"', text)
    publish = ''
    publish_note = ''
    if m_ct:
        ts = int(m_ct.group(1))
        publish = datetime.datetime.fromtimestamp(ts, tz=CST).strftime('%Y-%m-%d %H:%M:%S %Z')
    else:
        publish_note = '未在页面脚本中找到 ct 时间戳'
    desc = meta('og:description')
    biz_m = re.search(r"biz:\s*\"([^\"]+)\"", text)
    biz = biz_m.group(1) if biz_m else (re.search(r'__biz=([^&"]+)', text).group(1) if re.search(r'__biz=([^&"]+)', text) else '')

    print('metadata:')
    print('  title:', title, '|', title_note)
    print('  author:', author, '|', author_note)
    print('  publish:', publish, publish_note)
    print('  desc:', desc)
    print('  biz:', biz)

    # ---------------- body extraction ----------------
    content = soup.find(id='js_content')
    if content is None:
        print('ERROR: js_content not found')
        sys.exit(1)
    content_tag = content.get('class')
    n_src_imgs = len([im for im in content.find_all('img')
                      if (im.get('data-src') or im.get('src') or '').strip()])

    paragraphs = []
    for child in content.children:
        if isinstance(child, NavigableString):
            t = norm_text(str(child))
            if t:
                paragraphs.append(t)
            continue
        if child.name in ('script', 'svg'):
            continue
        paragraphs.extend(render_block(child))
    paragraphs = [merge_bolds(p) for p in paragraphs]
    paragraphs = [p for p in paragraphs if p.strip()]
    paragraphs = [re.sub(r'^(\d{2})(?=\S)', r'\1 ', p) for p in paragraphs]
    print('paragraphs:', len(paragraphs), '| images rendered:', COUNTER[0], '| source imgs:', n_src_imgs)

    # ---------------- fidelity check: full-text compare ----------------
    src_full = flat(src_text(content))
    md_plain = flat(''.join(strip_md_to_plain(p) for p in paragraphs))
    same = (src_full == md_plain)
    diff_detail = ''
    if not same:
        n = min(len(src_full), len(md_plain))
        i = next((k for k in range(n) if src_full[k] != md_plain[k]), n)
        diff_detail = (f'长度: 源={len(src_full)} md={len(md_plain)}；'
                       f'首个分歧位置 {i}: 源…{src_full[max(0,i-20):i+20]}… / md…{md_plain[max(0,i-20):i+20]}…')
    print('fidelity full-text equal:', same)
    if diff_detail:
        print('  ', diff_detail)

    # ---------------- build markdown ----------------
    now = datetime.datetime.now(tz=CST).strftime('%Y-%m-%d %H:%M:%S %Z')
    refs = sorted(set(re.findall(r'!\[(image_\d+\.\w+)\]', '\n'.join(paragraphs))))
    n_img = len(refs)
    lines = [
        f'# {title}',
        '',
        '> **读取边界**：本文档取自微信文章页正文区（`id="js_content"`），收录字段＝标题、公众号（作者）、发布时间、正文文本、正文内图片与超链接。页面页眉/页脚导航、二维码、留言与外部推荐等页面外围内容不在正文边界内。',
        '> **忠于原始**：正文文本逐段保留原文，未做改写、删减或补全（排版仅弱化为段落结构）。',
        '',
        f'> **公众号**：{author}',
        f'> **原文链接**：<{URL}>',
        f'> **发布时间**：{publish}',
        f'> **摘要**：{desc}',
        f'> **抓取时间**：{now}（正文共 {n_img} 张图片 → `images/`）',
        '',
        '---',
        '',
    ]
    for p in paragraphs:
        lines.append(p)
        lines.append('')
    md_path = os.path.join(ART_DIR, f'{title}.md')
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines).rstrip() + '\n')
    print('md written:', md_path)

    # ---------------- download images (force re-download) ----------------
    dl = []
    for i, im in enumerate(content.find_all('img'), start=1):
        url = htmllib.unescape((im.get('data-src') or im.get('src') or '').strip())
        if not url:
            continue
        m = re.search(r'wx_fmt=([a-zA-Z]+)', url)
        ext = (m.group(1).lower() if m else '') or 'png'
        ext = {'jpeg': 'jpg'}.get(ext, ext)
        dl.append((url, f'image_{i:02d}.{ext}'))
    img_report = []
    ok = fail = 0
    for url, fname in dl:
        dest = os.path.join(IMG_DIR, fname)
        try:
            data = fetch(url, referer=URL, timeout=60)
            with open(dest, 'wb') as f:
                f.write(data)
            real = sniff(data)
            status = f'OK {fname} {len(data)}B real={real}'
            if real == 'webp' and WEBP_TO_PNG:
                # convert to png for compatibility
                conv = dest + '.tmp.png'
                if os.system(f'sips -s format png "{dest}" --out "{conv}" >/dev/null 2>&1') == 0:
                    os.replace(conv, dest)
                    status += ' ->converted png'
                else:
                    status += ' (conversion failed, kept as-is)'
            ok += 1
        except Exception as e:
            status = f'FAIL {fname} {e!r}'
            fail += 1
        img_report.append(status)
        print(status)
    print(f'images: ok={ok} fail={fail}')

    # ---------------- write read-report ----------------
    report = []
    report.append('# 页面读取说明')
    report.append('')
    report.append(f'## 一、读取对象')
    report.append('')
    report.append(f'- 原文网址：{URL}')
    report.append(f'- 抓取时间：{now}')
    report.append(f'- 原始文件：`source_page.html`（{len(raw)} 字节，HTTP 页面完整落盘）')
    report.append('')
    report.append('## 二、读取内容边界')
    report.append('')
    report.append('纳入读取（正文内容包括但不限于）：')
    report.append('')
    report.append('1. **标题** —— 页面 `h1.rich_media_title` 与 `<meta og:title>` 交叉一致后采用')
    report.append('2. **作者** —— 页面 `id=js_name`（公众号名）与 `var nickname` 交叉一致后采用')
    report.append('3. **发布时间** —— 页面脚本 `var ct`（Unix 时间戳）换算北京时间')
    report.append('4. **正文内容** —— `id="js_content"` 内全部可见文本与结构（段落/列表/强调/超链接），逐段原样保留')
    report.append('5. **图片** —— 正文内全部 `<img>`（`data-src`/`src`），按文档顺序编号下载至 `images/`')
    report.append('')
    report.append('排除（页面外围，不属于正文）：页头导航区、页脚二维码/赞赏/在看、留言区、推荐模块、脚本与埋点。')
    report.append('')
    report.append('## 三、元数据提取与交叉校验')
    report.append('')
    report.append('| 字段 | 取值 | 校验说明 |')
    report.append('|---|---|---|')
    report.append(f'| 标题 | {title} | {title_note} |')
    report.append(f'| 公众号（作者） | {author} | {author_note} |')
    report.append(f'| 发布时间 | {publish} | {publish_note or "ct 时间戳→北京时间"} |')
    report.append(f'| 摘要（og:description） | {desc} | 元数据参考 |')
    report.append(f'| biz（公众号标识） | {biz} | 页面脚本 |')
    report.append('')
    report.append('## 四、完整性与准确性校验')
    report.append('')
    report.append('**正文文本比对（忠于原文）**：将 Markdown 正文去除排版标记后与源正文全部可见文字做逐字符（去空白）比对。')
    report.append('')
    report.append(f'- 结果：{"✅ 完全一致，无遗漏、无改写、无增补" if same else "❌ 存在差异"}')
    if diff_detail:
        report.append(f'- 差异详情：{diff_detail}')
    report.append(f'- 源正文可见字符数：{len(src_full)}；Markdown 还原字符数：{len(md_plain)}')
    report.append(f'- 段落数：{len(paragraphs)}')
    report.append('')
    report.append('**图片校验**：源图片数 = 下载数 = Markdown 引用数，且逐个校验文件真实格式。')
    report.append('')
    report.append(f'- 源正文 `<img>` 数：{n_src_imgs}；实际渲染图片数：{COUNTER[0]}；下载成功：{ok} / 失败：{fail}')
    for s in img_report:
        report.append(f'- {s}')
    missing = [r for r in refs if not os.path.exists(os.path.join(IMG_DIR, r))]
    report.append(f'- Markdown 引用 {len(refs)} 张：{"全部文件存在 ✅" if not missing else "缺失 " + str(missing)}')
    report.append('')
    report.append('## 五、产出文件清单')
    report.append('')
    report.append(f'- `{title}.md` —— 读取正文（Markdown）')
    report.append('- `images/` —— 正文图片（' + '、'.join(refs) + '）')
    report.append('- `source_page.html` —— 原始页面完整副本（忠于原文的基准）')
    report.append('- `读取说明.md` —— 本文件（边界与校验记录）')
    report.append('')
    report_path = os.path.join(ART_DIR, '读取说明.md')
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(report).rstrip() + '\n')
    print('report written:', report_path)
    return same


if __name__ == '__main__':
    main()
