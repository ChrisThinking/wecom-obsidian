#!/usr/bin/env node
/**
 * 工作区模板同步回归（升级后必须跑新脚本）
 * ============================================================================
 * 真实踩过：插件升级后重启 DSH，工作区里的 `scripts/` 还是上一版 —— 因为
 * materialize 只「补齐缺失文件」，已存在的脚本永不覆盖。于是拉了修复、重启了，
 * 库里的行为却没变（排查时最费时间的一类问题）。
 *
 * 现在：模板树 = 插件包内的 `pipeline/`（只读事实源），每次 materialize 都
 * **新增 + 覆盖更新 + 清理已删除的模板文件**；用户数据（staging/、logs/、
 * 自建文件）一律不动。
 *
 * 用法：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { materialize, PLUGIN_ROOT } from '../lib/workspace.js';

const TEMPLATE = path.join(PLUGIN_ROOT, 'pipeline');

/** 造一个一次性环境：临时工作区 + 临时库 + 临时 DSH_HOME。
 *
 * DSH_HOME 必须一起改：materialize 会顺带建 `${DSH_HOME}/wecom-obsidian/pylibs`，
 * 不改就会写到真实数据目录（测试应当完全 hermetic）。
 */
function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-ws-'));
  const workspaceRoot = path.join(root, 'workspace');
  const vaultRoot = path.join(root, 'vault');
  fs.mkdirSync(vaultRoot, { recursive: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const settings = { workspaceRoot, vaultRoot, store: { topFolder: '01_文章分享' }, pipeline: {} };
  const restore = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, workspaceRoot, vaultRoot, settings, restore };
}

test('materialize：首次落位把模板脚本复制进工作区', () => {
  const e = env();
  try {
    const paths = materialize(e.settings);
    assert.ok(fs.existsSync(path.join(e.workspaceRoot, 'scripts', 'manage', 'store.py')));
    assert.ok(fs.existsSync(path.join(e.workspaceRoot, 'scripts', 'wf_common.py')));
    assert.ok(paths.template.copied > 0, '首次落位应有拷贝');
    // 不作落位：skills（唯一副本在插件包里）、tests（仓库回归测试）
    assert.equal(fs.existsSync(path.join(e.workspaceRoot, 'skills')), false);
    assert.equal(fs.existsSync(path.join(e.workspaceRoot, 'tests')), false);
  } finally {
    e.restore();
  }
});

test('materialize：工作区里的旧脚本必须被新版覆盖（升级路径）', () => {
  const e = env();
  try {
    materialize(e.settings);
    const target = path.join(e.workspaceRoot, 'scripts', 'wf_common.py');
    const shipped = fs.readFileSync(path.join(TEMPLATE, 'scripts', 'wf_common.py'), 'utf8');

    // 模拟「上一版插件落位过、现在是旧内容」
    fs.writeFileSync(target, '# 旧版本脚本\n');
    materialize(e.settings);
    assert.equal(fs.readFileSync(target, 'utf8'), shipped, '升级后必须跑新脚本');

    // 再跑一次不应重复写（内容相同就跳过）
    const again = materialize(e.settings);
    assert.equal(again.template.copied, 0, '内容一致时不应重写');
  } finally {
    e.restore();
  }
});

test('materialize：模板里已删除的文件会被清理（脚本改名不留死代码）', () => {
  const e = env();
  try {
    materialize(e.settings);
    const stale = path.join(e.workspaceRoot, 'scripts', 'legacy_old_script.py');
    fs.writeFileSync(stale, '# 上一版存在、这一版已删除\n');
    // 把它登记进清单，模拟「上一版落位过」
    const manifestPath = path.join(e.workspaceRoot, '.wecom-obsidian-template.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files.push('scripts/legacy_old_script.py');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const paths = materialize(e.settings);
    assert.equal(fs.existsSync(stale), false, '已从模板删除的脚本必须被清理');
    assert.ok(paths.template.removed >= 1);
  } finally {
    e.restore();
  }
});

test('materialize：用户数据与自建文件必须原样保留', () => {
  const e = env();
  try {
    materialize(e.settings);
    const ledger = path.join(e.workspaceRoot, 'logs', 'state', 'processed-urls.jsonl');
    const staged = path.join(e.workspaceRoot, 'staging', 'converted', '微信', 'x', 'a.md');
    const mine = path.join(e.workspaceRoot, '我的笔记.txt');
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(ledger, '{"url_key":"k"}\n');
    fs.writeFileSync(staged, 'staged\n');
    fs.writeFileSync(mine, '用户自己放的\n');

    materialize(e.settings);

    assert.equal(fs.readFileSync(ledger, 'utf8'), '{"url_key":"k"}\n', '账本不能被模板同步碰');
    assert.equal(fs.readFileSync(staged, 'utf8'), 'staged\n', 'staging 里的中间产物要保留');
    assert.equal(fs.readFileSync(mine, 'utf8'), '用户自己放的\n', '工作区根下的自建文件要保留');
  } finally {
    e.restore();
  }
});

test('materialize：清单写入工作区，不落进 config/', () => {
  const e = env();
  try {
    materialize(e.settings);
    const manifest = path.join(e.workspaceRoot, '.wecom-obsidian-template.json');
    assert.ok(fs.existsSync(manifest));
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.ok(Array.isArray(parsed.files) && parsed.files.includes('scripts/manage/store.py'));
    assert.equal(fs.existsSync(path.join(e.workspaceRoot, 'config', '.wecom-obsidian-template.json')), false);
  } finally {
    e.restore();
  }
});

test('materialize：账本/staging 不进模板清单，也不会被清单清理删掉', () => {
  // 真实踩过：插件包 pipeline/ 被采集会话同时当工作区用，真实账本落进模板树；
  // 于是它会被同步进用户工作区（覆盖账本），也可能因「本版模板里没有」被清理。
  const e = env();
  try {
    materialize(e.settings);
    const manifestPath = path.join(e.workspaceRoot, '.wecom-obsidian-template.json');
    const ledger = path.join(e.workspaceRoot, 'logs', 'state', 'processed-urls.jsonl');
    const stale = path.join(e.workspaceRoot, 'scripts', 'legacy_old_script.py');
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.writeFileSync(ledger, '{"url_key":"k"}\n');
    fs.writeFileSync(stale, '# 上一版存在、这一版已删除\n');

    // 模拟「旧版本清单把日志也登记成模板文件」
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files.push('logs/state/processed-urls.jsonl', 'scripts/legacy_old_script.py');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    materialize(e.settings);

    assert.equal(fs.readFileSync(ledger, 'utf8'), '{"url_key":"k"}\n',
      '账本绝不能被清单清理删掉');
    assert.equal(fs.existsSync(stale), false, '真正的模板文件仍应按清单清理');
    const after = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(after.files.some((f) => f.startsWith('logs/') || f.startsWith('staging/')), false,
      '用户数据不应再被登记进模板清单');
  } finally {
    e.restore();
  }
});
