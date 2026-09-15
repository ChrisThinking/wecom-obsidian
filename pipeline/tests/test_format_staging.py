# -*- coding: utf-8 -*-
"""FORMAT 暂存目录回归：同标题的文章不能互相覆盖。

复现的问题：FORMAT 以前固定写 `staging/formatted/<platform>/<name>`，并在写入前
`rmtree` 同名目录。两篇**同标题**文章（A 还没入库，B 就格式化了）会互相覆盖，
最后 A 的 STORE 实际把 B 的内容存进了库。

现在每次 FORMAT 落进一个本次运行独有的父目录，叶子仍是 `<name>`（STORE 用包
目录名作 note 名，不能带随机后缀）。这里端到端验证：A/B 并存 → 各自入库 →
库里两篇都在、内容各归各、path 快照与落点一致。
"""
import os
import re
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _harness import TempWorkspace  # noqa: E402

FORMAT_OK = re.compile(r'FORMAT_OK (\S+)')


def frontmatter_path(md_file):
    for line in md_file.read_text(encoding='utf-8').splitlines():
        if line.startswith('path:'):
            return line.split(':', 1)[1].strip().strip('"')
    return None


class FormatStagingIsolationTest(unittest.TestCase):
    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)

    def converted(self, slot, url, body):
        """造一个转换器风格的 Content Package（metadata.json + md）。"""
        pkg = self.ws.tmp / 'converted' / slot / '同名标题'
        pkg.mkdir(parents=True)
        (pkg / 'metadata.json').write_text(
            '{"title":"同名标题","url":"%s","platform":"微信","published":"2024-05-06"}\n' % url,
            encoding='utf-8')
        (pkg / '同名标题.md').write_text('# 同名标题\n\n%s\n' % body, encoding='utf-8')
        return pkg

    def run_format(self, pkg):
        proc = self.ws.format_note(pkg)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        m = FORMAT_OK.search(proc.stdout)
        self.assertIsNotNone(m, proc.stdout)
        return m.group(1)

    def test_same_title_packages_coexist_and_both_land(self):
        a = self.converted('A', 'https://mp.weixin.qq.com/s/AAA', 'A 的正文')
        b = self.converted('B', 'https://mp.weixin.qq.com/s/BBB', 'B 的正文')

        pkg_a = self.run_format(a)
        pkg_b = self.run_format(b)
        self.assertNotEqual(pkg_a, pkg_b, '同标题的两次 FORMAT 不能落到同一个目录')
        self.assertEqual(os.path.basename(pkg_a), '同名标题', '叶子目录必须仍是文章名')
        self.assertEqual(os.path.basename(pkg_b), '同名标题')
        # A 的包不能被 B 覆盖
        import pathlib
        self.assertIn('A 的正文', pathlib.Path(pkg_a, '同名标题.md').read_text(encoding='utf-8'))
        self.assertIn('B 的正文', pathlib.Path(pkg_b, '同名标题.md').read_text(encoding='utf-8'))

        # 先存 B 再存 A，模拟「A 的任务晚于 B 执行」
        self.assertEqual(self.ws.store(pkg_b, 'b1').returncode, 0)
        self.assertEqual(self.ws.store(pkg_a, 'a1').returncode, 0)

        notes = self.ws.notes()
        self.assertEqual(notes, [
            '01_文章分享/2026/09/同名标题-2/同名标题-2.md',
            '01_文章分享/2026/09/同名标题/同名标题.md',
        ])
        bodies = {}
        for rel in notes:
            text = (self.ws.vault / rel).read_text(encoding='utf-8')
            if 'A 的正文' in text:
                bodies['A'] = rel
            if 'B 的正文' in text:
                bodies['B'] = rel
        self.assertEqual(set(bodies), {'A', 'B'}, '两篇内容都要在库里，不能只剩一篇')
        # path 快照与各自的实际目录一致
        for rel in notes:
            md = self.ws.vault / rel
            snap = frontmatter_path(md)
            self.assertEqual((self.ws.vault / snap).resolve(), md.parent.resolve())

    def test_format_never_deletes_existing_converted_input(self):
        a = self.converted('A', 'https://mp.weixin.qq.com/s/AAA', 'A 的正文')
        self.run_format(a)
        self.run_format(a)
        self.assertTrue(a.is_dir(), 'FORMAT 不应删掉输入包')
        self.assertIn('A 的正文', (a / '同名标题.md').read_text(encoding='utf-8'))


if __name__ == '__main__':
    unittest.main()
