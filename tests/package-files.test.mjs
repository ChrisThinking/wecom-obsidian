#!/usr/bin/env node
/**
 * 分发包内容回归：`docs/` 必须随包发布
 * ============================================================================
 * 复现的问题：`package.json.files` 没写 `docs/**`，于是 `npm pack` / 发布出去的
 * 包里没有 `docs/plugin.md`（实现与运维文档），而 readme 又明确指向它。
 *
 * 这里不只看 `files` 字段：直接用 `npm pack --dry-run --json` 列出**真实**会进包的
 * 文件（npm 的 glob/忽略规则才是权威）。npm 的日志/缓存重定向到临时目录，避免
 * 写用户的 ~/.npm。
 *
 * 用法：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

test('package.json：files 必须覆盖 docs（详细文档随包发布）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = Array.isArray(pkg.files) ? pkg.files : [];
  assert.ok(files.some((p) => p === 'docs/**' || p === 'docs'), `files 缺少 docs：${JSON.stringify(files)}`);
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'plugin.md')), 'docs/plugin.md 必须存在');
});

test('npm pack：真实打包列表必须包含 docs/plugin.md 与入口文件', (t) => {
  const probe = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('环境里没有 npm，跳过真实打包检查');
    return;
  }
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-pack-'));
  try {
    const proc = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, npm_config_cache: path.join(cache, 'npm-cache') },
    });
    assert.equal(proc.status, 0, `npm pack 失败：${proc.stderr}`);
    const start = proc.stdout.indexOf('[');
    assert.notEqual(start, -1, `npm pack 未返回 JSON：${proc.stdout.slice(0, 200)}`);
    const parsed = JSON.parse(proc.stdout.slice(start));
    const packed = new Set((parsed[0].files || []).map((row) => row.path));
    for (const required of [
      'docs/plugin.md',
      'readme.md',
      'package.json',
      'lib/index.js',
      'lib/bot-ops.js',
      'client/client.js',
      'install/install.sh',
      'pipeline/scripts/manage/store.py',
    ]) {
      assert.ok(packed.has(required), `发布包里缺少 ${required}`);
    }
    // 运行时配置/密钥绝不能进包
    assert.equal(packed.has('settings.yaml'), false);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
