#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
微信「分享页」消息读取 v3-s —— 图片消息 / 文字消息 → Content Package（ACQUIRE 补充转换器）。

存在原因（2026-09，与 wechat_read_v3.py 并存，不改其核心逻辑）：
  微信发表记录里的部分条目不是「图文」(appmsg/newindex.html)，而是
    - 图片消息  item_show_type=8  （page: mmbizwap:pages/common_share.html）
    - 文字消息  item_show_type=10 （page: mmbizwap:pages/common_share.html）
  这类条目对非微信客户端只返回「分享页」：页面内**没有** `id="js_content"` 正文 DOM，
  因此 wechat_read_v3.py 的 article 判定必然失败（报 captcha/odd page）。

读取边界（严格来自分享页内在数据，不臆造）：
  图片消息：图片 = 页面模板 `picture_page_info_list[].cdn_url`（按文档顺序全部下载）
            文本 = `window.desc`（JS 字符串，含 `\\xNN` 转义与轻量 HTML；转纯文本 + 链接）
  文字消息：正文 = `content_noencode`（JS 字符串，全文，`\\x0a` 为换行）
  元数据：标题/公众号/发布时间(biz,ct)/url 取自页面脚本与 og: 标签

产物（与 acquire 契约一致）：
  <工作区>/staging/converted/微信文章/分享_YYYYMMDD_HHMMSS_<pid>/
      <标题>.md + images/ + source_page.html + metadata.json + 读取说明.md
  成功标记：`md written: <…>.md`（与 wechat_read_v3.py 一致，供编排层复用）

用法: python3 wechat_share_v3.py <分享页URL> [输出文章包目录]
"""
import datetime
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.request
from datetime import timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # scripts/
import _common
import wf_common as wf

URL = None
ART_DIR = None
IMG_DIR = None

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
CST = timezone(timedelta(hours=8))
WEBP_TO_PNG = _common.convert_defaults()['webp_to_png']

TYPE_NAME = {'8': '图片消息', '10': '文字消息'}


def _usage():
    print('用法: python3 wechat_share_v3.py <微信分享页URL> [输出文章包目录]')
    sys.exit(2)


# ---------------------------------------------------------------- fetch
def fetch(url, referer=None, timeout=60):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': referer or 'https://mp.weixin.qq.com/',
    })
    return urllib.request.urlopen(req, timeout=timeout).read()


# ---------------------------------------------------------------- js string
def js_unescape(s):
    """解码 JS 字符串字面量内容（\\xNN / \\uNNNN / 常见转义）。"""
    out = []
    i = 0
    simple = {'n': '\n', 'r': '\r', 't': '\t', 'b': '\b', 'f': '\f',
              '\\': '\\', "'": "'", '"': '"', '/': '/', '0': '\0'}
    while i < len(s):
        c = s[i]
        if c == '\\' and i + 1 < len(s):
            n = s[i + 1]
            if n == 'x' and i + 3 < len(s):
                try:
                    out.append(chr(int(s[i + 2:i + 4], 16))); i += 4; continue
                except ValueError:
                    pass
            if n == 'u' and i + 5 < len(s):
                try:
                    out.append(chr(int(s[i + 2:i + 6], 16))); i += 6; continue
                except ValueError:
                    pass
            if n in simple:
                out.append(simple[n]); i += 2; continue
            out.append(n); i += 2; continue
        out.append(c); i += 1
    return ''.join(out)


def read_js_string(text, start, quote):
    """text[start] == quote；返回 (raw_inner, end_index)。"""
    i = start + 1
    buf = []
    while i < len(text):
        c = text[i]
        if c == '\\':
            buf.append(text[i:i + 2]); i += 2; continue
        if c == quote:
            break
        buf.append(c); i += 1
    return ''.join(buf), i


def find_js_var(text, pattern, quote):
    """pattern 之后的 JS 字符串字面量 → 解码后的值（兼容 pattern 是否已吃掉引号）。"""
    m = re.search(pattern, text)
    if not m:
        return ''
    i = m.end()
    while i < len(text) and text[i] in ' \t':
        i += 1
    if i >= len(text) or text[i] != quote:
        if m.end() - 1 >= 0 and text[m.end() - 1] == quote:
            i = m.end() - 1
        else:
            return ''
    raw, _ = read_js_string(text, i, quote)
    return js_unescape(raw)


def meta_content(text, prop):
    m = re.search(r'<meta[^>]+(?:property|name)="%s"[^>]*content="([^"]*)"' % re.escape(prop), text)
    if not m:
        m = re.search(r'<meta[^>]+content="([^"]*)"[^>]*(?:property|name)="%s"' % re.escape(prop), text)
    return htmllib.unescape(m.group(1)) if m else ''


# ---------------------------------------------------------------- extract
def detect_type(text):
    m = re.search(r"item_show_type[:=]\s*'(\d+)'", text) or \
        re.search(r"item_show_type\s*=\s*'(\d+)'", text)
    return m.group(1) if m else ''


def picture_list_images(text):
    """从所有 `picture_page_info_list: [ … ]` 块中按顺序取 cdn_url（括号配平扫描）。"""
    urls = []
    for m in re.finditer(r'picture_page_info_list\s*:\s*\[', text):
        i = m.end() - 1
        depth = 0
        j = i
        while j < len(text):
            if text[j] == '[':
                depth += 1
            elif text[j] == ']':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        block = text[i:j + 1]
        for u in re.findall(r"cdn_url:\s*'([^']+)'", block):
            if u.startswith('http'):
                urls.append(htmllib.unescape(js_unescape(u)))
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u); out.append(u)
    return out


def _anchor(m):
    attrs, inner = m.group(1), m.group(2)
    label = htmllib.unescape(re.sub(r'<[^>]+>', '', inner)).strip()
    hm = re.search(r'href="([^"]*)"', attrs)
    if hm and hm.group(1).startswith('http'):
        return '[%s](%s)' % (label, htmllib.unescape(hm.group(1)))
    return label


def rich_to_text(raw):
    """分享页富文本 → 纯文本（可含 markdown 链接）；图片消息 desc 与文字消息全文共用。

    微信分享页文本常见两层编码叠加：JS 字符串转义（`\\xNN`）+ HTML 转义（`&lt;a …`）。
    处理顺序必须是：**先还原 HTML 标记 → 再做标签处理 → 最后消残余实体**。
    否则被转义的标签会在末次 unescape 时「复活」成裸 HTML（历史 bug：正文残留 `<a …>`、`&nbsp;`、`&amp;`）。
    """
    if not raw:
        return ''
    s = htmllib.unescape(raw)                    # 层1：&lt;a → <a；&amp;nbsp; → &nbsp;
    s = re.sub(r'(?is)<script.*?</script>|<style.*?</style>', '', s)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)</(p|div|section|li|h[1-6]|tr|td|blockquote)>', '\n\n', s)
    s = re.sub(r'(?i)<(p|div|section|li|h[1-6]|tr|td|blockquote)[^>]*>', '', s)
    s = re.sub(r'(?is)<a\b([^>]*)>(.*?)</a>', _anchor, s)
    s = re.sub(r'(?s)<[^>]+>', '', s)
    s = htmllib.unescape(s)                      # 层2：残余实体 &nbsp; &amp; &quot; …
    s = s.replace('\u200b', '').replace('\xa0', ' ')
    s = re.sub(r'[ \t]+\n', '\n', s)
    s = re.sub(r'[ \t]{2,}', ' ', s)
    s = re.sub(r'\n{3,}', '\n\n', s)
    return s.strip()


def clean_title(t):
    """标题：还原转义/去标签/压平空白（微信文字消息的 title 即整段文本）。"""
    if not t:
        return ''
    t = htmllib.unescape(t)
    t = re.sub(r'(?s)<[^>]+>', '', t)
    t = htmllib.unescape(t)
    t = t.replace('\u200b', '').replace('\xa0', ' ')
    return re.sub(r'\s+', ' ', t).strip()


# ---------------------------------------------------------------- images
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


def download_images(urls):
    ok, fail, lines = 0, 0, []
    for i, u in enumerate(urls, start=1):
        try:
            data = fetch(u, referer=URL, timeout=60)
            real = sniff(data)
            ext = real if real in ('png', 'jpg', 'gif', 'webp') else 'jpg'
            dest = os.path.join(IMG_DIR, 'image_%02d.%s' % (i, ext))
            with open(dest, 'wb') as f:
                f.write(data)
            status = 'OK image_%02d.%s %dB real=%s' % (i, ext, len(data), real)
            if real == 'webp' and WEBP_TO_PNG:
                conv = dest + '.tmp.png'
                if os.system('sips -s format png "%s" --out "%s" >/dev/null 2>&1' % (dest, conv)) == 0:
                    png = os.path.join(IMG_DIR, 'image_%02d.png' % i)
                    os.replace(conv, png)
                    os.remove(dest)
                    dest, ext = png, 'png'
                    status += ' ->converted png'
                else:
                    status += ' (conversion failed, kept as-is)'
            lines.append((status, 'image_%02d.%s' % (i, ext)))
            ok += 1
        except Exception as e:
            lines.append(('FAIL image_%02d %r' % (i, e), None))
            fail += 1
    return ok, fail, lines


# ---------------------------------------------------------------- main
def main():
    global URL, ART_DIR, IMG_DIR
    if len(sys.argv) < 2 or not sys.argv[1].startswith(('http://', 'https://')):
        _usage()
    URL = sys.argv[1]
    if len(sys.argv) > 2 and not sys.argv[2].startswith('http'):
        ART_DIR = os.path.abspath(sys.argv[2])
    else:
        base = _common.convert_defaults()['wechat_output_base']
        ART_DIR = os.path.join(base, '分享_' + time.strftime('%Y%m%d_%H%M%S') + '_' + str(os.getpid()))
    IMG_DIR = os.path.join(ART_DIR, 'images')

    raw = fetch(URL)
    text = raw.decode('utf-8', 'ignore')

    stype = detect_type(text)
    if stype not in TYPE_NAME:
        print('SHARE_FAIL 非图片/文字分享页（item_show_type=%r），请用 wechat_read_v3.py：%s' % (stype, URL))
        sys.exit(2)
    if 'id="js_content"' in text:
        print('SHARE_FAIL 该 URL 实为图文正文页，请用 wechat_read_v3.py：%s' % URL)
        sys.exit(2)

    os.makedirs(IMG_DIR, exist_ok=True)
    with open(os.path.join(ART_DIR, 'source_page.html'), 'wb') as f:
        f.write(raw)

    # ---- metadata
    title = clean_title(find_js_var(text, r"window\.msg_title\s*=\s*window\.title\s*=\s*", "'")
                        or find_js_var(text, r"window\.msg_title\s*=\s*", "'")
                        or meta_content(text, 'og:title'))
    author = (find_js_var(text, r"window\.name\s*=\s*", '"')
              or find_js_var(text, r"nick_name:\s*", "'"))
    ct = find_js_var(text, r"window\.ct\s*=\s*", "'")
    biz = find_js_var(text, r"window\.biz\s*=\s*", "'")
    if not biz:
        m = re.search(r'__biz=([A-Za-z0-9=+/]+)', text)
        biz = m.group(1) if m else ''
    try:
        publish = datetime.datetime.fromtimestamp(int(ct), CST).strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        publish = ''
    if not title:
        title = clean_title(meta_content(text, 'og:title')) or '未命名'

    # ---- content
    body_parts, img_urls, n_img = [], [], 0
    if stype == '8':   # 图片消息：图片列表 + window.desc 文本
        body_parts.append(rich_to_text(find_js_var(text, r'window\.desc\s*=\s*', '"')))
        img_urls = picture_list_images(text)
    else:              # 文字消息：content_noencode 全文（同样可能含 HTML 标记与实体）
        m = re.search(r"content_noencode:\s*'", text)
        if not m:
            print('SHARE_FAIL 文字消息缺少 content_noencode：%s' % URL)
            sys.exit(2)
        body_parts.append(rich_to_text(js_unescape(read_js_string(text, m.end() - 1, "'")[0])))

    text_block = '\n\n'.join(p for p in body_parts if p)

    ok, fail, img_lines = download_images(img_urls)
    n_img = ok

    # ---- markdown
    now = datetime.datetime.now(tz=CST).strftime('%Y-%m-%d %H:%M:%S %Z')
    lines = [
        '# %s' % title,
        '',
        '> **读取对象**：微信%s分享页（`item_show_type=%s`，非图文 `id="js_content"`）。' % (TYPE_NAME[stype], stype),
        '> **读取边界**：正文取自分享页内在数据（%s）；页头/页脚/推荐等页面外围内容不在边界内。'
        % ('图片列表 `picture_page_info_list` + 文本 `window.desc`' if stype == '8' else '全文 `content_noencode`'),
        '> **忠于原始**：文本与图片均按原文保留，未改写、删减或补全。',
        '',
        '> **公众号**：%s' % author,
        '> **原文链接**：<%s>' % URL,
        '> **发布时间**：%s' % publish,
        '> **消息类型**：%s' % TYPE_NAME[stype],
        '> **抓取时间**：%s（共 %d 张图片 → `images/`）' % (now, n_img),
        '',
        '---',
        '',
    ]
    if text_block:
        lines.append(text_block)
        lines.append('')
    for _st, fname in img_lines:
        if fname:
            lines.append('![](images/%s)' % fname)
            lines.append('')

    md_title = wf.sanitize_name(title)   # 与 FORMAT/STORE 命名规则一致（禁符→_、压缩空白、上限 120）
    md_path = os.path.join(ART_DIR, md_title + '.md')
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines).rstrip() + '\n')

    with open(os.path.join(ART_DIR, 'metadata.json'), 'w', encoding='utf-8') as f:
        json.dump({'title': title, 'url': URL, 'platform': '微信',
                   'published': publish, 'author': author, 'biz': biz,
                   'message_type': TYPE_NAME[stype], 'images': n_img},
                  f, ensure_ascii=False, indent=2)

    with open(os.path.join(ART_DIR, '读取说明.md'), 'w', encoding='utf-8') as f:
        f.write('# 分享页读取说明\n\n- 原文网址：%s\n- 消息类型：%s（item_show_type=%s）\n'
                '- 标题：%s\n- 公众号：%s\n- 发布时间：%s\n- 抓取时间：%s\n'
                '- 原始文件：`source_page.html`（%d 字节）\n- 图片：成功 %d / 失败 %d\n\n'
                '## 图片明细\n\n%s\n'
                % (URL, TYPE_NAME[stype], stype, title, author, publish, now, len(raw), ok, fail,
                   '\n'.join('- %s' % s for s, _ in img_lines) or '- （无）'))

    print('type:', TYPE_NAME[stype], '| item_show_type:', stype)
    print('title:', title)
    print('author:', author, '| publish:', publish, '| biz:', biz)
    print('text chars:', len(text_block), '| images:', n_img)
    for s, _ in img_lines:
        print(s)
    print('md written:', md_path)


if __name__ == '__main__':
    main()
