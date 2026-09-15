/**
 * 企微智能机器人长连接客户端
 * ============================================================================
 * 一个实例 = 一条 wss 长连接 + 一个机器人。本类只负责「通道」这一层：
 *
 *   - 连接/认证/重连/被顶下线 的状态机（7×24 必须永不放弃）；
 *   - 把 SDK 的 message.* / event.* 回调收敛成统一的 `onMessage` 事件；
 *   - 流式回执 + 主动推送兜底（流式回执会过期，抖动时必须能退回 sendMessage）；
 *   - 媒体下载解密落盘；
 *   - 对外暴露健康状态（内存快照 + 原子落盘），供运维与设置页状态显示读取；
 *   - 读取控制指令文件，支持**单独**启停这一个机器人。
 *
 * 「收到消息之后干什么」不在这里 —— 那是 router 的职责。这样通道与业务可以
 * 各自演进，也便于单独测试。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 基础重连退避（ms）。SDK 会在此基础上指数放大并封顶。 */
const RECONNECT_INTERVAL_MS = 3000;
/** 单条消息转发给 Agent 后的等待上限（ms）。 */
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;
/** 未连接且无任何 socket 事件多久后强制重连（ms）。 */
const SELF_HEAL_STALE_MS = 180000;
/** 健康状态落盘与心跳周期（ms）。 */
const HEALTH_TICK_MS = 60000;
/** 控制指令轮询周期（ms）。 */
const CONTROL_POLL_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 把任意标签归一成安全的文件名片段。
 *
 * 注意：中文标签会被整体压成下划线（`机器人0号` → `_0_`），多个中文标签因此
 * 可能撞成同一个文件名。所以调用方仍然需要传一个**稳定且唯一**的 slug
 * （见 `lib/index.js` 的 `labelSlug`），这里的清理只是最后一道防线。
 */
export function safeLabel(label) {
  return String(label || 'bot').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'bot';
}

/**
 * 生成稳定且唯一的实例 slug：`<机器人名称>-<序号>`，用于健康状态文件与控制通道。
 *
 * 序号保证唯一（即使名称全是中文、或两个机器人同名），名称保留可读性。
 * @param {string} label - 展示名。
 * @param {number} index - 在 `bots[]` 中的下标（从 1 开始）。
 * @returns {string} 文件名安全且唯一的 slug。
 */
export function labelSlug(label, index) {
  const ascii = String(label || '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = String(index == null ? '' : index);
  if (!ascii) return `bot${suffix || ''}` || 'bot';
  return suffix ? `${ascii}-${suffix}` : ascii;
}

/** 清洗文件名（去掉路径分隔与非法字符）。 */
export function safeFilename(name, fallback) {
  const base = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim();
  return base || fallback;
}

/** 按魔数嗅探图片扩展名（企微有时不给扩展名）。 */
function sniffImageExt(buffer) {
  if (!buffer || buffer.length < 12) return '.bin';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return '.png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  const head6 = buffer.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return '.gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return '.bin';
}

/**
 * 载入企微官方长连接 SDK。
 *
 * 单独抽出来是为了让「包没装好」变成一个**可读的启动错误**，而不是
 * 一个 `undefined is not a constructor`。
 *
 * @returns {{WSClient: Function, generateReqId: Function}} SDK 的具名导出。
 * @throws {Error} 当 SDK 缺失或导出形状不符合预期。
 */
export function loadSdk() {
  let sdk;
  try {
    sdk = require('@wecom/aibot-node-sdk');
  } catch (error) {
    throw new Error(
      `@wecom/aibot-node-sdk 未安装：请在插件包目录执行 npm install（原始错误：${String((error && error.message) || error)}）`,
    );
  }
  const WSClient = sdk && (sdk.WSClient || (sdk.default && sdk.default.WSClient));
  const generateReqId = sdk && sdk.generateReqId;
  if (typeof WSClient !== 'function' || typeof generateReqId !== 'function') {
    throw new Error(`@wecom/aibot-node-sdk 导出形状不符（keys=${Object.keys(sdk || {}).join(',')}）`);
  }
  return { WSClient, generateReqId };
}

/**
 * 一个企微机器人实例。
 */
export class WecomBot {
  /**
   * @param {object} options
   * @param {string} options.label - 实例标签（健康文件名、日志前缀、控制通道名）。
   * @param {string} options.botId - 企微 Bot ID。
   * @param {string} options.secret - 企微 Bot Secret。
   * @param {object} options.paths - `{ healthDir, controlDir, inboxDir }`。
   * @param {number} [options.mediaMaxMb] - 媒体大小上限（MB）。
   * @param {Function} [options.onMessage] - `(payload) => Promise<string|null>`，
   *   返回要回给用户的正文；返回 null/空则回一条兜底说明。
   * @param {Function} [options.onLog] - 结构化日志回调。
   * @param {Function} [options.loadSdkImpl] - 测试注入点。
   * @param {number} [options.turnTimeoutMs] - 单次处理等待上限。
   */
  constructor(options) {
    const opts = options || {};
    this.label = String(opts.label || 'bot');
    /** 文件名/控制通道用的稳定唯一 slug（由调用方按 bots[] 序号生成）。 */
    this.slug = String(opts.slug || safeLabel(this.label));
    this.botId = String(opts.botId || '');
    this.secret = String(opts.secret || '');
    this.paths = opts.paths || {};
    this.mediaMaxMb = Number(opts.mediaMaxMb || 50);
    this.onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : async () => null;
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
    this.turnTimeoutMs = Number(opts.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS);
    this.loadSdkImpl = typeof opts.loadSdkImpl === 'function' ? opts.loadSdkImpl : loadSdk;

    /** 人工停用标记：true 时不再自动重连，看门狗也不应告警。 */
    this.stoppedByUser = false;
    this.client = null;
    this.timers = [];
    this.instanceId = crypto.randomBytes(4).toString('hex');
    this.disposed = false;

    this.health = {
      label: this.label,
      instanceId: this.instanceId,
      pid: process.pid,
      botIdPrefix: this.botId.slice(0, 8),
      state: 'starting', // starting|connecting|online|stopped|kicked|error|disabled
      connected: false,
      authenticatedAt: 0,
      lastHeartbeat: 0,
      lastEventAt: Date.now(),
      lastStateAt: Date.now(),
      startedAt: Date.now(),
      reconnects: 0,
      forcedReconnects: 0,
      lastCommand: null,
      lastCommandAt: 0,
      lastError: null,
      updatedAt: Date.now(),
    };
  }

  /** 该实例的健康状态文件路径。 */
  healthFile() {
    return path.join(this.paths.healthDir || '.', `${this.slug}.json`);
  }

  /** 该实例的控制指令文件路径。 */
  controlFile() {
    return path.join(this.paths.controlDir || '.', `${this.slug}.cmd`);
  }

  /** 日志：带实例前缀，便于多机器人并存时 grep 单实例。 */
  log(event, extra) {
    const payload = { t: new Date().toISOString(), label: this.label, ev: event, ...(extra || {}) };
    this.onLog(payload);
  }

  /** 原子写 JSON，避免下游读到半截文件。 */
  writeHealth() {
    if (this.disposed) return;
    const file = this.healthFile();
    try {
      this.health.pid = process.pid;
      this.health.updatedAt = Date.now();
      this.health.stoppedByUser = this.stoppedByUser;
      this.health.connected = !!(this.client && this.client.isConnected);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.health, null, 2));
      fs.renameSync(tmp, file);
    } catch (error) {
      this.log('health.write.failed', { message: String((error && error.message) || error) });
    }
  }

  /** 状态迁移 + 落盘。 */
  setState(next, extra) {
    const changed = this.health.state !== next;
    this.health.state = next;
    this.health.lastStateAt = Date.now();
    if (extra) Object.assign(this.health, extra);
    if (changed) this.log('state', { to: next });
    this.writeHealth();
  }

  /** 只删自己这一代写的健康文件（live 重载时新旧实例会短暂并存）。 */
  removeOwnHealthFile() {
    try {
      const file = this.healthFile();
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current && current.instanceId === this.instanceId) fs.unlinkSync(file);
    } catch {
      /* 文件不存在或已被替换：无需处理 */
    }
  }

  /**
   * 建立连接并安装全部监听与定时器。
   * @throws {Error} 凭证缺失或 SDK 不可用时抛错，由调用方决定如何上报。
   */
  start() {
    if (!this.botId || !this.secret) {
      throw new Error(`机器人「${this.label}」缺少 Bot ID 或 Secret`);
    }
    const { WSClient, generateReqId } = this.loadSdkImpl();
    this.generateReqId = generateReqId;
    this.writeHealth();

    // maxReconnectAttempts=-1 / maxAuthFailureAttempts=-1：
    // SDK 默认分别只重试 10 次与 5 次，一次短暂网络抖动或一次 Secret 写错
    // 就会让通道**永久静默离线**。7×24 场景必须永不放弃。
    const client = new WSClient({
      botId: this.botId,
      secret: this.secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: -1,
      reconnectInterval: RECONNECT_INTERVAL_MS,
    });
    this.client = client;

    client.on('connected', () => {
      this.health.lastEventAt = Date.now();
      this.log('wss.connected');
      if (this.stoppedByUser) {
        this.log('control.ignored', { reason: '已人工停用，忽略本次连接' });
        try { client.disconnect(); } catch { /* noop */ }
        return;
      }
      if (this.health.state !== 'online') this.setState('connecting');
      else this.writeHealth();
    });

    client.on('authenticated', () => {
      const now = Date.now();
      this.health.authenticatedAt = now;
      this.health.lastEventAt = now;
      this.health.lastHeartbeat = now;
      this.health.lastError = null;
      this.log('authenticated');
      if (this.stoppedByUser) { try { client.disconnect(); } catch { /* noop */ } return; }
      this.setState('online');
    });

    client.on('reconnecting', (attempt) => {
      this.health.lastEventAt = Date.now();
      this.health.reconnects = attempt;
      this.log('reconnecting', { attempt });
      this.writeHealth();
    });

    client.on('disconnected', (reason) => {
      const text = String(reason || '');
      this.health.lastEventAt = Date.now();
      if (this.stoppedByUser) { this.log('disconnected', { reason: text, manual: true }); this.writeHealth(); return; }
      if (text.includes('New connection established')) {
        // 被别的连接顶下线：SDK 此时已置 isManualClose 并**放弃自动重连**，
        // 必须显式记为 kicked 交给自愈定时器，否则会静默离线。
        this.setState('kicked', { lastError: text });
        this.log('disconnected.kicked', { reason: text });
      } else {
        if (this.health.state === 'online') this.setState('connecting', { lastError: text });
        else this.writeHealth();
        this.log('disconnected', { reason: text });
      }
    });

    client.on('error', (error) => {
      const message = String((error && error.message) || error);
      this.health.lastEventAt = Date.now();
      this.log('wss.error', { message });
      if (this.stoppedByUser) { this.writeHealth(); return; }
      this.setState('error', { lastError: message });
    });

    this.installHandlers(client);
    this.installTimers(client);

    this.setState('connecting');
    client.connect();
    this.log('connecting', { botId: `${this.botId.slice(0, 8)}…` });
    return this;
  }

  /** 消息/事件回调 → 业务分发。 */
  installHandlers(client) {
    client.on('message.text', (frame) => {
      const content = String((((frame.body || {}).text || {}).content) || '');
      this.log('message.text', { len: content.length });
      void this.handleInbound(frame, { kind: 'text', text: content });
    });

    client.on('message.voice', (frame) => {
      const content = String((((frame.body || {}).voice || {}).content) || '');
      this.log('message.voice', { len: content.length });
      if (!content) {
        void this.safeReply(frame, '🎤 语音未能转写，请用文字发送要收藏的链接。');
        return;
      }
      void this.handleInbound(frame, { kind: 'voice', text: content });
    });

    client.on('message.image', (frame) => { this.log('message.image'); void this.handleMedia(frame, 'image', '图片'); });
    client.on('message.file', (frame) => { this.log('message.file'); void this.handleMedia(frame, 'file', '文件'); });
    client.on('message.video', (frame) => { this.log('message.video'); void this.handleMedia(frame, 'video', '视频'); });
    client.on('message.mixed', (frame) => { this.log('message.mixed'); void this.handleMixed(frame); });

    client.on('event.enter_chat', (frame) => {
      this.log('event.enter_chat');
      void Promise.resolve(client.replyWelcome(frame, {
        msgtype: 'text',
        text: { content: '你好 👋 发送「收藏 <网页链接>」或直接发链接，我会把它整理进 Obsidian。' },
      })).catch((error) => this.log('welcome.failed', { message: String((error && error.message) || error) }));
    });
  }

  /** 心跳 + 控制通道 + 自愈。 */
  installTimers(client) {
    const hbTimer = setInterval(() => {
      const now = Date.now();
      if (this.health.state === 'online' && client.isConnected) {
        this.health.lastHeartbeat = now;
        this.log('hb-alive');
      } else {
        this.log('hb-miss', { state: this.health.state });
      }
      this.writeHealth();
    }, HEALTH_TICK_MS);

    const ctrlTimer = setInterval(() => {
      const file = this.controlFile();
      let raw = null;
      try {
        if (fs.existsSync(file)) { raw = fs.readFileSync(file, 'utf8'); fs.unlinkSync(file); }
      } catch (error) {
        this.log('control.read.failed', { message: String((error && error.message) || error) });
        return;
      }
      if (raw === null) return;
      const cmd = String(raw).trim().split(/\s+/)[0].toLowerCase();
      this.health.lastCommand = cmd;
      this.health.lastCommandAt = Date.now();
      this.applyControl(cmd);
    }, CONTROL_POLL_MS);

    const healTimer = setInterval(() => {
      if (this.stoppedByUser) return;
      if (client.isConnected) return;
      const now = Date.now();
      const idleMs = now - this.health.lastEventAt;
      if (idleMs < SELF_HEAL_STALE_MS) return;
      this.health.forcedReconnects += 1;
      this.health.lastEventAt = now;
      this.log('self-heal', { idleSec: Math.round(idleMs / 1000), attempt: this.health.forcedReconnects });
      try { client.connect(); } catch (error) { this.log('self-heal.failed', { message: String((error && error.message) || error) }); }
      this.writeHealth();
    }, HEALTH_TICK_MS);

    this.timers.push(hbTimer, ctrlTimer, healTimer);
  }

  /** 执行一条控制指令：start | stop | restart。 */
  applyControl(cmd) {
    const client = this.client;
    if (!client) return;
    if (cmd === 'stop') {
      this.stoppedByUser = true;
      this.log('control.stop', { note: '只停这一个机器人，不再自动重连' });
      try { client.disconnect(); } catch { /* noop */ }
      this.setState('stopped', { lastError: null });
      return;
    }
    if (cmd === 'start' || cmd === 'restart') {
      this.stoppedByUser = false;
      const needConnect = cmd === 'restart' || !client.isConnected;
      this.log('control.start', { cmd, needConnect });
      if (needConnect) {
        this.setState('connecting', { lastError: null });
        // 主动重连期间刷新事件时间戳，否则自愈计时器会把「我们自己在重连」
        // 误判成「长期无事件」，抢在计划重连之前再补一次 connect()。
        this.health.lastEventAt = Date.now();
        try { client.disconnect(); } catch { /* noop */ }
        setTimeout(() => {
          if (this.stoppedByUser || this.disposed) return;
          try { client.connect(); } catch (error) { this.log('control.connect.failed', { message: String((error && error.message) || error) }); }
        }, 300);
      } else {
        this.setState('online');
      }
      return;
    }
    this.log('control.unknown', { cmd, supported: 'start|stop|restart' });
    this.writeHealth();
  }

  /**
   * 内联文本/语音消息的统一入口。
   * @param {object} frame - SDK 原始帧（不跨进程序列化，只在本进程内传递）。
   * @param {{kind: string, text: string}} payload - 归一后的消息内容。
   */
  async handleInbound(frame, payload) {
    await this.ackStream(frame, '✅ 已收到，正在处理，请稍候…');
    const sid = this.lastStreamId;
    let answer = null;
    let reason = 'ok';
    try {
      answer = await this.onMessage({ frame, label: this.label, kind: payload.kind, text: payload.text });
    } catch (error) {
      reason = 'throw';
      this.log('onMessage.failed', { message: String((error && error.message) || error) });
    }
    const finalText = answer && String(answer).trim()
      ? String(answer).trim()
      : `抱歉，这次没有生成可回复的内容（原因：${reason}）。请重试或换个问法。`;
    try {
      await this.finishStream(frame, sid, finalText);
      this.log('answered', { len: finalText.length });
    } catch (error) {
      // 流式最终回复失败（回执超时/连接抖动）→ 等重连后主动推送兜底，
      // 否则用户永远收不到答案，而 agent 那边其实已经处理完了。
      this.log('reply.failed', { message: String((error && error.message) || error) });
      await this.fallbackPush(frame, finalText);
    }
  }

  /** 图片/文件/视频：回执 → 下载解密落盘 → 回复路径。 */
  async handleMedia(frame, kind, label) {
    const sid = this.generateReqId('stream');
    const body = frame.body || {};
    const seg = (body && body[kind]) || {};
    const info = { url: seg.url, aeskey: seg.aeskey, filename: seg.filename };
    try { await this.client.replyStream(frame, sid, `✅ 已收到${label}，正在下载解密…`, false); }
    catch (error) { this.log('media.ack.failed', { message: String((error && error.message) || error) }); }

    let answer;
    try {
      if (!info.url) throw new Error('消息缺少 url');
      const res = await this.client.downloadFile(info.url, info.aeskey);
      const buffer = res.buffer;
      const mb = buffer.length / (1024 * 1024);
      if (mb > this.mediaMaxMb) throw new Error(`文件 ${mb.toFixed(1)}MB 超过上限 ${this.mediaMaxMb}MB`);
      const msgid = safeFilename(String(body.msgid || Date.now()), 'msg');
      const dir = path.join(this.paths.inboxDir || '.', msgid);
      fs.mkdirSync(dir, { recursive: true });
      let fname = safeFilename(res.filename || info.filename, `${kind}_${Date.now()}`);
      if (kind === 'image' && !/\.[a-zA-Z0-9]{2,5}$/.test(fname)) fname += sniffImageExt(buffer);
      const dest = path.join(dir, fname);
      fs.writeFileSync(dest, buffer);
      this.log('media.saved', { kind, dest, bytes: buffer.length });
      answer = `✅ ${label}已保存\n\n- 路径：\`${dest}\`\n- 大小：${(buffer.length / 1024).toFixed(1)} KB\n\n如需整理进 Obsidian，请直接发送要收藏的网页链接。`;
    } catch (error) {
      const message = String((error && error.message) || error);
      this.log('media.failed', { kind, message });
      answer = `❌ ${label}处理失败：${message}`;
    }
    try {
      await this.client.replyStream(frame, sid, answer, true);
    } catch (error) {
      this.log('media.reply.failed', { message: String((error && error.message) || error) });
      await this.fallbackPush(frame, answer);
    }
  }

  /** 图文混排：给一条明确指引，不做解析。 */
  async handleMixed(frame) {
    const note = 'ℹ️ 收到图文混排消息：请把图片或文件单独发送一次，或直接发送要收藏的网页链接。';
    const sid = this.generateReqId('stream');
    try { await this.client.replyStream(frame, sid, note, true); }
    catch (error) {
      this.log('mixed.reply.failed', { message: String((error && error.message) || error) });
      await this.fallbackPush(frame, note);
    }
  }

  /** 发一条流式回执并记住 streamId，供最终回复复用同一个气泡。 */
  async ackStream(frame, text) {
    const sid = this.generateReqId('stream');
    this.lastStreamId = sid;
    try { await this.client.replyStream(frame, sid, text, false); }
    catch (error) { this.log('ack.failed', { message: String((error && error.message) || error) }); }
    return sid;
  }

  /** 结束当前流式气泡。 */
  async finishStream(frame, sid, text) {
    return this.client.replyStream(frame, sid || this.lastStreamId || this.generateReqId('stream'), text, true);
  }

  /** 不需要业务处理时的一句直接回复（自己开一个流式气泡并结束它）。 */
  async safeReply(frame, text) {
    const sid = this.generateReqId('stream');
    try { await this.client.replyStream(frame, sid, text, true); }
    catch (error) {
      this.log('safeReply.failed', { message: String((error && error.message) || error) });
      await this.fallbackPush(frame, text);
    }
  }

  /** 目标会话：群聊用 chatid，单聊用发送者 userid。 */
  targetChatOf(frame) {
    const body = (frame && frame.body) || {};
    if (body.chatid) return body.chatid;
    if (body.from && body.from.userid) return body.from.userid;
    return undefined;
  }

  /**
   * 主动推送兜底：先等连接恢复（最多 15s），再用 sendMessage 发。
   * 流式回执有生命周期，连接抖动或处理耗时长时会失效 —— 这是第二通道。
   */
  async fallbackPush(frame, text) {
    const chat = this.targetChatOf(frame);
    if (!chat) { this.log('fallback.no-target'); return false; }
    for (let i = 0; i < 30; i += 1) {
      if (this.client.isConnected) break;
      await sleep(500);
    }
    try {
      await this.client.sendMessage(chat, { msgtype: 'markdown', markdown: { content: text } });
      this.log('fallback.sent', { len: String(text).length });
      return true;
    } catch (error) {
      this.log('fallback.failed', { message: String((error && error.message) || error) });
      return false;
    }
  }

  /** 停止连接并清理定时器与健康文件。 */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    try { if (this.client) this.client.disconnect(); } catch { /* noop */ }
    this.removeOwnHealthFile();
    this.log('disposed');
  }
}

export { DEFAULT_TURN_TIMEOUT_MS };
