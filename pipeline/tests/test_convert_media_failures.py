# -*- coding: utf-8 -*-
"""图片下载失败必须让整条链**看得见**（不能被静默吞掉后报告成功）。

复现的问题：头条转换器在图片下载失败时只打了一行「保留原 URL」的日志，实际上
把 `<img>` 从 Markdown 里丢掉了 —— 于是 verify 看不到任何外部链接、也没有缺失的
本地文件，整条链一路 PASS，最后入库的笔记缺图却「成功」。

这里守两件事：
  1. 三个会丢图的转换器（头条 / 小红书 / 微信分享页）在失败时**真的**保留原 URL；
  2. 产物一旦含外部图片链接，verify 判 FAIL、STORE 拒绝入库并保留整包。
"""
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _harness import REPO, TempWorkspace  # noqa: E402

CONVERT_DIR = REPO / 'pipeline' / 'scripts' / 'convert'
sys.path.insert(0, str(CONVERT_DIR))


class ToutiaoRenderTest(unittest.TestCase):
    def setUp(self):
        import convert_toutiao
        self.mod = convert_toutiao
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)
        self.img_dir = str(self.ws.tmp / 'images')

    def test_failed_image_keeps_original_url(self):
        events = [
            ('p', '第一段', 0),
            ('img', 'https://img.example.com/ok.png', 1),
            ('img', 'https://img.example.com/broken.png', 2),
        ]

        def fake_fetch(url):
            if 'broken' in url:
                raise OSError('模拟下载失败')
            return (b'\x89PNG\r\n\x1a\n' + b'\x00' * 8), url

        with mock.patch.object(self.mod, '_img_fetch', side_effect=fake_fetch):
            rendered = self.mod.render_body(events, self.img_dir, True, '测试标题')

        lines, fails = rendered['lines'], rendered['fails']
        text = '\n'.join(lines)
        self.assertIn('https://img.example.com/broken.png', text,
                      '失败图必须以原始 URL 留在 Markdown 里（供 verify 拦截）')
        self.assertEqual(fails, ['https://img.example.com/broken.png'])
        self.assertIn('images/', text, '成功的图仍然本地化')

    def test_all_images_ok_has_no_external_url(self):
        events = [('img', 'https://img.example.com/ok.png', 0)]

        def fake_fetch(url):
            return (b'\x89PNG\r\n\x1a\n' + b'\x00' * 8), url

        with mock.patch.object(self.mod, '_img_fetch', side_effect=fake_fetch):
            rendered = self.mod.render_body(events, self.img_dir, True, '测试标题')
        lines, fails = rendered['lines'], rendered['fails']
        text = '\n'.join(lines)
        self.assertEqual(fails, [])
        self.assertNotIn('https://', text, '全部成功时不应出现外部图片链接')


class XhsDownloadTest(unittest.TestCase):
    def test_failed_image_is_recorded_with_url(self):
        import xhs_convert
        ws = TempWorkspace()
        self.addCleanup(ws.cleanup)
        img_dir = str(ws.tmp / 'images')
        os.makedirs(img_dir, exist_ok=True)
        imgs = [{'urlDefault': 'https://sns.example.com/broken.jpg'}]

        with mock.patch.object(xhs_convert, 'fetch', side_effect=OSError('模拟失败')):
            out = xhs_convert.download_images(imgs, img_dir)
        self.assertEqual(out['failed'], [(1, 'https://sns.example.com/broken.jpg')])
        self.assertIsNone(out['results'][0][1], '失败项没有本地文件名')


class WechatShareDownloadTest(unittest.TestCase):
    def test_failed_image_row_keeps_url(self):
        import wechat_share_v3 as share
        ws = TempWorkspace()
        self.addCleanup(ws.cleanup)
        share.IMG_DIR = str(ws.tmp / 'images')
        os.makedirs(share.IMG_DIR, exist_ok=True)

        with mock.patch.object(share, 'fetch', side_effect=OSError('模拟失败')):
            ok, fail, rows = share.download_images(['https://mmbiz.example.com/broken.png'])
        self.assertEqual((ok, fail), (0, 1))
        self.assertEqual(len(rows), 1)
        status, fname, url = rows[0]
        self.assertIsNone(fname)
        self.assertEqual(url, 'https://mmbiz.example.com/broken.png')
        self.assertIn('保留原 URL', status)


class VerifyBlocksExternalImagesTest(unittest.TestCase):
    """整链保证：含外部图片链接的包 → verify FAIL → STORE 拒绝入库、整包保留。"""

    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)

    def test_external_image_fails_verify_and_store(self):
        pkg = self.ws.write_note_package(
            '缺图文章', 'https://mp.weixin.qq.com/s/imgfail',
            body='正常文字\n\n![图片](https://img.example.com/broken.png)\n')
        verify = self.ws.run_script('verify/verify_note.py', pkg)
        self.assertEqual(verify.returncode, 2, verify.stdout + verify.stderr)
        self.assertIn('外部 http(s) 图片链接', verify.stdout)
        self.assertIn('VERDICT FAIL', verify.stdout)

        store = self.ws.store(pkg, 'img-1')
        self.assertEqual(store.returncode, 2, store.stdout + store.stderr)
        self.assertTrue(pkg.is_dir(), 'verify 失败必须保留整包供重试')
        self.assertEqual(self.ws.notes(), [], '不允许把缺图笔记入进库')
        self.assertEqual(self.ws.ledger_records()[-1]['status'], 'error')


if __name__ == '__main__':
    unittest.main()
