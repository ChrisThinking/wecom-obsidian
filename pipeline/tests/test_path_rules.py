# -*- coding: utf-8 -*-
"""入库路径规则（`wf.resolve_rel_dir` / `store.resolve_target`）回归。

`pipeline/scripts/tests/test_path_rules.py` 这个名字在单测注释里被引用过，
但文件一直不存在（路径规则因此长期没有守护）。这里补上真正的守护：

  · FORMAT 写进 frontmatter 的 `path` 快照与 STORE 的落点必须由**同一个**解析器
    给出（`resolve_rel_dir`），规则里 `{top}/{platform}/{YYYY}/{MM}/{name}` 任一段
    改动都不能再让两边漂移；
  · `{name}` 是「一篇一目录」的保证：规则里没写它时，STORE 必须自己补一段，
    否则多篇文章会挤进同一个目录。
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _harness import REPO, TempWorkspace  # noqa: E402

sys.path.insert(0, str(REPO / 'pipeline' / 'scripts'))
import wf_common as wf  # noqa: E402
import importlib  # noqa: E402

store_mod = None


def _store_module(ws):
    """在临时工作区环境下导入 store.py（它在 import 时就要能解析工作区根）。"""
    global store_mod
    os.environ['OBS_WS_ROOT'] = str(ws.ws)
    os.environ['OBS_VAULT_ROOT'] = str(ws.vault)
    if store_mod is None:
        sys.path.insert(0, str(REPO / 'pipeline' / 'scripts' / 'manage'))
        store_mod = importlib.import_module('store')
    return store_mod


class ResolveRelDirTest(unittest.TestCase):
    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)
        os.environ['OBS_WS_ROOT'] = str(self.ws.ws)

    def resolve(self, pattern, url='https://mp.weixin.qq.com/s/x', created='2024-05-06T10:00:00',
                name='标题', top='01_文章分享'):
        cfg = {'folder_pattern': pattern, 'top_folder': top}
        return wf.resolve_rel_dir(cfg, {'url': url}, name, created)

    def test_default_pattern_resolves_to_note_dir_including_name(self):
        # 默认规则已经含 {name}：解析结果**就是** note 目录，不能再追加一次文章名。
        self.assertEqual(self.resolve('{top}/{YYYY}/{MM}/{name}'), '01_文章分享/2024/05/标题')

    def test_year_only_and_platform_patterns(self):
        self.assertEqual(self.resolve('{top}/{YYYY}/{name}'), '01_文章分享/2024/标题')
        self.assertEqual(
            self.resolve('{top}/{platform}/{YYYY}/{name}'),
            '01_文章分享/微信/2024/标题')
        self.assertEqual(
            self.resolve('{platform}/{YYYY}/{MM}/{name}'),
            '微信/2024/05/标题')

    def test_platform_map_and_default(self):
        self.assertEqual(
            wf.platform_dir_of({'url': 'https://xhslink.cn/o/abc'}),
            '小红书')
        self.assertEqual(
            wf.platform_dir_of({'url': 'https://example.com/post'}),
            '网页')

    def test_extra_slashes_and_dot_segments_are_dropped(self):
        self.assertEqual(self.resolve('{top}//{YYYY}/./{MM}/../{name}'), '01_文章分享/2024/05/标题')

    def test_created_variants(self):
        now = wf.now_cst()
        self.assertEqual(self.resolve('{top}/{YYYY}/{MM}/{name}', created='2024-04-01T00:00:00'),
                         '01_文章分享/2024/04/标题')
        # 只有年到月：月回落当前月
        self.assertEqual(self.resolve('{top}/{YYYY}/{MM}/{name}', created='2024-04'),
                         '01_文章分享/2024/%s/标题' % now.strftime('%m'))
        # 完全没有 created：年/月都回落当前
        self.assertEqual(self.resolve('{top}/{YYYY}/{MM}/{name}', created=''),
                         '01_文章分享/%s/%s/标题' % (now.strftime('%Y'), now.strftime('%m')))

    def test_top_folder_is_configurable(self):
        self.assertEqual(self.resolve('{top}/{YYYY}/{name}', top='99_Inbox'), '99_Inbox/2024/标题')


class SanitizeNameTest(unittest.TestCase):
    def test_illegal_chars_and_whitespace(self):
        self.assertEqual(wf.sanitize_name('a/b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i')
        self.assertEqual(wf.sanitize_name('  多余   空白  '), '多余 空白')
        self.assertEqual(wf.sanitize_name('尾部点与空格 . '), '尾部点与空格')

    def test_cap_and_fallback(self):
        self.assertEqual(len(wf.sanitize_name('长' * 300)), 120)
        self.assertEqual(wf.sanitize_name(''), '未命名')
        self.assertEqual(wf.sanitize_name('   '), '未命名')


class ResolveTargetTest(unittest.TestCase):
    """`store.resolve_target`：规则没写 {name} 时补一段，保证一篇一目录。"""

    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)
        self.store = _store_module(self.ws)

    def test_pattern_with_name_uses_leaf_as_note_dir(self):
        cfg = {'folder_pattern': '{top}/{YYYY}/{MM}/{name}', 'top_folder': '01_文章分享'}
        parent, parent_parts, leaf = self.store.resolve_target(
            str(self.ws.vault), cfg, {'url': 'https://mp.weixin.qq.com/s/x', 'created': '2024-05-06T10:00:00'}, '标题')
        self.assertEqual(leaf, '标题')
        self.assertEqual(parent_parts, ['01_文章分享', '2024', '05'])
        self.assertEqual(parent, os.path.join(str(self.ws.vault), '01_文章分享', '2024', '05'))

    def test_pattern_without_name_appends_name(self):
        cfg = {'folder_pattern': '{top}/{YYYY}/{MM}', 'top_folder': '01_文章分享'}
        parent, parent_parts, leaf = self.store.resolve_target(
            str(self.ws.vault), cfg, {'url': 'https://mp.weixin.qq.com/s/x', 'created': '2024-05-06T10:00:00'}, '标题')
        self.assertEqual(parent_parts, ['01_文章分享', '2024', '05'])
        self.assertEqual(leaf, '标题')


class ConflictSuffixConfigTest(unittest.TestCase):
    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)
        os.environ['OBS_WS_ROOT'] = str(self.ws.ws)

    def test_default_is_true_even_when_key_absent(self):
        self.assertTrue(wf.conflict_suffix({}))
        self.assertTrue(wf.conflict_suffix({'folder_pattern': '{top}/{name}'}))

    def test_explicit_false(self):
        self.assertFalse(wf.conflict_suffix({'conflict_suffix': False}))
        self.assertTrue(wf.conflict_suffix({'conflict_suffix': True}))


if __name__ == '__main__':
    unittest.main()
