#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""头条（toutiao）站点适配转换器（M3+ 收尾）：URL → Content Package。

背景：头条 m/www 页面启用 `_$jsvmprt` 动态反爬壳；桌面 UA 直抓拿不到正文。
本转换器：
  1. 请求使用手机 UA 并跟随短链（m.toutiao.com/is/xxx → /article/…）→ 命中真实正文页；
  2. 壳页检测（含 `_$jsvmprt` 或无 `<title>`）→ 换备用 UA 重试一次；仍壳 → 明确失败提示；
  3. 真实页：标题（og:title/<title>）、按 DOM 顺序提取正文段落与图片（启发式容器无关，
     直接按 <p>/<h1-6>/<img> 位置排序，先剔除 script/style/header/nav/footer/aside 区域）；
  4. 产出与其它转换器同构：<标题>.md + images/ + source_page.html + metadata.json。

用法:
    python3 convert_toutiao.py <URL> [输出包目录] [--dry]
成功标记：CONVERT_URL_OK <pkg>（与 convert_url 一致，供编排层复用）。
"""
import datetime
import html as htmlmod
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import timezone, timedelta

CST = timezone(timedelta(hours=8))
UA_MOBILE = ('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 '
             '(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1')
UA_DESKTOP = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
              '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import _common  # noqa: E402

REMOVE_RE = re.compile(
    r'<\s*(script|style|header|nav|footer|aside|noscript)[^>]*>.*?</\s*\1\s*>', re.I | re.S)
P_RE = re.compile(r'<(p|h[1-6]|blockquote|li)[^>]*>(.*?)</\1>', re.I | re.S)
IMG_RE = re.compile(r'<img[^>]*>', re.I)
SRC_RE = re.compile(r'(?:data-src|data-original|src)=["\']([^"\']+)["\']', re.I)
TAG_RE = re.compile(r'<[^>]+>')


def log(msg):
    print(msg, flush=True)


def fetch(url, ua, referer, timeout=30):
    req = urllib.request.Request(url, headers={
        'User-Agent': ua, 'Referer': referer,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.geturl()


def sniff(data):
    for magic, ext in ((b'\x89PNG\r\n\x1a\n', 'png'), (b'\xff\xd8\xff', 'jpg'),
                       (b'GIF87a', 'gif'), (b'GIF89a', 'gif')):
        if data[:len(magic)] == magic:
            return ext
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    return 'bin'


def get_page(url):
    """依次尝试 UA，返回 (html, final_url)；壳页返回 None。"""
    attempts = [(UA_MOBILE, 'https://m.toutiao.com/'), (UA_DESKTOP, 'https://www.toutiao.com/')]
    for ua, ref in attempts:
        try:
            raw, final = fetch(url, ua, ref)
        except Exception as e:
            log('  fetch retry %s -> %r' % (ua[:20], e))
            continue
        text = raw.decode('utf-8', 'ignore')
        shell = ('_$jsvmprt' in text) or ('<title' not in text)
        if not shell:
            return text, final, raw
        log('  命中反爬壳(%s)，换 UA 重试' % ua[:20])
    return None, None, None


def clean_body(html_text):
    """剔除 script/style/header/nav/footer/aside 区块。"""
    return REMOVE_RE.sub(' ', html_text)


_NOISE = ('去听全文', '听资讯', '关注头条新锐', '关注@', '展开全文')


def collect_events(body):
    """返回按位置排序的正文事件：[('p'|'h', text, pos) | ('img', src, pos)]"""
    events = []
    for m in P_RE.finditer(body):
        txt = htmlmod.unescape(TAG_RE.sub('', m.group(2)))
        txt = re.sub(r'\s+', ' ', txt).strip()
        if txt and not any(n in txt for n in _NOISE):
            events.append((m.group(1).lower(), txt, m.start()))
    for m in IMG_RE.finditer(body):
        tag = m.group(0)
        s = SRC_RE.search(tag)
        if s:
            events.append(('img', s.group(1), m.start()))
    events.sort(key=lambda e: e[2])
    return events


def img_ext_for(url, data):
    path = urllib.parse.urlparse(url).path or ''
    m = re.search(r'\.([a-zA-Z0-9]{2,5})$', path)
    g = (m.group(1).lower() if m else '') or sniff(data)
    return {'jpeg': 'jpg'}.get(g, g if g in ('png', 'jpg', 'gif', 'webp') else 'jpg')


def sips_to_png(src, dst):
    return os.system('sips -s format png "%s" --out "%s" >/dev/null 2>&1' % (src, dst)) == 0


def render_body(events, img_dir, webp2png, title):
    """把正文事件渲染成 Markdown，并下载图片。

    **失败的图保留原始 URL**（写成外部图片引用）：`verify_note.py` 会以
    「存在外部 http(s) 图片链接」判 FAIL，从而拦住「悄悄丢图、全链却报告成功」。
    历史实现只打日志、不写引用，图没了也没人知道。

    @returns {(list, list)} `(markdown 行, 失败图片 URL 列表)`
    """
    os.makedirs(img_dir, exist_ok=True)
    img_map = {}
    n_img = 0
    fails = []
    lines = ['# %s' % title, '']
    for kind, val, _pos in events:
        if kind == 'img':
            n_img += 1
            if val in img_map:
                lines.append('![%s](images/%s)' % (img_map[val], img_map[val]))
                lines.append('')
                continue
            try:
                data, _ = _img_fetch(val)
                real = sniff(data)
                if real == 'webp' and webp2png:
                    fname = 'image_%02d.png' % n_img
                    tmp = os.path.join(img_dir, fname[:-4] + '.webp')
                    with open(tmp, 'wb') as f:
                        f.write(data)
                    if not sips_to_png(tmp, os.path.join(img_dir, fname)):
                        fname = 'image_%02d.webp' % n_img
                        os.replace(tmp, os.path.join(img_dir, fname))
                    else:
                        os.remove(tmp)
                else:
                    fname = 'image_%02d.%s' % (n_img, img_ext_for(val, data))
                    with open(os.path.join(img_dir, fname), 'wb') as f:
                        f.write(data)
                img_map[val] = fname
                lines.append('![%s](images/%s)' % (fname, fname))
                lines.append('')
            except Exception as e:
                fails.append(val)
                # **真的**保留原 URL（而不是只写日志）：verify 的「外部 http(s)
                # 图片链接」检查会据此把这次转换拦下。
                lines.append('![图片](%s)' % val)
                lines.append('')
                log('  img FAIL（保留原 URL，Verify 将拦截）: %r' % e)
        else:
            lines.append(val)
            lines.append('')
    return lines, fails


def main():
    args = [a for a in sys.argv[1:] if a != '--dry']
    dry = '--dry' in sys.argv
    if not args or not args[0].startswith(('http://', 'https://')):
        log('用法: python3 convert_toutiao.py <URL> [输出包目录] [--dry]')
        sys.exit(2)
    url = args[0]
    if len(args) > 1 and not args[1].startswith('http'):
        pkg_dir = os.path.abspath(args[1])
    else:
        ws = _common.workspace_root()
        base = os.path.join(ws, 'staging', 'converted', '网页')
        ts = datetime.datetime.now(tz=CST).strftime('%Y%m%d_%H%M%S')
        pkg_dir = os.path.join(base, '文章_%s_%d' % (ts, os.getpid()))
    webp2png = bool(_common.convert_defaults().get('webp_to_png', True))

    text, final, raw = get_page(url)
    if text is None:
        log('CONVERT_URL_FAIL 头条反爬壳页（动态 _$jsvmprt），静态获取不可行；'
            '请用浏览器打开原文或稍后重试: %s' % url)
        sys.exit(2)

    m_title = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)', text, re.I)
    if not m_title:
        m_title = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']', text, re.I)
    m_t = re.search(r'<title[^>]*>([^<]+)</title>', text, re.I)
    title = htmlmod.unescape(m_title.group(1)).strip() if m_title else (
        htmlmod.unescape(m_t.group(1)).strip() if m_t else '头条文章')
    title = re.sub(r'[_-]\s*(今日头条|头条)$', '', title).strip()
    m_pub = re.search(r'<meta[^>]+property=["\']article:published_time["\'][^>]+content=["\']([^"\']+)', text, re.I)
    published = m_pub.group(1)[:10] if m_pub else ''

    if dry:
        body = clean_body(text)
        evs = collect_events(body)
        log('[dry] title=%r final=%s 正文事件=%d（p/h=%d, img=%d）published=%s'
            % (title, final, len(evs), sum(1 for e in evs if e[0] != 'img'),
               sum(1 for e in evs if e[0] == 'img'), published))
        return 0

    os.makedirs(pkg_dir, exist_ok=True)
    with open(os.path.join(pkg_dir, 'source_page.html'), 'wb') as f:
        f.write(raw)

    body = clean_body(text)
    events = collect_events(body)
    if not events:
        log('CONVERT_URL_FAIL 页面无正文事件（结构变化？）：%s' % final)
        sys.exit(2)
    lines, _fails = render_body(events, os.path.join(pkg_dir, 'images'), webp2png, title)

    md_path = os.path.join(pkg_dir, title.replace('/', '_') + '.md')
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines).rstrip() + '\n')
    with open(os.path.join(pkg_dir, 'metadata.json'), 'w', encoding='utf-8') as f:
        json.dump({'title': title, 'url': url, 'final_url': final,
                   'platform': '网页', 'published': published}, f, ensure_ascii=False, indent=2)
    log('CONVERT_URL_OK %s' % pkg_dir)
    log('  title=%r 图=%d 失败=%d source=%s published=%s'
        % (title, n_img, len(fails), final, published))
    if fails:
        log('  WARNING 图片下载失败 %d 张（保留原 URL，Verify 将拦截）: %s'
            % (len(fails), fails[:3]))
    return 0


def _img_fetch(u, timeout=40):
    req = urllib.request.Request(u, headers={
        'User-Agent': UA_MOBILE, 'Referer': 'https://m.toutiao.com/'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.geturl()


if __name__ == '__main__':
    # 单篇转换墙钟上限（设置页「单篇转换超时」）：见 _common.run_guarded
    sys.exit(_common.run_guarded(main))
