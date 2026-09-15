#!/usr/bin/env node
/**
 * 设置服务回归测试（对着**真实** `@deepseek-ai/dsh-settings` 的 SettingsProvider 跑）
 * ============================================================================
 * 这里守护的是「增删机器人不能损坏凭证配置」这一条，而且刻意不满足于纯函数单测：
 * 前两个用例模拟的正是**修复前的浏览器写法**，用来证明问题真实存在于设置服务层。
 *
 * 覆盖：
 *   1. 读数脱敏：`role('secret')` 字段不出现在 Remote 视图里（只回 {path,set} 侧车）；
 *   2. 数组深路径写入被拒（`{path:['bots','0']}` 会被 schema 拒绝）；
 *   3. [修复前] 用脱敏值整体写回 bots / botOverrides → 其余机器人 Secret 变空；
 *   4. [修复后] 宿主消费 botOps + replace(未脱敏段)：新增保留全部 Secret；
 *   5. [修复后] 删除中间一台：剩余 Secret 随下标正确重排，且被删那台不再存在；
 *   6. 命令幂等：同一 nonce 重复投递不重复执行；
 *   7. 浏览器提交意图（botOps）本身不触碰任何 Secret；
 *   8. `update()` 的合并语义删不掉 botOverrides 的键 —— replace 是必须的。
 *
 * 依赖真实 DSH 安装（`@deepseek-ai/dsh-settings`）。它不在本包依赖里，因此从
 * 已解析到的 `@deepseek-ai/cordis` 真实路径反推宿主 node_modules；**找不到就整体
 * skip**（干净 clone 不至于因为缺宿主而红）。
 *
 * 用法：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { consumeBotOps, applyBotOp } from '../lib/bot-ops.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const require = createRequire(path.join(ROOT, 'package.json'));

/**
 * 从宿主 node_modules 加载真实设置服务。
 * @returns {Promise<{Context: Function, SettingsProvider: Function}|null>} 不可用时 null。
 */
async function loadHostSettings() {
  let cordisPath;
  try {
    cordisPath = require.resolve('@deepseek-ai/cordis');
  } catch {
    return null;
  }
  // .../node_modules/@deepseek-ai/cordis/lib/index.js → .../node_modules
  const hostModules = path.resolve(path.dirname(cordisPath), '..', '..', '..');
  const entry = path.join(hostModules, '@deepseek-ai/dsh-settings', 'lib', 'index.js');
  if (!fs.existsSync(entry)) return null;
  const [{ Context }, { SettingsProvider }] = await Promise.all([
    import(pathToFileURL(cordisPath).href),
    import(pathToFileURL(entry).href),
  ]);
  return { Context, SettingsProvider };
}

const host = await loadHostSettings();
const skip = host ? false : '未找到宿主 @deepseek-ai/dsh-settings（干净 clone）：跳过真实设置服务回归';

const { SETTINGS_NS, WecomObsidianSchema } = await import(pathToFileURL(path.join(ROOT, 'lib/settings-ns.js')).href);

/** 造一台完整机器人（含真实形状的 secret）。 */
function bot(label, botId, secret) {
  return {
    label,
    enabled: true,
    botId,
    secret,
    sessionId: `wecom-${botId}`,
    collectorSessionId: `wecom-${botId}-collector`,
    collectEnabled: true,
    mediaEnabled: true,
    policy: 'open',
    allowlist: [],
    blockedReply: '该指令未对本机器人开放。',
    provider: '',
    model: '',
    reasoningEffort: 'high',
  };
}

/** 三台机器人 + 覆盖表（覆盖表里也放密钥，复刻真实形态）。 */
function seedSection() {
  return {
    bots: [bot('甲', 'aibAAA', 'SECRET-A'), bot('乙', 'aibBBB', 'SECRET-B'), bot('丙', 'aibCCC', 'SECRET-C')],
    botOverrides: {
      0: { label: '甲', secret: 'SECRET-A' },
      1: { label: '乙', secret: 'SECRET-B' },
      2: { label: '丙', secret: 'SECRET-C', policy: 'allowlist' },
    },
  };
}

/**
 * 起一个真实设置服务实例（内存 provider，持久化只落在测试进程内）。
 * @returns {Promise<object>} 读写句柄。
 */
async function harness() {
  const { Context, SettingsProvider } = host;
  class MemProvider extends SettingsProvider {
    constructor(ctx, seed) {
      super(ctx);
      this._seed = seed;
      this.writable = true;
    }

    async load() {
      return JSON.parse(JSON.stringify(this._seed || {}));
    }

    async persist(ns, section) {
      this._seed = { ...(this._seed || {}), [ns]: section };
    }
  }
  const ctx = new Context();
  ctx.plugin(MemProvider, { [SETTINGS_NS]: seedSection() });
  for (let i = 0; i < 100 && !ctx.get('settings'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const settings = ctx.get('settings');
  assert.ok(settings, '真实 SettingsProvider 未能启动');
  const scope = settings.register(SETTINGS_NS, WecomObsidianSchema, { applies: 'live' });
  return {
    ctx,
    settings,
    scope,
    /** Remote 侧看到的（脱敏）视图。 */
    redacted() {
      const row = settings.describe({ redactSecrets: true }).find((item) => item.ns === SETTINGS_NS);
      return JSON.parse(JSON.stringify(row.value));
    },
    /** 原始 user 段（宿主侧、未脱敏）。 */
    userSection() {
      const row = settings.describe().find((item) => item.ns === SETTINGS_NS);
      return JSON.parse(JSON.stringify(row.user || {}));
    },
    /** 当前解析后的值（宿主读到的、含 secret）。 */
    resolved() {
      return scope.get();
    },
    secretsOfBots() {
      return scope.get().bots.map((item) => item.secret);
    },
    /** 按宿主的方式消费 botOps 队列。 */
    consume() {
      const nonceRef = { value: '' };
      const settingsValue = scope.get();
      return consumeBotOps({
        readUserSection: () => (settings.describe().find((item) => item.ns === SETTINGS_NS) || {}).user || {},
        replace: (section) => scope.replace(section),
        isDisposed: () => false,
        lastNonceRef: nonceRef,
      }, settingsValue);
    },
  };
}

test('设置服务：Remote 读数不含任何 secret（只回 {path,set} 侧车）', { skip }, async () => {
  const h = await harness();
  const view = h.redacted();
  assert.equal(Object.prototype.hasOwnProperty.call(view.bots[0], 'secret'), false, 'bots[].secret 不能回传浏览器');
  assert.equal(Object.prototype.hasOwnProperty.call(view.botOverrides['0'], 'secret'), false, 'botOverrides[].secret 不能回传浏览器');
  const row = h.settings.describe({ redactSecrets: true }).find((item) => item.ns === SETTINGS_NS);
  const slots = row.secrets.map((slot) => slot.path.join('.')).sort();
  assert.deepEqual(slots, [
    'botOverrides.0.secret', 'botOverrides.1.secret', 'botOverrides.2.secret',
    'bots.0.secret', 'bots.1.secret', 'bots.2.secret',
  ]);
  assert.ok(row.secrets.every((slot) => slot.set === true));
});

test('设置服务：数组深路径写入被拒（修复前的 addBot 写法不可用）', { skip }, async () => {
  const h = await harness();
  await assert.rejects(
    () => h.settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['bots', '0'], value: { label: 'X' } }]),
    /expected array|settings/i,
  );
  // 失败写入不能污染已有配置
  assert.deepEqual(h.secretsOfBots(), ['SECRET-A', 'SECRET-B', 'SECRET-C']);
});

test('设置服务：[修复前] 脱敏值整体写回 bots / botOverrides 会抹掉其余 Secret', { skip }, async () => {
  const h = await harness();
  const view = h.redacted();
  const nextBots = view.bots.filter((_, i) => i !== 0);
  const nextOverrides = {};
  for (const [key, value] of Object.entries(view.botOverrides)) {
    const i = Number(key);
    if (i === 0) continue;
    nextOverrides[String(i > 0 ? i - 1 : i)] = value;
  }
  await h.settings.mutate(SETTINGS_NS, [
    { op: 'set', path: ['bots'], value: nextBots },
    { op: 'set', path: ['botOverrides'], value: nextOverrides },
  ]);
  assert.deepEqual(h.secretsOfBots(), ['', ''], '这正是修复前会发生的凭证损坏');
});

test('设置服务：[修复后] 宿主消费 add 意图：新增不损坏其余机器人 Secret', { skip }, async () => {
  const h = await harness();
  await h.scope.replace({ ...h.userSection(), botOps: [{ op: 'add', index: 3, nonce: 'n-add' }] });
  assert.equal(await h.consume(), true);
  const value = h.resolved();
  assert.equal(value.bots.length, 4);
  assert.equal(value.bots[3].label, '机器人4');
  assert.deepEqual(value.bots.slice(0, 3).map((b) => b.secret), ['SECRET-A', 'SECRET-B', 'SECRET-C']);
  assert.equal(value.botOverrides['2'].policy, 'allowlist', '其它机器人的覆盖字段必须原样保留');
  assert.deepEqual(value.botOps, [], '命令消费后必须清空');
});

test('设置服务：[修复后] 宿主消费 remove 意图：剩余 Secret 随下标重排且不丢失', { skip }, async () => {
  const h = await harness();
  await h.scope.replace({ ...h.userSection(), botOps: [{ op: 'remove', index: 1, nonce: 'n-remove' }] });
  assert.equal(await h.consume(), true);
  const value = h.resolved();
  assert.deepEqual(value.bots.map((b) => b.label), ['甲', '丙']);
  assert.deepEqual(value.bots.map((b) => b.secret), ['SECRET-A', 'SECRET-C'], '剩下的 Secret 必须跟着机器人走');
  assert.deepEqual(Object.keys(value.botOverrides).sort(), ['0', '1'], '越界的陈旧覆盖键必须被删除');
  assert.equal(value.botOverrides['1'].policy, 'allowlist', '丙的覆盖必须移到下标 1');
  assert.equal(JSON.stringify(value).includes('SECRET-B'), false, '被删除机器人的 Secret 不应留在配置里');
});

test('设置服务：[修复后] 同一 nonce 重复投递不重复执行', { skip }, async () => {
  const h = await harness();
  const nonceRef = { value: '' };
  const readUser = () => h.userSection();
  const deps = {
    readUserSection: readUser,
    replace: (section) => h.scope.replace(section),
    isDisposed: () => false,
    lastNonceRef: nonceRef,
  };
  await h.scope.replace({ ...readUser(), botOps: [{ op: 'add', nonce: 'n-1' }] });
  await consumeBotOps(deps, h.scope.get());
  const afterFirst = h.resolved().bots.length;
  // 模拟「写回已提交、但 watcher 又收到一次同样的队列」：重放同一条命令
  await h.scope.replace({ ...readUser(), botOps: [{ op: 'add', nonce: 'n-1' }] });
  await consumeBotOps(deps, h.scope.get());
  assert.equal(h.resolved().bots.length, afterFirst, '同 nonce 的命令只能执行一次');
  assert.deepEqual(h.resolved().bots.slice(0, 3).map((b) => b.secret), ['SECRET-A', 'SECRET-B', 'SECRET-C']);
});

test('设置服务：浏览器提交意图（botOps）本身不触碰任何 Secret', { skip }, async () => {
  const h = await harness();
  const before = h.userSection();
  await h.settings.mutate(SETTINGS_NS, [
    { op: 'set', path: ['botOps'], value: [{ op: 'remove', index: 2, nonce: 'n-x' }] },
  ]);
  const after = h.userSection();
  assert.deepEqual(after.bots, before.bots);
  assert.deepEqual(after.botOverrides, before.botOverrides);
  assert.deepEqual(h.secretsOfBots(), ['SECRET-A', 'SECRET-B', 'SECRET-C']);
});

test('设置服务：update() 的合并语义删不掉字典键（所以必须用 replace）', { skip }, async () => {
  const h = await harness();
  // 先把 botOverrides 缩到只剩 0、1，再用 update 合并写回
  await h.scope.replace({ ...h.userSection(), botOverrides: { 0: { secret: 'SECRET-A' } } });
  await h.settings.update(SETTINGS_NS, { botOverrides: { 0: { label: '甲2' } } });
  assert.deepEqual(Object.keys(h.resolved().botOverrides).sort(), ['0'], 'merge 不应复活已删除的键');
  // 反证：用 merge 表达「删掉 1」是做不到的 —— 键 1 仍会在（这里先手工造出它）
  await h.scope.replace({ ...h.userSection(), botOverrides: { 0: { secret: 'SECRET-A' }, 1: { secret: 'SECRET-B' } } });
  await h.settings.update(SETTINGS_NS, { botOverrides: { 0: { secret: 'SECRET-A' } } });
  assert.deepEqual(Object.keys(h.resolved().botOverrides).sort(), ['0', '1'], 'merge 删不掉键 1');
});

test('设置服务：applyBotOp 与真实服务组合后 bots[] 仍是数组（schema 可解析）', { skip }, async () => {
  const h = await harness();
  const user = h.userSection();
  const next = applyBotOp({ bots: user.bots, botOverrides: user.botOverrides }, 'remove', 2);
  await h.scope.replace({ ...user, bots: next.bots, botOverrides: next.botOverrides });
  assert.ok(Array.isArray(h.resolved().bots));
  assert.equal(h.resolved().bots.length, 2);
  await assert.rejects(
    () => h.settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['bots', '1', 'secret'], value: 'X' }]),
    /expected array|settings/i,
  );
});
