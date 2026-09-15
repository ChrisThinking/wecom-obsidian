#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""STORE 阶段（Workflow v1 / M1-B 定稿规则）：Note Package → Stored Asset。

用法:
    python3 store.py <note_pkg_dir> [--run-id <run_id>]

M1-B 定稿要点：
  - 目标布局：<vault>/01_文章分享/<年份(created)>/<月份>/<name>/（M1-B B4/B6）
    —— `store.folder_pattern` 已把 `{name}` 解析进最后一段，**这一层就是 note 目录本身**；
    实现上不得再在它下面追加一次文章名（历史缺陷：顶层/年/月/标题/标题/标题.md）。
  - path 为创建时相对目录快照：与 note 目录**逐字一致**（含同名冲突后缀场景）
  - 同名冲突 -2/-3（名称保护）或按 store.conflict_suffix 直接失败
  - 去重靠 url_key = canonicalize(frontmatter url)（ledger），且**要求账本指向的入库物仍存在**
  - 同一 url_key 的并发入库用文件锁串行化（避免两份 .part 争同一个目标目录）
  - STORE 不修改正文内容（Verify 内置把关，D17）

退出码：0=已入库；3=重复(URL 已 done 且入库物仍在)；2=失败(整包保留)。
vault 根：env OBS_VAULT_ROOT > config/obsidian.json(vault_root) > vault_test_root。
"""
import contextlib
import datetime
import hashlib
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


def stored_asset_exists(vault_path):
    """账本里的 `vault_path` 是否仍有实物。

    只信账本会让「用户删了/移走了笔记」永久无法重新入库（重复收藏直接丢弃整包）。
    所以 done 记录必须配一次存在性检查：
      - 目录形态：目录存在且**含至少一个 .md**（防「只建了空目录」的中间态）；
      - 文件形态（兼容旧记录）：文件存在。
    """
    if not vault_path:
        return False
    if os.path.isdir(vault_path):
        try:
            return any(name.lower().endswith('.md') for name in os.listdir(vault_path))
        except OSError:
            return False
    return os.path.isfile(vault_path)


@contextlib.contextmanager
def url_lock(url_key):
    """同一 url_key 的入库串行化。

    ACQUIRE 可能被并发触发（同一链接发两次 / 两条会话线），而 STORE 是
    「查账本 → 选目标 → 整包落位」的多步过程。没有锁时两个进程可能同时判定
    「不重复」，再各自 copytree 到同一个目标目录，最后只剩一份、另一份报错。

    `flock` 随进程退出自动释放，不会留下需要手工清理的陈旧锁文件。
    """
    lock_dir = os.path.join(os.path.dirname(wf.ledger_path()), 'locks')
    os.makedirs(lock_dir, exist_ok=True)
    digest = hashlib.sha1((url_key or 'no-url').encode('utf-8')).hexdigest()[:16]
    handle = open(os.path.join(lock_dir, digest + '.lock'), 'a+')
    try:
        try:
            import fcntl  # POSIX；Windows 下退化为「不串行」而不是报错
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        except ImportError:
            pass
        yield
    finally:
        try:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except ImportError:
            pass
        handle.close()


def resolve_target(vault, store_cfg, meta, base_name):
    """解析 note 目录的父目录与叶子名（不创建任何东西）。

    `folder_pattern` 是单点规则，且**默认已含 `{name}`**：解析结果就是要落地的
    note 目录本身。只有用户把 `{name}` 从规则里删掉时才补一段，保证
    「一篇一目录」的不变量（否则多篇文章会挤进同一个目录、互相覆盖）。

    @returns {(str, list, str)} `(parent_dir, parent_parts, leaf)`
    """
    rel_dir = wf.resolve_rel_dir(store_cfg, meta, base_name, meta.get('created', ''))
    pattern = str(store_cfg.get('folder_pattern') or '{top}/{YYYY}/{MM}/{name}')
    parts = [seg for seg in rel_dir.split('/') if seg]
    if '{name}' not in pattern:
        parts.append(base_name)
    if not parts:
        parts = [base_name]
    parent_parts = parts[:-1]
    parent_dir = os.path.join(vault, *parent_parts) if parent_parts else vault
    return parent_dir, parent_parts, parts[-1]


def store(pkg, run_id):
    main_md = wf.find_main_md(pkg)
    meta = wf.parse_frontmatter(main_md) if main_md else {}
    url_key = wf.canonicalize_url(meta.get('url', ''))

    # 整个「查账本 → 校验 → 落位 → 记账」在同 url_key 的锁里完成，
    # 账本判定必须在锁内重新读一次（锁外读到的状态可能已被并发方改写）。
    with url_lock(url_key):
        last = wf.ledger_last(url_key)
        if last and last.get('status') == 'done':
            if stored_asset_exists(last.get('vault_path')):
                shutil.rmtree(pkg, ignore_errors=True)
                print('STORE_SKIP_DUPLICATE %s (已入库: %s)' % (pkg, last.get('vault_path')))
                return 3
            # 账本说 done，但库里已经没有了（用户删除/移动/搬运到别的库）：
            # 不能凭一句历史记录就把这次收藏丢掉，改为重新入库并在账本留痕。
            wf.ledger_append(note_record(
                run_id, pkg, meta, 'error',
                error='dedup 记录指向的入库物已不存在，改为重新入库: %s' % last.get('vault_path')))
            print('STORE_REDO 账本 done 指向的入库物已不存在（%s），重新入库'
                  % last.get('vault_path'))

        rc, out = run_verify(pkg)
        if rc != 0:
            wf.ledger_append(note_record(run_id, pkg, meta, 'error', error='verify FAIL:\n' + out[-2000:]))
            print(out, end='')
            print('STORE_FAIL verify 未通过（包保留: %s）' % pkg)
            return 2

        # TARGET RESOLUTION（M1-B 布局：01_文章分享/<created年>[/<月份>]/<name>）
        vault = wf.vault_base()
        store_cfg = wf.load_obsidian().get('store') or {}
        base_name = wf.sanitize_name(os.path.basename(pkg))
        parent_dir, parent_parts, leaf = resolve_target(vault, store_cfg, meta, base_name)
        allow_suffix = wf.conflict_suffix(store_cfg)

        final_leaf = leaf
        final_dir = os.path.join(parent_dir, final_leaf)
        n = 2
        while os.path.exists(final_dir):
            if not allow_suffix:
                wf.ledger_append(note_record(
                    run_id, pkg, meta, 'error',
                    error='同名冲突且 store.conflict_suffix=false，未入库: %s' % final_dir,
                    vault_path=parent_dir))
                print('STORE_FAIL 同名冲突且「同名冲突自动加后缀」已关闭（包保留: %s）: %s'
                      % (pkg, final_dir))
                return 2
            final_leaf = '%s-%d' % (leaf, n)
            final_dir = os.path.join(parent_dir, final_leaf)
            n += 1

        rel_snapshot = '/'.join(parent_parts + [final_leaf])
        part = os.path.join(parent_dir, '%s.%s.%d.part' % (final_leaf, run_id, os.getpid()))
        try:
            os.makedirs(parent_dir, exist_ok=True)
            shutil.rmtree(part, ignore_errors=True)
            shutil.copytree(pkg, part)
            md0 = os.path.join(part, base_name + '.md')
            md1 = os.path.join(part, final_leaf + '.md')
            if base_name != final_leaf and os.path.isfile(md0):
                os.replace(md0, md1)
            # path 快照与最终位置逐字一致（含同名冲突后缀场景）
            rewrite_path_field(md1 if os.path.isfile(md1) else md0, rel_snapshot)
            os.replace(part, final_dir)
        except Exception as e:
            shutil.rmtree(part, ignore_errors=True)
            wf.ledger_append(note_record(run_id, pkg, meta, 'error', error='commit FAIL: %r' % e,
                                         vault_path=str(parent_dir)))
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
