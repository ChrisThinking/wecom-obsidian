# -*- coding: utf-8 -*-
"""转换器**完整入口**回归（不是只测被抽出来的辅助函数）。

复现过的问题：`render_body()` 抽取之后，`convert_toutiao.main()` 仍引用已移走的
`n_img` / `fails`。因为成功标记在崩溃前打印，现象是
「stdout 出现 CONVERT_URL_OK，进程随即 NameError 退出」——只测辅助函数的用例
完全看不到。这里把网络 I/O 换成桩，直接跑 `main()`：

  · 正常文章：返回 0、打印成功标记、产物齐全（md / metadata.json / source_page.html）；
  · 图片失败：失败图以原始 URL 留在 md（供 verify 拦截），且仍然正常收尾；
  · `--dry`：只打印预检、不落盘。

（其余转换器的同类风险由 `test_undefined_names.py` 的未定义名字扫描覆盖。）
"""
import contextlib
import io
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _harness import REPO, TempWorkspace  # noqa: E402

CONVERT_DIR = REPO / 'pipeline' / 'scripts' / 'convert'
sys.path.insert(0, str(CONVERT_DIR))

PAGE = '''<html><head>
<meta property="og:title" content="测试头条文章"/>
<meta property="article:published_time" content="2024-05-06T10:00:00"/>
</head><body><article>
<p>第一段正文。</p>
<img src="https://img.example.com/ok.png"/>
<p>第二段正文。</p>
</article></body></html>'''


class ToutiaoEntryTest(unittest.TestCase):
    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)
        # main() 会读 config/pipeline.json（convert_defaults）→ 需要工作区根
        self._prev_root = os.environ.get('OBS_WS_ROOT')
        os.environ['OBS_WS_ROOT'] = str(self.ws.ws)
        self._prev_argv = list(sys.argv)
        import convert_toutiao
        self.mod = convert_toutiao
        self.addCleanup(self._restore)

    def _restore(self):
        if self._prev_root is None:
            os.environ.pop('OBS_WS_ROOT', None)
        else:
            os.environ['OBS_WS_ROOT'] = self._prev_root
        sys.argv = self._prev_argv

    def _run(self, pkg_dir, img_ok=True, dry=False):
        self.mod.get_page = lambda url: (PAGE, 'https://www.toutiao.com/article/123/', PAGE.encode())
        if img_ok:
            self.mod._img_fetch = lambda u, timeout=40: (b'\x89PNG\r\n\x1a\n' + b'\x00' * 8, u)
        else:
            def boom(u, timeout=40):
                raise OSError('模拟图片下载失败')
            self.mod._img_fetch = boom
        argv = ['convert_toutiao.py', 'https://www.toutiao.com/article/123/', str(pkg_dir)]
        if dry:
            argv.append('--dry')
        sys.argv = argv
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = self.mod.main()
        return rc, buf.getvalue()

    def test_full_entry_success_path_returns_cleanly(self):
        pkg = self.ws.tmp / 'out'
        rc, out = self._run(pkg)
        self.assertEqual(rc, 0, out)
        self.assertIn('CONVERT_URL_OK', out)
        self.assertIn('图=1', out, '摘要行必须打出图片数（重构后曾因引用已移走的变量而崩）')
        self.assertIn('失败=0', out)
        self.assertEqual(sorted(p.name for p in pkg.iterdir()),
                         ['images', 'metadata.json', 'source_page.html', '测试头条文章.md'])
        md = (pkg / '测试头条文章.md').read_text(encoding='utf-8')
        self.assertIn('images/', md)
        self.assertNotIn('https://img.example.com', md, '成功的图应本地化')
        meta = json.loads((pkg / 'metadata.json').read_text(encoding='utf-8'))
        self.assertEqual(meta['title'], '测试头条文章')
        self.assertEqual(meta['published'], '2024-05-06')

    def test_full_entry_image_failure_still_finishes_and_keeps_url(self):
        pkg = self.ws.tmp / 'out'
        rc, out = self._run(pkg, img_ok=False)
        self.assertEqual(rc, 0, '图片失败不应让转换器崩溃：%s' % out)
        self.assertIn('CONVERT_URL_OK', out)
        self.assertIn('失败=1', out)
        self.assertIn('WARNING 图片下载失败', out)
        md = (pkg / '测试头条文章.md').read_text(encoding='utf-8')
        self.assertIn('https://img.example.com/ok.png', md,
                      '失败图必须保留原 URL，交给 verify 拦截')

    def test_full_entry_dry_run(self):
        pkg = self.ws.tmp / 'out'
        rc, out = self._run(pkg, dry=True)
        self.assertEqual(rc, 0, out)
        self.assertIn('[dry]', out)
        self.assertFalse(pkg.exists(), '--dry 不应落盘')


if __name__ == '__main__':
    unittest.main()
