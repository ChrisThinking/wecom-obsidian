#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""VERIFY 阶段（Workflow v1，Store 内置把关，D17）：Note Package 确定性检查。

用法:
    python3 verify_note.py <note_pkg_dir>

结果：PASS / WARNING（均允许 Store）→ exit 0；FAIL → exit 2。
检查项：MD 存在且非空；frontmatter 存在且必填字段完整；本地图片引用存在；
无外部 http(s) 图片链接（FAIL）；assets 与包关系；文件名/路径合法。
"""
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wf_common as wf

IMG_RE = re.compile(r'!\[[^\]]*\]\(([^)\s]+)\)')
REQUIRED = ('title', 'url', 'type', 'created')  # M1-B schema；status 不校验（ledger 状态分离）


def verify(pkg):
    issues = []      # FAIL
    warns = []       # WARNING
    passes = []

    if not os.path.isdir(pkg):
        return issues, warns, passes, ['包目录不存在: %s' % pkg]
    main_md = wf.find_main_md(pkg)
    if not main_md:
        issues.append('未找到主 md')
        return issues, warns, passes, issues
    if os.path.getsize(main_md) == 0:
        issues.append('MD 为空')
    else:
        passes.append('MD 存在且非空: %s' % os.path.basename(main_md))

    text = open(main_md, encoding='utf-8').read()
    meta = wf.parse_frontmatter(main_md)
    if not meta:
        issues.append('缺少 frontmatter')
    else:
        missing = [k for k in REQUIRED if not meta.get(k)]
        if missing:
            issues.append('frontmatter 必填字段缺失: %s' % ','.join(missing))
        else:
            passes.append('frontmatter 完整(%s)' % ','.join(REQUIRED))

    # M2：schema 漂移守卫（WARNING，不 FAIL）
    _schema = (wf.load_obsidian().get('frontmatter') or {}).get('schema') or {}
    if meta and _schema:
        extra = [k for k in meta if k not in _schema]
        if extra:
            warns.append('frontmatter 含 schema 外字段: %s（Obs schema 键: %s%s）' % (
                ','.join(sorted(extra))[:80], ','.join(list(_schema)[:12]),
                '…' if len(_schema) > 12 else ''))

    # 文件名/包名合法性
    base = os.path.basename(pkg)
    if re.search(r'[\\/:*?"<>|]', base):
        issues.append('包名含非法字符: %s' % base)
    else:
        passes.append('包名合法: %s' % base)

    refs = IMG_RE.findall(text)
    ext_refs = [r for r in refs if r.startswith('http://') or r.startswith('https://')]
    if ext_refs:
        issues.append('存在外部 http(s) 图片链接(违禁): %s' % ext_refs[:5])
    local_refs = [r for r in refs if not (r.startswith('http://') or r.startswith('https://'))]
    # 资产目录名跟随配置（store.assets_dir），不再写死 assets。
    assets_name = wf.assets_dir_name()
    missing_refs = []
    odd_refs = []
    for r in local_refs:
        rel = r.split('#')[0].split('?')[0]
        rel = re.sub(r'^\./', '', rel)
        fp = os.path.join(pkg, rel)
        if not rel.startswith(assets_name + '/'):
            odd_refs.append(rel)
        elif not os.path.isfile(fp):
            missing_refs.append(rel)
    if odd_refs:
        warns.append('引用未走 %s/ 前缀（FORMAT 后不应出现）: %s' % (assets_name, odd_refs[:5]))
    if missing_refs:
        issues.append('本地图片引用缺失: %s' % missing_refs[:5])
    if local_refs and not missing_refs:
        passes.append('本地图片引用 %d 个全部存在' % len(local_refs))

    asset_dir = os.path.join(pkg, assets_name)
    if os.path.isdir(asset_dir):
        passes.append('%s/ 存在（随包，无跨文章共享）' % assets_name)
    elif not local_refs:
        warns.append('无图片引用且无 %s/（纯文本包，可接受）' % assets_name)
    else:
        issues.append('有图片引用但缺少 %s/' % assets_name)

    return issues, warns, passes, []


def main():
    if len(sys.argv) < 2:
        print('用法: python3 verify_note.py <note_pkg_dir>', file=sys.stderr)
        sys.exit(2)
    pkg = os.path.abspath(sys.argv[1])
    issues, warns, passes, hard = verify(pkg)
    for s in passes:
        print('[PASS]', s)
    for s in warns:
        print('[WARNING]', s)
    for s in issues:
        print('[FAIL]', s)
    if issues:
        print('VERDICT FAIL')
        sys.exit(2)
    print('VERDICT ' + ('WARNING' if warns else 'PASS'))
    sys.exit(0)


if __name__ == '__main__':
    main()
