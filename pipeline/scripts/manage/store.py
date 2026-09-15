#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""STORE 阶段（Workflow v1 / M1-B 定稿规则）：Note Package → Stored Asset。

用法:
    python3 store.py <note_pkg_dir> [--run-id <run_id>]

M1-B 定稿要点：
  - 目标布局：<vault>/01_文章分享/<年份(created)>/<name>/（M1-B B4/B6）
  - 同名冲突 -2/-3（名称保护）；去重靠 url_key = canonicalize(frontmatter url)（ledger）
  - path 为创建时相对目录快照：与目标一致；冲突后缀时在提交前修正 md 的 path 一行（仅 metadata 写入口，R5）
  - STORE 不修改正文内容（Verify 内置把关，D17）

退出码：0=已入库；3=重复(URL 已 done)；2=失败(整包保留)。
vault 根：env OBS_VAULT_ROOT > config/obsidian.json(vault_root) > vault_test_root。
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wf_common as wf

SCRIPTS = os.path.join(wf.root(), 'scripts')


def run_verify(pkg):
    proc = subprocess.run([sys.executable, os.path.join(SCRIPTS, 'verify', 'verify_note.py'), pkg],
                          capture_output=True, text=True)
    return proc.returncode, (proc.stdout or '') + (proc.stderr or '')


def store_top():
    obs = wf.load_obsidian().get('store') or {}
    return obs.get('top_folder') or '01_文章分享'


def rewrite_path_field(md_path, new_rel):
    """提交前把 frontmatter 的 path 修正为实际相对路径（仅 metadata 一行，属创建时快照写入口 R5）。"""
    try:
        with open(md_path, encoding='utf-8') as f:
            lines = f.read().splitlines()
    except Exception:
        return
    idx = next((i for i, ln in enumerate(lines) if ln.startswith('path:')), None)
    if idx is not None:
        lines[idx] = 'path: "%s"' % new_rel
        with open(md_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')


def note_record(run_id, pkg, meta, status, error=None, vault_path=None):
    return {
        'run_id': run_id,
        'url_key': wf.canonicalize_url(meta.get('url', '')),
        'status': status,
        'source': meta.get('platform', ''),
        'package': os.path.basename(pkg),
        'vault_path': vault_path or '',
        'collected_at': '',
        'updated_at': wf.now_cst().strftime('%Y-%m-%d %H:%M:%S %Z'),
        'error': error,
    }


def store(pkg, run_id):
    main_md = wf.find_main_md(pkg)
    meta = wf.parse_frontmatter(main_md) if main_md else {}
    url_key = wf.canonicalize_url(meta.get('url', ''))
    last = wf.ledger_last(url_key)
    if last and last.get('status') == 'done':
        shutil.rmtree(pkg, ignore_errors=True)
        print('STORE_SKIP_DUPLICATE %s (已入库: %s)' % (pkg, last.get('vault_path')))
        return 3

    rc, out = run_verify(pkg)
    if rc != 0:
        wf.ledger_append(note_record(run_id, pkg, meta, 'error', error='verify FAIL:\n' + out[-2000:]))
        print(out, end='')
        print('STORE_FAIL verify 未通过（包保留: %s）' % pkg)
        return 2

    # TARGET RESOLUTION（M1-B 布局：01_文章分享/<created年>[/<月份>]/<name>）
    vault = wf.vault_base()
    # 目标目录由 store.folder_pattern 单点解析（{top}/{YYYY}/{MM}/{platform}/{name}）。
    # vault 是**库根**：相对目录直接以它为基准拼。
    base_name = wf.sanitize_name(os.path.basename(pkg))
    rel_dir = wf.resolve_rel_dir(wf.load_obsidian().get('store') or {}, meta, base_name,
                                 meta.get('created', ''))
    base_dir = os.path.join(vault, *rel_dir.split('/'))
    part = os.path.join(base_dir, base_name + '.%s.part' % run_id)
    try:
        os.makedirs(base_dir, exist_ok=True)
        final_dir = os.path.join(base_dir, base_name)
        n = 2
        while os.path.exists(final_dir):
            final_dir = os.path.join(base_dir, '%s-%d' % (base_name, n))
            n += 1
        final_name = os.path.basename(final_dir)
        shutil.rmtree(part, ignore_errors=True)
        shutil.copytree(pkg, part)
        md0 = os.path.join(part, base_name + '.md')
        md1 = os.path.join(part, final_name + '.md')
        if base_name != final_name and os.path.isfile(md0):
            os.replace(md0, md1)
        # path 快照与最终位置一致（含同名冲突后缀场景）
        parent_rel = '/'.join(rel_dir.split('/')[:-1])
        rel_snapshot = '%s/%s' % (parent_rel, final_name) if parent_rel else final_name
        rewrite_path_field(md1 if os.path.isfile(md1) else md0, rel_snapshot)
        os.replace(part, final_dir)
    except Exception as e:
        shutil.rmtree(part, ignore_errors=True)
        wf.ledger_append(note_record(run_id, pkg, meta, 'error', error='commit FAIL: %r' % e,
                                     vault_path=str(base_dir)))
        print('STORE_FAIL commit 失败（包保留: %s）: %r' % (pkg, e))
        return 2

    rec = note_record(run_id, pkg, meta, 'done', vault_path=final_dir)
    wf.ledger_append(rec)
    shutil.rmtree(pkg, ignore_errors=True)
    print('STORE_OK %s' % final_dir)
    print('  url_key=%s' % url_key)
    return 0


def main():
    if len(sys.argv) < 2:
        print('用法: python3 store.py <note_pkg_dir> [--run-id <id>]', file=sys.stderr)
        sys.exit(2)
    pkg = os.path.abspath(sys.argv[1])
    run_id = sys.argv[sys.argv.index('--run-id') + 1] if '--run-id' in sys.argv \
        else wf.now_cst().strftime('run-%Y%m%d-%H%M%S')
    sys.exit(store(pkg, run_id))


if __name__ == '__main__':
    main()
