#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FORMAT 阶段（Workflow v1 / M1-B 定稿规则）：Content Package → Note Package。

用法:
    python3 format_note.py <converted_pkg_dir> [--out <formatted_base>]

M1-B 定稿要点（见 docs/M1_B_定稿规则集.md / rule_src/）：
  - frontmatter: title/type(web_article)/url/author/platform/published/created/path/read/tags[]
    （无 status、无 source/source_url/collected_at；流程状态在 ledger）
  - 正文：顶部保留 `# <标题>`（H1）；不保留原文链接题注；无固定备注区
  - 命名：name = 纯标题（清洗）；包目录与 md 同名
  - path = 创建时相对目录快照 `01_文章分享/<created年>/<name>`
  - 元数据来源优先级：包内 metadata.json > 转换器 md 引用块 > md 首 H1
"""
import datetime
import json
import os
import re
import shutil
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.dirname(_HERE))  # scripts/
import wf_common as wf

META_QUOTE = re.compile(r'^>\s*\*\*(.+?)\*\*\s*[:：]?\s*(.*)$')
KEY_ALIAS = {'公众号': 'author', '作者': 'author', '原文链接': 'url',
             '发布时间': 'published_raw', '来源': 'source_hint'}


def pick_platform(url, hint=''):
    h = (hint or '').lower()
    u = (url or '').lower()
    if '小红书' in h or 'xiaohongshu' in u or 'xhslink' in u:
        return '小红书'
    if '微信' in h or 'mp.weixin.qq.com' in u:
        return '微信'
    return '网页'


def extract_content(md_path, meta):
    with open(md_path, encoding='utf-8') as f:
        lines = f.read().splitlines()
    title = ''
    i = 0
    if lines and re.match(r'^#\s+\S', lines[0]):
        title = re.sub(r'^#\s+', '', lines[0]).strip()
        i = 1
    while i < len(lines):
        ln = lines[i]
        if ln.strip() == '' or ln.strip() == '---' or ln.startswith('> '):
            m = META_QUOTE.match(ln)
            if m and m.group(1).strip() in KEY_ALIAS:
                meta[KEY_ALIAS[m.group(1).strip()]] = m.group(2).strip()
            i += 1
            continue
        break
    body = '\n'.join(lines[i:]).strip()
    return title, body


def parse_published(raw):
    m = re.match(r'(\d{4}-\d{2}-\d{2})', raw or '')
    return m.group(1) if m else ''


def build_note(meta, created, body):
    def q(v):
        return '"%s"' % str(v or '').replace('"', '\\"')

    out = ['---']
    out.append('title: %s' % q(meta['title']))
    out.append('type: web_article')
    out.append('url: %s' % q(meta['url']))
    out.append('author: %s' % q(meta.get('author', '')))
    out.append('platform: %s' % q(meta['platform']))
    pub = meta.get('published') or ''
    out.append('published: %s' % (q(pub) if not pub else pub))
    out.append('created: %s' % created)
    out.append('path: %s' % q(meta['path']))
    out.append('read: false')
    out.append('tags: []')
    out.append('---')
    out.append('')
    out.append('# %s' % meta['title'])   # H1（M1-B A6=B）
    out.append('')
    if body:
        out.append(body)
    return '\n'.join(out).rstrip() + '\n'


def build_note_v2(schema, meta, created, body):
    """M2：按 config/obsidian.json frontmatter.schema（字段序=Obs 模板）生成 frontmatter。
    无 schema 时回退 build_note（兼容）。"""
    if not schema:
        return build_note(meta, created, body)
    meta = dict(meta)
    meta['created'] = created

    def line(name, sf):
        t = (sf or {}).get('type')
        if t == 'const':
            return '%s: %s' % (name, sf.get('default'))
        if t == 'bool':
            default = sf.get('default', False)
            return '%s: %s' % (name, 'true' if default else 'false')
        if t == 'array':
            return '%s: []' % name
        v = meta.get('author', '') if name == 'author/ID' else (meta.get(name) or '')
        v = '' if v is None else str(v)
        if name in ('published', 'created'):
            return '%s: %s' % (name, ('""' if not v else v))
        return '%s: "%s"' % (name, str(v).replace('"', '\\"'))

    out = ['---']
    for name in schema:
        out.append(line(name, schema.get(name)))
    out.append('---')
    out.append('')
    out.append('# %s' % (meta.get('title') or ''))
    out.append('')
    if body:
        out.append(body)
    return '\n'.join(out).rstrip() + '\n'


def main():
    if len(sys.argv) < 2:
        print('用法: python3 format_note.py <converted_pkg_dir> [--out <formatted_base>]', file=sys.stderr)
        sys.exit(2)
    pkg = os.path.abspath(sys.argv[1])
    out_base = os.path.abspath(sys.argv[sys.argv.index('--out') + 1]) if '--out' in sys.argv \
        else os.path.join(wf.root(), 'staging', 'formatted')

    main_md = wf.find_main_md(pkg)
    if not main_md:
        print('FORMAT_FAIL 未找到主 md: %s' % pkg)
        sys.exit(2)
    meta = {'author': '', 'url': '', 'published_raw': '', 'source_hint': ''}
    title, body = extract_content(main_md, meta)

    # 通用转换器：优先读包内 metadata.json（title/url/platform/published）
    meta_json = {}
    meta_path = os.path.join(pkg, 'metadata.json')
    if os.path.isfile(meta_path):
        try:
            with open(meta_path, encoding='utf-8') as f:
                meta_json = json.load(f) or {}
        except Exception:
            meta_json = {}
    if isinstance(meta_json, dict) and meta_json:
        if not meta.get('url'):
            meta['url'] = str(meta_json.get('url') or meta_json.get('source_url') or '')
        if not title:
            title = str(meta_json.get('title') or '')
        if meta_json.get('platform'):
            meta['source_hint'] = str(meta_json['platform'])
        if meta_json.get('published') and not meta.get('published_raw'):
            meta['published_raw'] = str(meta_json['published'])

    url = re.sub(r'^<|>$', '', (meta.get('url') or '').strip())
    meta['url'] = url
    meta['platform'] = pick_platform(url, meta.get('source_hint'))
    meta['published'] = parse_published(meta.get('published_raw'))
    if not title:
        title = os.path.basename(pkg.rstrip('/'))
    meta['title'] = title

    created = wf.now_cst().strftime('%Y-%m-%dT%H:%M:%S')
    name = wf.sanitize_name(title)
    out_pkg = os.path.join(out_base, meta['platform'], name)
    if os.path.isdir(out_pkg):
        shutil.rmtree(out_pkg)
    os.makedirs(out_pkg)
    # path = Note 元数据快照，必须与 STORE 的落点**完全一致**。
    #
    # 两边共用同一条规则：`store.folder_pattern`（占位符
    # {top}/{YYYY}/{MM}/{platform}/{name}）。早期这里只判断「有没有 MM」，
    # 于是 pattern 里写 {platform} 时快照与落点会不一致 —— 现在统一走 wf 的解析。
    meta['path'] = wf.resolve_rel_dir(wf.load_obsidian().get('store') or {}, meta, name, created)

    src_asset = wf.find_asset_dir(pkg)
    if src_asset and os.path.isdir(src_asset):
        # 资产目录名由 `store.assets_dir` 决定（默认 assets），不再写死。
        _assets = wf.assets_dir_name()
        shutil.copytree(src_asset, os.path.join(out_pkg, _assets))
        body = body.replace('](images/', '](%s/' % _assets).replace('(images/', '(%s/' % _assets)
    src_page = os.path.join(pkg, 'source_page.html')
    if os.path.isfile(src_page):
        shutil.copy2(src_page, os.path.join(out_pkg, 'source_page.html'))

    md_path = os.path.join(out_pkg, name + '.md')
    _schema = (wf.load_obsidian().get('frontmatter') or {}).get('schema') or {}
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write(build_note_v2(_schema, meta, created, body))
    print('FORMAT_OK %s' % out_pkg)
    print('  name=%s platform=%s url=%s published=%s' % (name, meta['platform'], url, meta['published']))


if __name__ == '__main__':
    main()
