# -*- coding: utf-8 -*-
"""小红书转换器：页面改版 + 登录墙 回归（2026-09）。

复现的问题：桌面 UA 请求笔记短链被 302 到 `/login?redirectPath=…`，登录墙页面的
`__INITIAL_STATE__` 里没有 `noteDetailMap`，于是 `xhs_convert.main()` 报
「noteDetailMap 为空，未能取到笔记数据」——三次重试（含带 xsec_token 的直链）
结果一致，收藏整条失败。改用移动端 UA 能拿到分享页，但那代页面的笔记在
`noteData.data.noteData`，图片字段是 `url` / `infoList[].url`（不是 `urlDefault`），
所以「只换 UA」照样解析不出正文或丢图。

这里守四件事：
  1. 两代页面结构都能解析（新 `noteData.data.noteData` / 旧 `note.noteDetailMap`）；
  2. 登录墙必须被判为失败并换下一个 UA，而不是把空状态当成正文继续；
  3. 图片地址兼容 `urlDefault` / `url` / `infoList[].url`；
  4. 完整入口（`main()`）在新结构页面下真的产出 md + 本地图片。
"""
import contextlib
import io
import json
import os
import sys
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _harness import REPO, TempWorkspace  # noqa: E402

CONVERT_DIR = REPO / 'pipeline' / 'scripts' / 'convert'
sys.path.insert(0, str(CONVERT_DIR))

NOTE_URL = 'https://www.xiaohongshu.com/discovery/item/6aace1cd000000000b00c3b4?xsec_source=app_share'
LOGIN_URL = 'https://www.xiaohongshu.com/login?redirectPath=http%3A%2F%2Fwww.xiaohongshu.com%2Fdiscovery%2Fitem%2Fx'

#: 2026-09 起的分享页结构（移动端 UA 可得）
NEW_STATE = {
    'noteData': {'data': {'noteData': {
        'noteId': '6aace1cd000000000b00c3b4',
        'title': '新结构标题',
        'desc': '新结构正文第一段\n\n新结构正文第二段',
        'time': 1789804824000,
        'type': 'normal',
        'user': {'nickName': '刘颖'},
        'tagList': [{'name': 'CSP'}, {'name': ''}],
        'imageList': [
            {'url': 'https://sns.example.com/a.jpg',
             'infoList': [{'url': 'https://sns.example.com/a_h5.jpg'}]},
            {'urlDefault': 'https://sns.example.com/b.jpg'},
            {'infoList': [{'url': 'https://sns.example.com/c.jpg'}]},
        ],
    }}},
}

#: 旧版桌面页结构（登录态）
OLD_STATE = {
    'note': {'currentNoteId': 'n1', 'noteDetailMap': {'n1': {'note': {
        'title': '旧结构标题',
        'desc': '旧结构正文',
        'time': 1700000000000,
        'user': {'nickname': '旧作者'},
        'imageList': [{'urlDefault': 'https://sns.example.com/old.jpg'}],
    }}}},
}

#: 登录墙页面：有 __INITIAL_STATE__，但没有笔记数据
WALL_STATE = {'note': {'currentNoteId': '', 'noteDetailMap': {}}, 'global': {'a': 1}}

PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 8


def page(state):
    return ('<html><script>window.__INITIAL_STATE__=%s</script></html>'
            % json.dumps(state, ensure_ascii=False)).encode('utf-8')


class ParseNoteTest(unittest.TestCase):
    def setUp(self):
        import xhs_convert
        self.mod = xhs_convert

    def test_new_share_page_schema(self):
        _state, note = self.mod.parse_note(page(NEW_STATE).decode('utf-8'))
        self.assertEqual(note['title'], '新结构标题')
        self.assertEqual(self.mod.note_author(note), '刘颖')
        self.assertEqual(len(note['imageList']), 3)
        self.assertEqual([self.mod.image_url(im) for im in note['imageList']],
                         ['https://sns.example.com/a.jpg',
                          'https://sns.example.com/b.jpg',
                          'https://sns.example.com/c.jpg'])

    def test_old_desktop_page_schema_still_parses(self):
        _state, note = self.mod.parse_note(page(OLD_STATE).decode('utf-8'))
        self.assertEqual(note['title'], '旧结构标题')
        self.assertEqual(self.mod.note_author(note), '旧作者')
        self.assertEqual(self.mod.image_url(note['imageList'][0]),
                         'https://sns.example.com/old.jpg')

    def test_login_wall_state_is_an_error_not_an_empty_note(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.mod.parse_note(page(WALL_STATE).decode('utf-8'))
        self.assertIn('noteDetailMap 为空', str(ctx.exception))

    def test_page_without_state_is_an_error(self):
        with self.assertRaises(RuntimeError) as ctx:
            self.mod.parse_note('<html><body>风控页</body></html>')
        self.assertIn('__INITIAL_STATE__', str(ctx.exception))

    def test_image_url_fallbacks(self):
        self.assertEqual(self.mod.image_url({'urlDefault': 'd'}), 'd')
        self.assertEqual(self.mod.image_url({'url': 'u'}), 'u')
        self.assertEqual(self.mod.image_url({'infoList': [{}, {'url': 'i'}]}), 'i')
        self.assertEqual(self.mod.image_url({}), '')
        self.assertEqual(self.mod.image_url(None), '')


class FetchPageTest(unittest.TestCase):
    """登录墙是 UA 门控的：桌面 UA 恒定被重定向，移动端 UA 才拿得到笔记页。"""

    def setUp(self):
        import xhs_convert
        self.mod = xhs_convert

    def test_mobile_ua_is_tried_first(self):
        seen = []

        def fake_get(url, ua=None, referer='', timeout=40):
            seen.append(ua)
            return NOTE_URL, page(NEW_STATE)

        with mock.patch.object(self.mod, 'http_get', side_effect=fake_get):
            final_url, data = self.mod.fetch_page('https://xhslink.cn/o/short', retries=1)
        self.assertEqual(seen, [self.mod.UA_MOBILE])
        self.assertEqual(final_url, NOTE_URL)
        self.assertIn(b'noteData', data)

    def test_login_wall_switches_to_next_ua(self):
        seen = []

        def fake_get(url, ua=None, referer='', timeout=40):
            seen.append(ua)
            if ua == self.mod.UA_MOBILE:
                return LOGIN_URL, page(WALL_STATE)
            return NOTE_URL, page(NEW_STATE)

        with mock.patch.object(self.mod, 'http_get', side_effect=fake_get):
            final_url, _data = self.mod.fetch_page('https://xhslink.cn/o/short', retries=1)
        self.assertEqual(seen, [self.mod.UA_MOBILE, self.mod.UA_DESKTOP],
                         '移动端吃登录墙后必须换桌面 UA 再试')
        self.assertEqual(final_url, NOTE_URL)

    def test_all_uas_walled_reports_login_wall(self):
        def fake_get(url, ua=None, referer='', timeout=40):
            return LOGIN_URL, page(WALL_STATE)

        with mock.patch.object(self.mod, 'http_get', side_effect=fake_get):
            with self.assertRaises(RuntimeError) as ctx:
                self.mod.fetch_page('https://xhslink.cn/o/short', retries=1)
        self.assertIn('登录墙', str(ctx.exception),
                      '失败原因必须写明登录墙，而不是笼统的「解析失败」')

    def test_is_login_wall(self):
        self.assertTrue(self.mod.is_login_wall(LOGIN_URL))
        self.assertFalse(self.mod.is_login_wall(NOTE_URL))


class DownloadNewSchemaImagesTest(unittest.TestCase):
    def test_new_schema_image_is_downloaded(self):
        import xhs_convert
        ws = TempWorkspace()
        self.addCleanup(ws.cleanup)
        img_dir = str(ws.tmp / 'images')
        os.makedirs(img_dir, exist_ok=True)
        imgs = NEW_STATE['noteData']['data']['noteData']['imageList']

        with mock.patch.object(xhs_convert, 'fetch', return_value=PNG):
            out = xhs_convert.download_images(imgs, img_dir)
        self.assertEqual(out['failed'], [])
        self.assertEqual([r[1] for r in out['results']],
                         ['image_01.png', 'image_02.png', 'image_03.png'])
        self.assertTrue(os.path.isfile(os.path.join(img_dir, 'image_03.png')))


class MainEntryNewSchemaTest(unittest.TestCase):
    """完整入口：新结构页面 → md + images/ + source_page.html（端到端可入库）。"""

    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)
        self._prev_root = os.environ.get('OBS_WS_ROOT')
        os.environ['OBS_WS_ROOT'] = str(self.ws.ws)
        self._prev_argv = list(sys.argv)
        import xhs_convert
        self.mod = xhs_convert
        self.addCleanup(self._restore)

    def _restore(self):
        if self._prev_root is None:
            os.environ.pop('OBS_WS_ROOT', None)
        else:
            os.environ['OBS_WS_ROOT'] = self._prev_root
        sys.argv = self._prev_argv

    def test_main_writes_note_and_local_images(self):
        out_dir = self.ws.tmp / 'out'
        sys.argv = ['xhs_convert.py', 'https://xhslink.cn/o/short', str(out_dir)]
        buf = io.StringIO()
        with mock.patch.object(self.mod, 'fetch_page', return_value=(NOTE_URL, page(NEW_STATE))), \
                mock.patch.object(self.mod, 'fetch', return_value=PNG):
            with contextlib.redirect_stdout(buf):
                rc = self.mod.main()
        out = buf.getvalue()
        self.assertEqual(rc, 0, out)
        self.assertIn('md written:', out)
        self.assertIn("title='新结构标题'", out)
        self.assertIn("author='刘颖'", out)
        self.assertIn('images=3', out)

        md = out_dir / '新结构标题.md'
        self.assertTrue(md.is_file(), sorted(p.name for p in out_dir.iterdir()))
        text = md.read_text(encoding='utf-8')
        self.assertIn('# 新结构标题', text)
        self.assertIn('**标签**：CSP', text, '空标签名应被过滤，只留有效标签')
        self.assertIn('images/image_01.png', text)
        self.assertNotIn('https://sns.example.com', text, '图片必须本地化，不留外链')
        self.assertEqual(sorted(p.name for p in (out_dir / 'images').iterdir()),
                         ['image_01.png', 'image_02.png', 'image_03.png'])
        self.assertTrue((out_dir / 'source_page.html').is_file())

    def test_main_title_falls_back_to_first_desc_line(self):
        state = json.loads(json.dumps(NEW_STATE))
        note = state['noteData']['data']['noteData']
        note['title'] = ''
        note['desc'] = '\n  首行当标题  \n第二行'
        out_dir = self.ws.tmp / 'out2'
        sys.argv = ['xhs_convert.py', 'https://xhslink.cn/o/short', str(out_dir)]
        buf = io.StringIO()
        with mock.patch.object(self.mod, 'fetch_page', return_value=(NOTE_URL, page(state))), \
                mock.patch.object(self.mod, 'fetch', return_value=PNG):
            with contextlib.redirect_stdout(buf):
                self.mod.main()
        self.assertTrue((out_dir / '首行当标题.md').is_file(),
                        sorted(p.name for p in out_dir.iterdir()))

    def test_main_dry_run_does_not_download(self):
        out_dir = self.ws.tmp / 'out3'
        sys.argv = ['xhs_convert.py', 'https://xhslink.cn/o/short', str(out_dir), '--dry']
        buf = io.StringIO()
        with mock.patch.object(self.mod, 'fetch_page', return_value=(NOTE_URL, page(NEW_STATE))), \
                mock.patch.object(self.mod, 'fetch', side_effect=AssertionError('--dry 不应下载图片')):
            with contextlib.redirect_stdout(buf):
                rc = self.mod.main()
        self.assertEqual(rc, 0)
        self.assertIn('[dry]', buf.getvalue())
        self.assertFalse(out_dir.exists())


if __name__ == '__main__':
    unittest.main()
