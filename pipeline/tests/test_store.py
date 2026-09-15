# -*- coding: utf-8 -*-
"""STORE 端到端回归（临时 workspace + 临时 vault，跑真实 store.py 子进程）。

守的是这几条**静默出错**的契约：
  · 落点是 `顶层/年/月/标题/标题.md`，不是多叠一层文章名的 `…/标题/标题/标题.md`；
  · frontmatter 的 `path` 快照与 note 目录**逐字一致**（含同名冲突后缀）；
  · `store.conflict_suffix=false` 时同名直接失败并保留整包（设置页承诺的行为）；
  · 去重只在「账本 done **且** 入库物仍存在」时跳过，否则重新入库；
  · 同一 url_key 并发入库只落一份，且不留下 `.part`。
"""
import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _harness import TempWorkspace  # noqa: E402


def frontmatter_path(md_file):
    for line in md_file.read_text(encoding='utf-8').splitlines():
        if line.startswith('path:'):
            return line.split(':', 1)[1].strip().strip('"')
    return None


class StoreLayoutTest(unittest.TestCase):
    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)

    def test_default_layout_is_top_year_month_title(self):
        pkg = self.ws.write_note_package('测试文章', 'https://mp.weixin.qq.com/s/abc123')
        proc = self.ws.store(pkg)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(self.ws.notes(), ['01_文章分享/2024/05/测试文章/测试文章.md'])
        # 反向断言：不能出现「文章名再叠一层」
        self.assertFalse((self.ws.vault / '01_文章分享/2024/05/测试文章/测试文章').exists())

    def test_path_snapshot_matches_note_dir(self):
        pkg = self.ws.write_note_package('快照校验', 'https://example.com/snap')
        self.assertEqual(self.ws.store(pkg).returncode, 0)
        md = self.ws.vault / '01_文章分享/2024/05/快照校验/快照校验.md'
        self.assertTrue(md.is_file())
        snapshot = frontmatter_path(md)
        self.assertEqual(snapshot, '01_文章分享/2024/05/快照校验')
        self.assertEqual((self.ws.vault / snapshot).resolve(), md.parent.resolve())

    def test_conflict_suffix_and_snapshot(self):
        first = self.ws.write_note_package('同名文章', 'https://example.com/a1', slot='p1')
        second = self.ws.write_note_package('同名文章', 'https://example.com/a2', slot='p2')
        self.assertEqual(self.ws.store(first, 'c1').returncode, 0)
        self.assertEqual(self.ws.store(second, 'c2').returncode, 0)
        # 规则的最后一段就是 note 目录名，冲突后缀落在它上面；md 与目录仍然同名。
        self.assertEqual(self.ws.notes(), [
            '01_文章分享/2024/05/同名文章-2/同名文章-2.md',
            '01_文章分享/2024/05/同名文章/同名文章.md',
        ])
        md2 = self.ws.vault / '01_文章分享/2024/05/同名文章-2/同名文章-2.md'
        self.assertEqual(frontmatter_path(md2), '01_文章分享/2024/05/同名文章-2')
        self.assertEqual((self.ws.vault / frontmatter_path(md2)).resolve(), md2.parent.resolve())
        md1 = self.ws.vault / '01_文章分享/2024/05/同名文章/同名文章.md'
        self.assertEqual(frontmatter_path(md1), '01_文章分享/2024/05/同名文章')
        self.assertEqual((self.ws.vault / frontmatter_path(md1)).resolve(), md1.parent.resolve())

    def test_conflict_suffix_disabled_fails_and_keeps_package(self):
        ws = TempWorkspace(obsidian={'store': {'conflict_suffix': False}})
        self.addCleanup(ws.cleanup)
        first = ws.write_note_package('同名文章', 'https://example.com/b1', slot='p1')
        second = ws.write_note_package('同名文章', 'https://example.com/b2', slot='p2')
        self.assertEqual(ws.store(first, 'd1').returncode, 0)
        proc = ws.store(second, 'd2')
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertIn('同名冲突', proc.stdout)
        self.assertTrue(second.is_dir(), '失败时整包必须保留，供用户处置')
        self.assertEqual(ws.notes(), ['01_文章分享/2024/05/同名文章/同名文章.md'])
        self.assertEqual(ws.ledger_records()[-1]['status'], 'error')

    def test_pattern_without_name_still_one_dir_per_note(self):
        ws = TempWorkspace(obsidian={'store': {'folder_pattern': '{top}/{YYYY}/{MM}'}})
        self.addCleanup(ws.cleanup)
        pkg = ws.write_note_package('无名字段', 'https://example.com/c1')
        self.assertEqual(ws.store(pkg).returncode, 0)
        self.assertEqual(ws.notes(), ['01_文章分享/2024/05/无名字段/无名字段.md'])
        md = ws.vault / '01_文章分享/2024/05/无名字段/无名字段.md'
        self.assertEqual(frontmatter_path(md), '01_文章分享/2024/05/无名字段')

    def test_platform_placeholder_pattern(self):
        ws = TempWorkspace(obsidian={'store': {'folder_pattern': '{top}/{platform}/{YYYY}/{name}'}})
        self.addCleanup(ws.cleanup)
        pkg = ws.write_note_package('平台目录', 'https://mp.weixin.qq.com/s/pf1')
        self.assertEqual(ws.store(pkg).returncode, 0)
        self.assertEqual(ws.notes(), ['01_文章分享/微信/2024/平台目录/平台目录.md'])


class StoreDedupTest(unittest.TestCase):
    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)

    def test_duplicate_skips_and_cleans_package(self):
        url = 'https://mp.weixin.qq.com/s/dup'
        first = self.ws.write_note_package('去重', url, slot='p1')
        second = self.ws.write_note_package('去重', url, slot='p2')
        self.assertEqual(self.ws.store(first, 'e1').returncode, 0)
        proc = self.ws.store(second, 'e2')
        self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
        self.assertIn('STORE_SKIP_DUPLICATE', proc.stdout)
        self.assertFalse(second.exists(), '重复包应被清理')
        self.assertEqual(len(self.ws.notes()), 1)

    def test_duplicate_with_missing_vault_asset_reimports(self):
        """账本说 done，但笔记已不在库里 → 必须重新入库，而不是把新包删掉。"""
        url = 'https://mp.weixin.qq.com/s/redo'
        first = self.ws.write_note_package('重新入库', url)
        self.assertEqual(self.ws.store(first, 'f1').returncode, 0)
        note_dir = self.ws.vault / '01_文章分享/2024/05/重新入库'
        import shutil
        shutil.rmtree(note_dir)
        self.assertEqual(self.ws.notes(), [])
        second = self.ws.write_note_package('重新入库', url, slot='p2')
        proc = self.ws.store(second, 'f2')
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('STORE_REDO', proc.stdout)
        self.assertEqual(self.ws.notes(), ['01_文章分享/2024/05/重新入库/重新入库.md'])
        self.assertFalse(second.exists())
        self.assertEqual(self.ws.ledger_records()[-1]['status'], 'done')

    def test_ledger_records_error_then_retry_succeeds(self):
        url = 'https://example.com/retry'
        bad = self.ws.write_note_package_with_missing_image('失败重试', url)
        proc = self.ws.store(bad, 'g1')
        self.assertEqual(proc.returncode, 2, proc.stdout + proc.stderr)
        self.assertTrue(bad.is_dir(), 'verify 失败必须整包保留')
        self.assertEqual(self.ws.notes(), [])
        self.assertEqual(self.ws.ledger_records()[-1]['status'], 'error')
        # 修好缺失图片后重试：应当成功，且不因上一次 error 被误判为重复
        (bad / 'assets' / 'missing.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        proc2 = self.ws.store(bad, 'g2')
        self.assertEqual(proc2.returncode, 0, proc2.stdout + proc2.stderr)
        self.assertEqual(self.ws.notes(), ['01_文章分享/2024/05/失败重试/失败重试.md'])

    def test_concurrent_same_url_single_import(self):
        """同一 url_key 两个进程同时入库：只落一份，另一份判重，且无 .part 残留。"""
        url = 'https://mp.weixin.qq.com/s/concurrent'
        pkg_a = self.ws.write_note_package('并发', url, slot='p1')
        pkg_b = self.ws.write_note_package('并发', url, slot='p2')

        cmd = [sys.executable, str(self.ws.ws / 'scripts' / 'manage' / 'store.py')]
        env = self.ws.env()
        procs = [
            subprocess.Popen(cmd + [str(pkg_a), '--run-id', 'h1'],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env),
            subprocess.Popen(cmd + [str(pkg_b), '--run-id', 'h2'],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env),
        ]
        results = [p.communicate(timeout=120) for p in procs]
        codes = sorted(p.returncode for p in procs)
        self.assertEqual(codes, [0, 3], '并发结果必须是「一份成功 + 一份判重」：%r' % (results,))
        self.assertEqual(self.ws.notes(), ['01_文章分享/2024/05/并发/并发.md'])
        self.assertEqual(len(self.ws.ledger_records()), 1)
        self.assertEqual(self.ws.ledger_records()[0]['status'], 'done')
        leftovers = [p.as_posix() for p in self.ws.vault.rglob('*.part')]
        self.assertEqual(leftovers, [], '不允许留下 .part 半成品')


if __name__ == '__main__':
    unittest.main()
