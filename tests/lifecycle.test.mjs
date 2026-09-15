#!/usr/bin/env node
/**
 * 插件生命周期回归：`applied` 单例守卫必须在 dispose 时复位
 * ============================================================================
 * 背景（真实踩过）：本包是**双面包**（`dsh.bundle` + `dsh.client`），DSH 会为
 * `dsh.client` 派生第二个装载入口，指向同一个模块实例；profile 又是
 * `patchReload: live`，补丁层热更新会「dispose 再 apply」，但模块实例仍在
 * loader 缓存里。若 `applied` 在清理时没有复位，第二次 `apply()` 会直接短路 ——
 * 插件静默不装载（设置页显示 namespace 不存在），只有重启进程才能恢复。
 *
 * 这里用最小 ctx 桩真实调用 `apply()`：同一模块实例 apply 两次 → 只装配一次；
 * dispose 之后再 apply → 必须重新装配。
 *
 * 用法：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 最小 ctx 桩：只实现 apply() 真正会碰的服务与生命周期。 */
function makeCtx() {
  const state = { registers: 0, effects: [], disposes: [], reconciled: 0 };
  const settingsValue = {
    version: 1,
    bots: [],
    botOverrides: {},
    botOps: [],
    vaultRoot: '',
    workspaceRoot: '',
    store: {},
    pipeline: {},
    replyAck: true,
    inboxDir: '{top}/attachments',
  };
  const scope = {
    get: () => settingsValue,
    watch: (callback) => {
      state.watchers = state.watchers || [];
      state.watchers.push(callback);
      return () => {};
    },
    update: async () => {},
    replace: async () => {},
  };
  const ctx = {
    settings: {
      register: () => {
        state.registers += 1;
        return scope;
      },
      describe: () => [{ ns: 'wecom-obsidian', user: {} }],
    },
    shellEnv: { register: () => {} },
    effect: (setup) => {
      const dispose = setup();
      state.effects.push(dispose);
      return dispose;
    },
    get: () => undefined,
    agentLoop: {},
    agents: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  state.disposeAll = () => {
    for (const dispose of state.effects.splice(0)) {
      if (typeof dispose === 'function') dispose();
    }
  };
  return { ctx, state };
}

test('dispose 后重新 apply 必须重新装配（live reload 不能静默失效）', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-life-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // 同一模块实例：模拟 loader 缓存里的宿主入口
  const mod = await import(`../lib/index.js?lifecycle=${Date.now()}`);

  const first = makeCtx();
  mod.apply(first.ctx);
  assert.equal(first.state.registers, 1, '首次 apply 必须注册设置 namespace');

  // 双面包派生的第二个装载入口：同一模块实例再次 apply → 必须短路
  const second = makeCtx();
  mod.apply(second.ctx);
  assert.equal(second.state.registers, 0, '同一进程内的第二次 apply 必须被单例守卫短路');

  // 模拟 profile 补丁层热更新：dispose 之后再次 apply
  first.state.disposeAll();
  const third = makeCtx();
  mod.apply(third.ctx);
  assert.equal(third.state.registers, 1, 'dispose 之后必须能重新装载（applied 已复位）');
  third.state.disposeAll();
});

test('设置页提交的 botOps 意图会被宿主消费（不在浏览器里改数组）', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-life-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const mod = await import(`../lib/index.js?botops=${Date.now()}`);
  const { ctx, state } = makeCtx();
  const replacements = [];
  // 注意：机器人**不能带可用凭证** —— 否则 reconcile 会真的连企微长连接。
  // 这里只验证「宿主消费意图并精确写回」，凭证安全由 settings-service.test.mjs 覆盖。
  const users = {
    value: {
      bots: [{ label: '甲', enabled: false, botId: '', secret: '', policy: 'open' }],
      botOverrides: { 0: { secret: 'SECRET-A', label: '甲' } },
      botOps: [],
    },
  };
  ctx.settings.register = () => {
    state.registers += 1;
    return {
      get: () => users.value,
      watch: (callback) => {
        state.watchers = state.watchers || [];
        state.watchers.push(callback);
        return () => {};
      },
      update: async () => {},
      replace: async (section) => { replacements.push(section); users.value = section; },
    };
  };
  ctx.settings.describe = () => [{ ns: 'wecom-obsidian', user: users.value }];

  mod.apply(ctx);
  assert.ok(state.watchers && state.watchers.length > 0, '必须注册了设置变更订阅');
  // 模拟配置页写入一条 remove 意图，然后触发设置变更
  users.value = { ...users.value, botOps: [{ op: 'remove', index: 0, nonce: 'n1' }] };
  state.watchers[state.watchers.length - 1]();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(replacements.length, 1, '宿主必须消费命令并写回一次');
  assert.deepEqual(replacements[0].bots, [], 'remove 意图应真的删掉那台机器人');
  assert.deepEqual(replacements[0].botOverrides, {}, '被删机器人的覆盖（含 secret）必须一并移除');
  assert.deepEqual(replacements[0].botOps, [], '命令消费后必须清空队列');
  state.disposeAll();
});
