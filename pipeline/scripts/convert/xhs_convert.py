#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小红书笔记网页 → Markdown + 图片落盘（通用版）
================================================
用法:
    python3 xhs_convert.py <URL> [输出文章目录] [--dry]

    <URL>        支持 xhslink.cn 短链，或完整的
                 xiaohongshu.com/discovery/item/... 链接（可带 xsec_token）
    [输出目录]   文章保存目录（可选；缺省读 config/pipeline.json 的
                 convert.xhs_output_base，即 <工作区>/staging/converted/小红书笔记/文章名）
    [--dry]      仅解析元数据并打印，不下载图片、不写文件

依赖: 仅 Python3 标准库。图片若为 webp 且配置 webp_to_png=true 时，
      用 macOS 自带 sips 转 png（无 sips 的环境保持原格式）。
"""
import datetime
import json
import os
import re
import sys
import time
import urllib.request

CST = datetime.timezone(datetime.timedelta(hours=8))
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
# 共享工具：定位工作区根、读取 config/pipeline.json（相对路径按工作区根解析）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common


def log(msg):
    print(msg, flush=True)


def fetch(url, referer='https://www.xiaohongshu.com/', timeout=40, retries=3):
    last = None
    for _ in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA,
                'Referer': referer,
                'Accept': ('text/html,application/xhtml+xml,application/xml;q=0.9,'
                           'image/avif,image/webp,image/apng,*/*;q=0.8'),
                'Accept-Language': 'zh-CN,zh;q=0.9',
            })
            return urllib.request.urlopen(req, timeout=timeout).read()
        except Exception as e:
            last = repr(e)
            time.sleep(2)
    raise RuntimeError('fetch failed: ' + str(last))


def sniff(data):
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if data[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    return 'bin'


def parse_note(text):
    """从页面 __INITIAL_STATE__ 提取笔记；兼容多笔记场景，取 URL 对应的那条。"""
    i = text.find('window.__INITIAL_STATE__=')
    if i < 0:
        raise RuntimeError('页面中未找到 __INITIAL_STATE__（可能被风控拦截）')
    start = text.find('{', i)
    end = text.find('</script>', start)
    state = json.loads(text[start:end].replace('undefined', 'null'))
    nmap = (state.get('note') or {}).get('noteDetailMap') or {}
    if not nmap:
        raise RuntimeError('noteDetailMap 为空，未能取到笔记数据')
    wanted = state.get('note') or {}
    cur = wanted.get('currentNoteId') or ''
    note = None
    if cur and cur in nmap:
        note = nmap[cur].get('note')
    if note is None:
        note = list(nmap.values())[0].get('note')
    return state, note


def slug(s, n=40):
    s = re.sub(r'[\\/:*?"<>|\s]+', '_', s).strip('_')
    return s[:n] or 'note'


def download_images(imgs, img_dir):
    """下载笔记图片。

    @returns {{results: list, failed: list}} `results` 为 `(序号, 文件名或 None, 说明)`；
        `failed` 为 `[(序号, 原始 url)]` —— 失败图**保留原 URL**，由组装阶段写成
        外部图片引用，交给 verify 拦截（不能悄悄丢图还报成功）。
    """
    results = []
    failed = []
    for idx, im in enumerate(imgs, start=1):
        u = im.get('urlDefault') or ''
        if not u:
            results.append((idx, None, 'no-url'))
            continue
        try:
            data = fetch(u)
            real = sniff(data)
            ext = real if real in ('png', 'jpg', 'gif') else 'jpg'
            fname = f'image_{idx:02d}.{ext}'
            with open(os.path.join(img_dir, fname), 'wb') as f:
                f.write(data)
            results.append((idx, fname, f'OK {len(data)}B real={real}'))
            log(f'  image_{idx:02d} OK {len(data)}B real={real}')
        except Exception as e:
            results.append((idx, None, f'FAIL {e!r}'))
            failed.append((idx, u))
            log(f'  image_{idx:02d} FAIL（保留原 URL，Verify 将拦截）{e!r}')
    return {'results': results, 'failed': failed}


def main():
    args = sys.argv[1:]
    dry = '--dry' in args
    args = [a for a in args if a != '--dry']
    if not args:
        log('用法: python3 xhs_convert.py <URL> [输出文章目录] [--dry]')
        sys.exit(1)
    url_arg = args[0]
    _defs = _common.convert_defaults()
    webp2png = _defs['webp_to_png']

    html = fetch(url_arg)
    text = html.decode('utf-8', 'ignore')
    final_url = text and url_arg  # urllib 跟随跳转，短链已在内部解析
    # 若输入是短链，先请求一次拿最终落地 URL（用于定位笔记 id）
    if 'xiaohongshu.com' not in url_arg:
        try:
            req = urllib.request.Request(url_arg, headers={'User-Agent': UA})
            resp = urllib.request.urlopen(req, timeout=30)
            final_url = resp.geturl()
        except Exception:
            pass
    state, note = parse_note(text)
    _t = (note.get('title') or '').strip()
    if not _t:
        # 小红书常见：作者只写正文、未设独立标题（卡片展示正文首行）→ desc 首行兜底，
        # 不再回退通用名（避免 FORMAT/入库标题错误、避免人工确认）。
        _desc = (note.get('desc') or '')
        _first = next((ln.strip() for ln in _desc.split('\n') if ln.strip()), '')
        _t = _first or _desc.strip() or '小红书笔记'
    title = _t
    user = note.get('user') or {}
    author = user.get('nickname') or ''
    ts_ms = note.get('time')
    pub = ''
    if ts_ms:
        pub = datetime.datetime.fromtimestamp(ts_ms / 1000, tz=CST).strftime('%Y-%m-%d %H:%M:%S %Z')
    desc = note.get('desc') or ''
    tags = [t.get('name') for t in (note.get('tagList') or []) if t.get('name')]
    imgs = note.get('imageList') or []
    link = (final_url or url_arg).split('?')[0]
    log(f'title={title!r} author={author!r} pub={pub} images={len(imgs)}')
    if dry:
        log(f'[dry] 输出将保存至: （未执行下载）')
        return 0

    # —— 决定文章目录 ——
    if len(args) > 1:
        art_dir = args[1]
    else:
        base = _defs['xhs_output_base']
        art_dir = os.path.join(base, slug(title))
    img_dir = os.path.join(art_dir, 'images')
    os.makedirs(img_dir, exist_ok=True)
    with open(os.path.join(art_dir, 'source_page.html'), 'wb') as f:
        f.write(html)

    # —— 下载图片 ——
    dl = download_images(imgs, img_dir)
    results = dl['results']
    failed_imgs = dl['failed']

    # —— webp → png ——
    if webp2png:
        for idx, fname, s in list(results):
            if fname and fname.endswith('.webp'):
                src = os.path.join(img_dir, fname)
                dst = os.path.join(img_dir, fname[:-5] + '.png')
                if os.system(f'sips -s format png "{src}" --out "{dst}" >/dev/null 2>&1') == 0:
                    os.remove(src)
                    results[results.index((idx, fname, s))] = (idx, fname[:-5] + '.png', s + ' ->png')

    # —— 组装 Markdown ——
    now = datetime.datetime.now(tz=CST).strftime('%Y-%m-%d %H:%M:%S %Z')
    desc_paras = [p.strip() for p in re.split(r'\n+', desc) if p.strip()]
    lines = [
        f'# {title}', '',
        '> **来源**：小红书笔记（经网页抓取）。正文文字与全部图片按原顺序收录；评论区、推荐等页面外围内容不纳入。',
        f'> **作者**：{author}',
        f'> **原文链接**：<{link}>',
        f'> **发布时间**：{pub}',
        f'> **标签**：{"、".join(tags)}',
        f'> **抓取时间**：{now}（共 {len(imgs)} 张图 → `images/`）',
        '', '---', '', '## 正文', '',
    ]
    for p in desc_paras:
        lines.append(p)
        lines.append('')
    lines += ['---', '', '## 图文内容（按原顺序）', '']
    for _idx, fname, _s in results:
        if fname:
            lines.append(f'![{fname}](images/{fname})')
            lines.append('')
    # 下载失败的图**保留原 URL**：verify 会以「外部 http(s) 图片链接」判 FAIL，
    # 而不是悄悄丢图、再让后面全链报告成功。
    for idx, url in failed_imgs:
        lines.append(f'![image_{idx:02d}]({url})')
        lines.append('')
    _fname = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '_', title).strip() or '小红书笔记'
    md_path = os.path.join(art_dir, f'{_fname}.md')
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines).rstrip() + '\n')

    ok = sum(1 for _, fn, _ in results if fn)
    log(f'md written: {md_path}')
    log(f'images: ok={ok}/{len(imgs)}')
    return 0


if __name__ == '__main__':
    # 单篇转换墙钟上限（设置页「单篇转换超时」）：见 _common.run_guarded
    sys.exit(_common.run_guarded(main))
