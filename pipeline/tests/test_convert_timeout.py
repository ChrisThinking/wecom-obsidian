# -*- coding: utf-8 -*-
"""单篇转换超时（设置页「单篇转换超时」）落地回归。

设置页提供了这个开关，就必须真的生效：转换脚本由收藏会话里的 agent 以 bash
调用，宿主掐不了单个进程，因此由 `_common.run_guarded()` 在脚本入口做墙钟兜底。
"""
import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from _harness import REPO, TempWorkspace  # noqa: E402

CONVERT_DIR = REPO / 'pipeline' / 'scripts' / 'convert'
sys.path.insert(0, str(CONVERT_DIR))
import _common  # noqa: E402

CONVERTERS = ['convert_url.py', 'xhs_convert.py', 'convert_toutiao.py',
              'wechat_read_v3.py', 'wechat_share_v3.py']


class ConvertTimeoutConfigTest(unittest.TestCase):
    def setUp(self):
        self.ws = TempWorkspace()
        self.addCleanup(self.ws.cleanup)
        os.environ['OBS_WS_ROOT'] = str(self.ws.ws)

    def test_reads_configured_value(self):
        self.assertEqual(_common.convert_timeout({'convert': {'timeout_sec': 30}}), 30.0)
        self.assertEqual(_common.convert_timeout({'convert': {'timeout_sec': '45'}}), 45.0)

    def test_invalid_values_fall_back_to_default(self):
        for bad in ({}, {'convert': {}}, {'convert': {'timeout_sec': None}},
                    {'convert': {'timeout_sec': 'abc'}}, {'convert': {'timeout_sec': 0}},
                    {'convert': {'timeout_sec': -5}}, {'convert': 'oops'}):
            self.assertEqual(_common.convert_timeout(bad),
                             float(_common.DEFAULT_CONVERT_TIMEOUT_SEC), repr(bad))

    def test_materialized_config_is_read(self):
        """插件物化出的 config/pipeline.json 里的 convert.timeout_sec 必须被读到。"""
        import json
        cfg = json.loads((self.ws.ws / 'config' / 'pipeline.json').read_text(encoding='utf-8'))
        cfg['convert']['timeout_sec'] = 77
        (self.ws.ws / 'config' / 'pipeline.json').write_text(
            json.dumps(cfg, ensure_ascii=False), encoding='utf-8')
        self.assertEqual(_common.convert_timeout(), 77.0)


class RunGuardedTest(unittest.TestCase):
    def _run(self, body):
        code = (
            "import sys; sys.path.insert(0, %r); import _common; %s"
            % (str(CONVERT_DIR), body)
        )
        return subprocess.run([sys.executable, '-c', code],
                              capture_output=True, text=True, timeout=60)

    def test_returns_result_under_limit(self):
        proc = self._run("print('rc=', _common.run_guarded(lambda: 7, timeout=5))")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('rc= 7', proc.stdout)

    def test_aborts_with_marker_when_over_limit(self):
        proc = self._run(
            "import time;"
            "print('before', flush=True);"
            "_common.run_guarded(lambda: time.sleep(30), timeout=0.4)")
        self.assertEqual(proc.returncode, 2)
        self.assertIn('before', proc.stdout)
        self.assertIn('CONVERT_TIMEOUT', proc.stdout)
        self.assertNotIn('CONVERT_URL_OK', proc.stdout)

    def test_every_converter_entry_is_guarded(self):
        """5 个转换脚本的入口都必须走 run_guarded（防止接线被改回去）。"""
        for name in CONVERTERS:
            src = (CONVERT_DIR / name).read_text(encoding='utf-8')
            self.assertIn('_common.run_guarded(', src, '%s 的入口没有接超时兜底' % name)


if __name__ == '__main__':
    unittest.main()
