#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通用网页 → Content Package（markitdown 封装，M1-A）

用法:
    python3 convert_url.py <URL> [输出包目录] [--dry]

行为（与微信/小红书转换器同构，A-④ 决策：统一产 `<标题>.md + images/`，不引入 content.md）：
    1. fetch 页面 → 存 source_page.html
    2. markitdown CLI 转 md（CLI 路径: 环境变量 MARKITDOWN > config/runtime.json > 默认）
    3. 解析 md 中 http(s) 图片 → 下载到包内 images/、改写为相对引用
    4. webp 按 pipeline.webp_to_png 决定是否转 png（同 xhs）
    5. 产出 <标题>.md + images/ + source_page.html 于 staging/converted/网页/<包>/

失败语义：抓取/转换失败 → 明确报错退出非 0（包保留可重试）；
个别图片下载失败 → 保留原 URL 并打印 FAIL（后续 Verify 将按外部链接拦截，不静默）。
"""
import datetime
import html as htmlmod
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from datetime import timezone, timedelta

CST = timezone(timedelta(hours=8))
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
IMG_RE = re.compile(r'!\[[^\]]*\]\(([^)\s]+)\)')
# 不在源码里写死某个人的安装路径：按 PATH 查找，找不到就给出明确报错。
DEFAULT_MARKITDOWN = shutil.which('markitdown') or 'markitdown'
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import _common  # noqa: E402


def log(msg):
    print(msg, flush=True)


def now_tag():
    return datetime.datetime.now(tz=CST).strftime('%Y%m%d_%H%M%S')


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.geturl()


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


def find_title(html_text):
    m = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)', html_text, re.I)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']', html_text, re.I)
    if m:
        return htmlmod.unescape(m.group(1)).strip()
    m = re.search(r'<title[^>]*>([^<]+)</title>', html_text, re.I)
    return htmlmod.unescape(m.group(1)).strip() if m else ''


def markitdown_bin():
    env = os.environ.get('MARKITDOWN')
    if env and os.path.exists(env):
        return env
    try:
        with open(os.path.join(_common.workspace_root(), 'config', 'runtime.json'), encoding='utf-8') as f:
            rt = json.load(f)
        cli = (rt.get('markitdown') or {}).get('cli')
        if cli and os.path.exists(cli):
            return cli
    except Exception:
        pass
    return DEFAULT_MARKITDOWN


def ext_for(url, data):
    path = urllib.request.urlparse(url).path or ''
    m = re.search(r'\.([a-zA-Z0-9]{2,5})$', path)
    guess = (m.group(1).lower() if m else '') or sniff(data)
    return {'jpeg': 'jpg'}.get(guess, guess if guess in ('png', 'jpg', 'gif', 'webp') else 'jpg')


def sips_to_png(src, dst):
    return os.system('sips -s format png "%s" --out "%s" >/dev/null 2>&1' % (src, dst)) == 0


def main():
    args = [a for a in sys.argv[1:] if a != '--dry']
    dry = '--dry' in sys.argv
    if not args or not args[0].startswith(('http://', 'https://')):
        log('用法: python3 convert_url.py <URL> [输出包目录] [--dry]')
        sys.exit(2)
    url = args[0]
    if len(args) > 1 and not args[1].startswith('http'):
        pkg_dir = os.path.abspath(args[1])
    else:
        defs = _common.convert_defaults()
        base = os.path.join(defs['workspace_root'], 'staging', 'converted', '网页')
        pkg_dir = os.path.join(base, '文章_%s_%d' % (now_tag(), os.getpid()))
    webp2png = _common.convert_defaults().get('webp_to_png', True)

    # 1) fetch + 存档
    try:
        raw, final_url = fetch(url)
    except Exception as e:
        log('CONVERT_URL_FAIL fetch: %r' % e)
        sys.exit(2)
    html_text = raw.decode('utf-8', 'ignore')
    title = find_title(html_text)
    if dry:
        log('[dry] url=%s' % final_url)
        log('[dry] title=%r' % title)
        return 0
    os.makedirs(pkg_dir, exist_ok=True)
    html_path = os.path.join(pkg_dir, 'source_page.html')
    with open(html_path, 'wb') as f:
        f.write(raw)

    # 2) markitdown
    bin_md = markitdown_bin()
    try:
        if not os.path.exists(bin_md) and shutil.which(bin_md) is None:
            raise RuntimeError(
                'markitdown CLI 不可用（%s）。仅「其它任意网页」需要它：'
                '微信/小红书/头条各有专用转换器。安装：uv tool install "markitdown[all]" '
                '或 pipx install markitdown；也可设环境变量 MARKITDOWN 指定绝对路径。' % bin_md)
        proc = subprocess.run([bin_md, html_path], capture_output=True, text=True, timeout=300)
    except Exception as e:
        log('CONVERT_URL_FAIL markitdown run: %r' % e)
        sys.exit(2)
    md = (proc.stdout or '').strip()
    if not md:
        log('CONVERT_URL_FAIL markitdown 无输出(rc=%s): %s' % (proc.returncode, (proc.stderr or '')[-800:]))
        sys.exit(2)
    m = re.match(r'^#\s+(.+)$', md, re.M)
    if not title and m:
        title = m.group(1).strip()
    if not title:
        title = '网页文章'
    title_safe = re.sub(r'[\\/:*?"<>|]', '_', title).strip() or '网页文章'
    md_path = os.path.join(pkg_dir, title_safe + '.md')

    # 3) 图片本地化
    img_dir = os.path.join(pkg_dir, 'images')
    os.makedirs(img_dir, exist_ok=True)
    refs = list(dict.fromkeys(r for r in IMG_RE.findall(md) if r.startswith('http://') or r.startswith('https://')))
    fails = []
    for i, ref in enumerate(refs, start=1):
        try:
            data, _ = fetch(ref, timeout=40)
            real = sniff(data)
            if real == 'webp' and webp2png:
                fname = 'image_%02d.png' % i
                tmp = os.path.join(img_dir, fname[:-4] + '.webp')
                with open(tmp, 'wb') as f:
                    f.write(data)
                if not sips_to_png(tmp, os.path.join(img_dir, fname)):
                    fname = 'image_%02d.webp' % i
                    os.replace(tmp, os.path.join(img_dir, fname))
                else:
                    os.remove(tmp)
            else:
                fname = 'image_%02d.%s' % (i, ext_for(ref, data))
                with open(os.path.join(img_dir, fname), 'wb') as f:
                    f.write(data)
            md = md.replace(ref, 'images/%s' % fname)
            log('  img %s -> images/%s (%dB)' % (i, fname, len(data)))
        except Exception as e:
            fails.append(ref)
            log('  img FAIL (保留原 URL): %r' % e)

    # 清理残余站内相对图片引用（如 ../_static/… 装饰图，无法本地化）；保留 http(失败待拦截)与已本地化 images/
    def _clean_img(m):
        ref = m.group(1)
        if ref.startswith('http://') or ref.startswith('https://') or ref.startswith('images/'):
            return m.group(0)
        return ''
    cleaned = IMG_RE.sub(_clean_img, md)
    if cleaned != md:
        log('  已移除站内相对图片引用（装饰/不可本地化）')
        md = cleaned

    # metadata.json：供 FORMAT 读取 title/url/platform（通用 md 无转换器式引用块；中间契约，非 frontmatter 字段）
    with open(os.path.join(pkg_dir, 'metadata.json'), 'w', encoding='utf-8') as f:
        json.dump({'title': title, 'url': url, 'platform': '网页', 'published': '',
                   'final_url': final_url}, f, ensure_ascii=False, indent=2)

    with open(md_path, 'w', encoding='utf-8') as f:
        f.write(md.rstrip() + '\n')
    log('CONVERT_URL_OK %s' % pkg_dir)
    log('  title=%r 图片=%d 失败=%d source=%s' % (title, len(refs), len(fails), final_url))
    if fails:
        log('  WARNING 图片下载失败 %d 张（保留外部链接，Verify 将拦截）：%s' % (len(fails), fails[:3]))
    return 0


if __name__ == '__main__':
    # 单篇转换墙钟上限（设置页「单篇转换超时」）：见 _common.run_guarded
    sys.exit(_common.run_guarded(main))
