# -*- coding: utf-8 -*-
"""pipeline 测试的公共夹具：把「脚本 + 配置」复制进临时工作区，用子进程真实跑。

为什么不用 import 直接调函数：STORE/FORMAT/VERIFY 的输入输出**全是磁盘对象**
（工作区、vault、ledger），而且 verify 是子进程调用。只有端到端跑一遍，才能
真的守住「落点/快照/账本/整包保留」这些契约。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SCRIPTS_SRC = REPO / 'pipeline' / 'scripts'
CONFIG_SRC = REPO / 'pipeline' / 'config'


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


class TempWorkspace:
    """一次性工作区：临时 ws（含 scripts/config）+ 临时 vault + 临时 ledger。"""

    def __init__(self, obsidian=None, pipeline=None):
        self.tmp = Path(tempfile.mkdtemp(prefix='wobs-test-'))
        self.ws = self.tmp / 'ws'
        self.vault = self.tmp / 'vault'
        (self.ws / 'config').mkdir(parents=True)
        self.vault.mkdir(parents=True)
        shutil.copytree(SCRIPTS_SRC, self.ws / 'scripts')

        obs = load_json(CONFIG_SRC / 'obsidian.json')
        _deep_update(obs, obsidian or {})
        (self.ws / 'config' / 'obsidian.json').write_text(
            json.dumps(obs, ensure_ascii=False, indent=2), encoding='utf-8')

        pipe = load_json(CONFIG_SRC / 'pipeline.json')
        _deep_update(pipe, pipeline or {})
        (self.ws / 'config' / 'pipeline.json').write_text(
            json.dumps(pipe, ensure_ascii=False, indent=2), encoding='utf-8')

        self.ledger = self.tmp / 'ledger.jsonl'

    # ── 运行 ────────────────────────────────────────────────────────────────
    def env(self):
        env = dict(os.environ)
        env['OBS_WS_ROOT'] = str(self.ws)
        env['OBS_VAULT_ROOT'] = str(self.vault)
        env['OBS_LEDGER_FILE'] = str(self.ledger)
        return env

    def run_script(self, rel, *args, timeout=120):
        cmd = [sys.executable, str(self.ws / 'scripts' / rel)] + [str(a) for a in args]
        return subprocess.run(cmd, capture_output=True, text=True, env=self.env(), timeout=timeout)

    def store(self, pkg, run_id='run-test'):
        return self.run_script('manage/store.py', pkg, '--run-id', run_id)

    def format_note(self, pkg):
        return self.run_script('format/format_note.py', pkg)

    # ── 造包 ────────────────────────────────────────────────────────────────
    def write_note_package(self, name, url, created='2024-05-06T10:00:00',
                           platform='微信', title=None, body='正文。', extra=None, slot='pkg'):
        """写一个能通过 verify 的最小 Note Package，返回目录路径。

        `slot` 是父目录（默认 `pkg`）：包**目录名**必须等于文章名（STORE 用它作
        note 名），所以同名多包只能靠不同父目录区分。
        """
        pkg = self.tmp / slot / name
        pkg.mkdir(parents=True, exist_ok=True)
        title = title or name
        lines = [
            '---',
            'title: "%s"' % title,
            'type: web_article',
            'url: "%s"' % url,
            'author: "作者"',
            'platform: "%s"' % platform,
            'published: 2024-05-06',
            'created: %s' % created,
            'path: ""',
            'read: false',
            'tags: []',
            '---',
            '',
            '# %s' % title,
            '',
            body,
        ]
        (pkg / (name + '.md')).write_text('\n'.join(lines) + '\n', encoding='utf-8')
        for rel, content in (extra or {}).items():
            fp = pkg / rel
            fp.parent.mkdir(parents=True, exist_ok=True)
            fp.write_text(content, encoding='utf-8')
        return pkg

    def write_note_package_with_missing_image(self, name, url, **kw):
        """带一个引用存在 + 一个引用缺失的图片，用来触发 verify FAIL。"""
        pkg = self.write_note_package(name, url, body='![ok](assets/ok.png)\n\n![bad](assets/missing.png)', **kw)
        (pkg / 'assets').mkdir(exist_ok=True)
        (pkg / 'assets' / 'ok.png').write_bytes(b'\x89PNG\r\n\x1a\n')
        return pkg

    def notes(self):
        return sorted(p.relative_to(self.vault).as_posix()
                      for p in self.vault.rglob('*.md'))

    def ledger_records(self):
        if not self.ledger.is_file():
            return []
        out = []
        for line in self.ledger.read_text(encoding='utf-8').splitlines():
            if line.strip():
                out.append(json.loads(line))
        return out

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


def _deep_update(base, patch):
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_update(base[key], value)
        else:
            base[key] = value
    return base
