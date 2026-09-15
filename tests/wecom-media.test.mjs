#!/usr/bin/env node
/**
 * `mediaEnabled` / `replyAck` 落地回归（不连企微，直接驱动 WecomBot 的处理路径）
 * ============================================================================
 * 设置页提供了这两个开关，就必须真的改变行为：
 *   · `mediaEnabled=false` → 不下载、不落盘，只回一条说明；
 *   · `replyAck=false`     → 不发「已收到」回执，但最终回复仍然送达。
 * 这里用注入的假 SDK 客户端跑真实代码路径（不 mock 被测方法本身）。
 *
 * 用法：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WecomBot } from '../lib/wecom-client.js';

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function makeBot(opts = {}) {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-media-'));
  const bot = new WecomBot({
    label: '测试机器人',
    slug: 'test-bot-1',
    paths: { inboxDir: inbox, healthDir: path.join(inbox, 'health'), controlDir: path.join(inbox, 'control') },
    loadSdkImpl: () => ({ WSClient: function WSClient() {}, generateReqId: (p) => `${p}-x` }),
    ...opts,
  });
  const calls = [];
  let seq = 0;
  bot.generateReqId = (prefix) => `${prefix}-${++seq}`;
  bot.client = {
    replyStream: async (frame, sid, text, finish) => {
      calls.push({ msg: frame && frame.body && frame.body.msgid, sid, text, finish: finish === true });
      return { ok: true };
    },
    downloadFile: async (url, aeskey) => {
      calls.push({ download: url, aeskey });
      return { buffer: PNG_HEAD, filename: 'a.png' };
    },
  };
  return { bot, calls, inbox, cleanup: () => fs.rmtreeSync ? fs.rmtreeSync(inbox) : fs.rmSync(inbox, { recursive: true, force: true }) };
}

const mediaFrame = () => ({
  body: {
    msgid: 'msg-1',
    image: { url: 'https://example.com/a.png', aeskey: 'KEY', filename: 'a.png' },
  },
});

test('mediaEnabled=false：不下载、不落盘，只回一条「已关闭」说明', async () => {
  const h = makeBot({ mediaEnabled: false, replyAck: true });
  try {
    await h.bot.handleMedia(mediaFrame(), 'image', '图片');
    assert.equal(h.calls.some((c) => c.download), false, '关闭后不得触发下载');
    assert.deepEqual(fs.readdirSync(h.inbox), [], '关闭后收件目录不得有落盘文件');
    assert.equal(h.calls.filter((c) => typeof c.text === 'string').length, 1, '只应回一条说明');
    assert.match(h.calls[0].text, /已关闭/);
    assert.equal(h.calls[0].finish, true);
  } finally {
    h.cleanup();
  }
});

test('mediaEnabled=true + replyAck=false：不来回执，只回最终结果', async () => {
  const h = makeBot({ mediaEnabled: true, replyAck: false });
  try {
    await h.bot.handleMedia(mediaFrame(), 'image', '图片');
    const replies = h.calls.filter((c) => typeof c.text === 'string');
    assert.equal(replies.length, 1, '关闭回执后不应有「正在下载解密…」那一条');
    assert.equal(replies[0].finish, true);
    assert.match(replies[0].text, /已保存/);
    assert.equal(h.calls.some((c) => c.download), true, '开启时应当下载');
    const saved = fs.readdirSync(h.inbox);
    assert.equal(saved.length, 1, '开启时应当落盘一个消息目录');
  } finally {
    h.cleanup();
  }
});

test('mediaEnabled=true + replyAck=true：先回执，再回最终结果', async () => {
  const h = makeBot({ mediaEnabled: true, replyAck: true });
  try {
    await h.bot.handleMedia(mediaFrame(), 'image', '图片');
    const replies = h.calls.filter((c) => typeof c.text === 'string');
    assert.equal(replies.length, 2);
    assert.match(replies[0].text, /正在下载解密/);
    assert.equal(replies[0].finish, false);
    assert.equal(replies[1].finish, true);
  } finally {
    h.cleanup();
  }
});

test('handleInbound：replyAck=false 时只有最终回复，且用新的 streamId', async () => {
  const h = makeBot({ replyAck: false });
  try {
    h.bot.onMessage = async () => '答案正文';
    await h.bot.handleInbound({ body: {} }, { kind: 'text', text: '你好' });
    const replies = h.calls.filter((c) => typeof c.text === 'string');
    assert.equal(replies.length, 1, '不应有「已收到，正在处理」回执');
    assert.equal(replies[0].text, '答案正文');
    assert.equal(replies[0].finish, true);
    assert.ok(replies[0].sid, '最终回复必须带一个新的 streamId');
  } finally {
    h.cleanup();
  }
});

test('handleInbound：replyAck=true 时先回执并复用同一个 streamId', async () => {
  const h = makeBot({ replyAck: true });
  try {
    h.bot.onMessage = async () => '答案正文';
    await h.bot.handleInbound({ body: {} }, { kind: 'text', text: '你好' });
    const replies = h.calls.filter((c) => typeof c.text === 'string');
    assert.equal(replies.length, 2);
    assert.match(replies[0].text, /已收到/);
    assert.equal(replies[0].finish, false);
    assert.equal(replies[0].sid, replies[1].sid, '回执与最终回复应在同一个气泡');
  } finally {
    h.cleanup();
  }
});

test('handleInbound：并发两条消息不会串用回复流 ID（回归）', async () => {
  const h = makeBot({ replyAck: true });
  try {
    h.bot.onMessage = async ({ text }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return `回复:${text}`;
    };
    // 回执慢一点，制造「A 还在 await、B 已经把 lastStreamId 覆盖掉」的窗口
    const inner = h.bot.client.replyStream;
    h.bot.client.replyStream = async (frame, sid, text, finish) => {
      if (finish !== true) await new Promise((resolve) => setTimeout(resolve, 40));
      return inner(frame, sid, text, finish);
    };

    await Promise.all([
      h.bot.handleInbound({ body: { msgid: 'M1' } }, { kind: 'text', text: '#1' }),
      h.bot.handleInbound({ body: { msgid: 'M2' } }, { kind: 'text', text: '#2' }),
    ]);

    const finals = h.calls.filter((c) => c.finish === true);
    const byMsg = (id) => finals.filter((c) => c.msg === id);
    assert.equal(byMsg('M1').length, 1);
    assert.equal(byMsg('M2').length, 1);
    assert.notEqual(byMsg('M1')[0].sid, byMsg('M2')[0].sid,
      '两条消息的最终回复必须各用各的 streamId');
    assert.match(byMsg('M1')[0].text, /#1/);
    assert.match(byMsg('M2')[0].text, /#2/);
    // 每条消息自己的回执与最终回复要落在同一个气泡里
    const acks = h.calls.filter((c) => c.finish === false);
    assert.equal(acks.find((c) => c.msg === 'M1').sid, byMsg('M1')[0].sid);
    assert.equal(acks.find((c) => c.msg === 'M2').sid, byMsg('M2')[0].sid);
  } finally {
    h.cleanup();
  }
});

test('两个开关的默认值都是「开启」（与 schema 默认一致）', () => {
  const h = makeBot();
  try {
    assert.equal(h.bot.mediaEnabled, true);
    assert.equal(h.bot.replyAck, true);
    const off = makeBot({ mediaEnabled: false, replyAck: false });
    try {
      assert.equal(off.bot.mediaEnabled, false);
      assert.equal(off.bot.replyAck, false);
    } finally {
      off.cleanup();
    }
  } finally {
    h.cleanup();
  }
});
