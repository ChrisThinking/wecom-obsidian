#!/usr/bin/env node
/**
 * Shell 脚本健壮性回归（macOS 自带 bash 3.2 + UTF-8 locale）
 * ============================================================================
 * 复现的问题：`LC_ALL=C.UTF-8 bash install/verify.sh` 在第 64 行报
 * `PATCH…: unbound variable`。
 *
 * 根因是 bash 3.2 在 UTF-8 locale 下把**紧跟在 `$VAR` 后面的多字节字符**当成
 * 变量名的一部分（`$PATCH（存在）` → 变量名变成 `PATCH〈多字节〉`），于是
 * `set -u` 直接判定未定义。写成 `${PATCH}` 就正确终止变量名。
 *
 * 两道防线：
 *   1. 静态扫描：所有 *.sh 里不得出现「`$VAR` 紧跟非 ASCII 字符」；
 *   2. 行为验证：真的在 C.UTF-8 下跑 install.sh / uninstall.sh，不得出现
 *      `unbound variable`。
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
const UNBRACED_BEFORE_MULTIBYTE = /\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])/g;

/** 递归列出仓库里的 shell 脚本（排除 node_modules/.git）。 */
function shellScripts(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) shellScripts(p, out);
    else if (entry.name.endsWith('.sh')) out.push(p);
  }
  return out;
}

test('所有 shell 脚本：$VAR 后面直接跟非 ASCII 字符时必须写成 ${VAR}', () => {
  const bad = [];
  for (const file of shellScripts(ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      UNBRACED_BEFORE_MULTIBYTE.lastIndex = 0;
      const m = UNBRACED_BEFORE_MULTIBYTE.exec(line);
      if (m) bad.push(`${path.relative(ROOT, file)}:${i + 1}: $${m[1]}… → ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, [], `bash 3.2 在 UTF-8 locale 下会把它当变量名的一部分：\n${bad.join('\n')}`);
});

test('install.sh：LC_ALL=C.UTF-8 下不得出现 unbound variable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-locale-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-locale-bin-'));
  // 假 pgrep：避免探测到真实 dsh 进程
  fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  try {
    const proc = spawnSync('/bin/bash', [path.join(ROOT, 'install', 'install.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        DSH_HOME: home, // 不建 profiles/web → 走到 die 分支（正是历史上报错的那条）
        WECOM_PYTHON: '/usr/bin/true',
        LC_ALL: 'C.UTF-8',
        LANG: 'C.UTF-8',
      },
    });
    const out = proc.stdout + proc.stderr;
    assert.doesNotMatch(out, /unbound variable/, `UTF-8 locale 下不应报 unbound variable：\n${out}`);
    assert.match(out, /找不到 DSH Profile 目录/, '应当走到明确的错误提示');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('uninstall.sh：LC_ALL=C.UTF-8 下不得出现 unbound variable', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-locale-'));
  try {
    const proc = spawnSync('/bin/bash', [path.join(ROOT, 'install', 'uninstall.sh')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        DSH_HOME: home,
        LC_ALL: 'C.UTF-8',
        LANG: 'C.UTF-8',
      },
    });
    const out = proc.stdout + proc.stderr;
    assert.equal(proc.status, 0, out);
    assert.doesNotMatch(out, /unbound variable/);
    assert.match(out, /保留运行时数据/, '应打印保留数据的提示（含 ${DATA_DIR}）');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
