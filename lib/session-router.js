/**
 * 消息路由与会话编排
 * ============================================================================
 * 收到一条企微文本/语音后，决定它是「收藏」还是「普通对话」，并把它投进
 * 对应的 Agent 会话，等这一回合结束，取回最终回复正文。
 *
 * 两条会话线刻意分开
 * ------------------
 *   聊天会话  ：cwd = 用户配置的工作目录，preset = 调用方指定（默认 cordis），
 *               普通权限，长期复用，回答自由。
 *   收藏会话  ：cwd = 插件工作区（脚本按相对路径 `scripts/…` 调用），
 *               preset = 收藏预设，被**提权**到 danger-full-access / approval=never。
 *
 * 提权只落在收藏会话上，因为：
 *   * 采集流水线要写真实 Obsidian Vault；
 *   * 企微渠道没有可交互的 UI 应答者，审批请求会永久挂起而不是失败。
 *
 * 两个必须踩过的坑（来自原实现）
 * ------------------------------
 *   1. `preset.mount(agentCtx, presetId)` 必须显式调用，否则模型**一个工具都没有**。
 *   2. 用 prepend 注册 `user-questions/request` 应答者，抢在客户端桥接之前认领，
 *      否则 `ask_user_question` / `exit_plan_mode` 在无人应答时永久挂起。
 */
import crypto from 'node:crypto';

/** 收藏指令前缀：`收藏` / `收藏到` / `收藏网页` / `/obs`。 */
const COLLECT_PREFIX_RE = /^(?:收藏|收藏到|收藏网页|\/obs)\s*/i;
/** URL 匹配。 */
const URL_RE = /https?:\/\/\S+/i;
/** 纯 URL（整条消息就是一个链接）。 */
const BARE_URL_RE = /^https?:\/\/\S+$/i;

/**
 * 判断一条消息是否是收藏请求。
 *
 * 规则（与原实现一致，刻意保守）：
 *   - 以收藏前缀开头 **且** 含 URL → 收藏；
 *   - 整条消息就是一个裸 URL → 收藏；
 *   - 其它一律普通对话（含前缀但没链接 = 让 agent 追问/解释）。
 *
 * @param {string} text - 消息文本。
 * @returns {boolean} 是否走收藏链。
 */
export function isCollectorRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (COLLECT_PREFIX_RE.test(t)) return URL_RE.test(t);
  return BARE_URL_RE.test(t);
}

/** 从消息里取出第一个 URL。 */
export function firstUrl(text) {
  const match = String(text || '').match(/https?:\/\/\S+/i);
  return match ? match[0] : '';
}

/**
 * 构造一条用户消息（DSH 消息形状）。
 * @param {string} text - 正文。
 * @returns {object} 可直接交给 `agent.followup()` 的消息。
 */
export function makeUserMessage(text) {
  return {
    id: `wmsg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  };
}

/** 从 DSH 消息里抽出全部文本块。 */
export function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 判断一条消息是否命中白名单。
 *
 * **必须句首锚定**，不能子串匹配：否则「帮助我收藏这个」会借「帮助」绕过
 * 闸门（这条在原实现里被列为不变量）。
 *
 * @param {string} text - 消息文本。
 * @param {string[]} allowlist - 白名单条目。
 * @returns {boolean} 是否放行。
 */
export function isAllowlisted(text, allowlist) {
  const t = String(text || '').trim();
  if (!t) return false;
  const list = Array.isArray(allowlist) ? allowlist : [];
  return list.some((entry) => {
    const key = String(entry || '').trim();
    if (!key) return false;
    return t.toLowerCase().startsWith(key.toLowerCase());
  });
}

/**
 * 会话编排器：一个机器人实例一个。
 */
export class CollectorRouter {
  /**
   * @param {object} options
   * @param {Function} options.getSettings - `() => object`，返回当前已解析设置。
   * @param {Function} options.getPaths - `() => object`，返回当前物化路径集合。
   * @param {Function} [options.onLog] - 结构化日志回调。
   * @param {number} [options.turnTimeoutMs] - 单回合等待上限。
   */
  constructor(options) {
    const opts = options || {};
    this.getSettings = opts.getSettings || (() => ({}));
    this.getPaths = opts.getPaths || (() => ({}));
    this.onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
    this.turnTimeoutMs = Number(opts.turnTimeoutMs || 10 * 60 * 1000);
    /** sessionId → { handle, agent } */
    this.agents = new Map();
    /** sessionId → Promise 链尾，保证同一会话串行。 */
    this.queues = new Map();
    this.ctx = null;
    this.collectorPreset = 'wecom-obsidian-collector';
  }

  /** 绑定宿主 Context（apply 时注入）。 */
  bind(ctx) {
    this.ctx = ctx;
    return this;
  }

  log(event, extra) {
    this.onLog({ t: new Date().toISOString(), ev: `router.${event}`, ...(extra || {}) });
  }

  /**
   * 生成稳定的会话 id。
   *
   * 稳定很重要：同一个机器人重启后要落回**同一个会话**，否则 DSH 会话列表
   * 会被每次重启刷出一堆新会话，收藏上下文也断了。
   *
   * @param {string} label - 机器人标签。
   * @param {boolean} collector - 是否收藏会话。
   * @param {object} bot - 该机器人的配置。
   * @returns {string} 会话 id。
   */
  sessionIdFor(label, collector, bot) {
    const configured = collector ? bot && bot.collectorSessionId : bot && bot.sessionId;
    if (configured && String(configured).trim()) return String(configured).trim();
    return collector ? `wecom-obsidian-${label}-collector` : `wecom-obsidian-${label}`;
  }

  /**
   * 部署默认模型路由。
   *
   * 直接读设置服务里的 `agent-default-model`（DSH 自己的默认值来源），
   * 而不是硬编码 —— 用户改默认模型后，没有单独指定模型的机器人应当跟着走。
   * 读不到时回落到内置兜底，保证 `{{provider}}` / `{{model}}` **永远有值**。
   *
   * @returns {{provider: string, model: string, reasoningEffort: string}} 默认路由。
   */
  deploymentDefaults() {
    const fallback = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
    try {
      if (this.settingsService && typeof this.settingsService.get === 'function') {
        const value = this.settingsService.get('agent-default-model');
        if (value && typeof value === 'object') {
          return {
            provider: String(value.provider || '') || fallback.provider,
            model: String(value.model || '') || fallback.model,
            reasoningEffort: String(value.reasoningEffort || '') || fallback.reasoningEffort,
          };
        }
      }
    } catch (error) {
      this.log('defaults.read.failed', { message: String((error && error.message) || error) });
    }
    return fallback;
  }

  /**
   * 组装一个会话的创建参数。
   *
   * @param {string} label - 机器人标签。
   * @param {boolean} collector - 是否收藏会话。
   * @param {object} bot - 该机器人的配置。
   * @returns {{sessionId: string, cwd: string, preset: string, options: object, collector: boolean}}
   */
  buildConfig(label, collector, bot) {
    const paths = this.getPaths() || {};
    const settings = this.getSettings() || {};
    const configuredCollectorCwd = String((settings && settings.collectorCwd) || '').trim();
    const collectorCwd = configuredCollectorCwd || paths.workspace || process.cwd();
    const chatCwd = String((settings && settings.chatCwd) || '').trim() || collectorCwd;

    // ⚠️ provider / model **必须有值**，不能留空。
    //
    // 它们不只是"路由偏好"：系统提示词里的 `{{provider}}` / `{{model}}` 就取自
    // `agent.options`（见 dsh-agent-loop 的 systemPrompt.variable 注册），
    // 而模板变量解析到 undefined 会让**整个提示词组装硬失败**：
    //   prompt variable "{{model}}" has no value for this assembly
    // 表现就是「每条消息都回一句无法生成内容」。
    //
    // 取值的优先级：机器人自己的设置 > 部署默认（agent-default-model）> 内置兜底。
    const defaults = this.deploymentDefaults();
    const provider = String((bot && bot.provider) || '').trim() || defaults.provider;
    const model = String((bot && bot.model) || '').trim() || defaults.model;
    const effort = String((bot && bot.reasoningEffort) || '').trim() || defaults.reasoningEffort;

    return {
      sessionId: this.sessionIdFor(label, collector, bot),
      cwd: collector ? collectorCwd : chatCwd,
      preset: collector ? this.collectorPreset : String((settings && settings.chatPreset) || 'cordis'),
      options: {
        provider,
        model,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
      collector,
    };
  }

  /**
   * 会话创建时的 setup 回调。
   *
   * @param {object} cfg - {@link buildConfig} 的结果。
   * @returns {Function} 交给 `agentLoop.createAgent/resume` 的 setup。
   */
  presetSetupFor(cfg) {
    return (agentCtx) => {
      // 企微是单向异步渠道：没有可交互的 UI 应答者。以 prepend 注册自动应答者，
      // 抢在客户端桥接之前认领 user-questions/request，避免追问永久挂起。
      try {
        if (agentCtx && typeof agentCtx.on === 'function') {
          agentCtx.on('user-questions/request', (request) => {
            const questions = (request && request.questions) || [];
            const guidance =
              '【企业微信渠道无法交互追问】本渠道没有可用的 UI 应答者。'
              + '请立即停止调用 ask_user_question：直接用你认为最合理的默认方案继续执行；'
              + '若确实需要用户拍板，就把问题与候选方案写进你的最终回复正文，用户会在下一条消息里回答。';
            return Promise.resolve({
              answers: questions.map((q) => ({ id: q.id, selected: [], custom: guidance })),
            });
          }, { prepend: true });
        }
      } catch (error) {
        this.log('answerer.failed', { message: String((error && error.message) || error) });
      }
      const presets = agentCtx.get ? agentCtx.get('agentPresets') : undefined;
      if (presets && typeof presets.mount === 'function') {
        return Promise.resolve(presets.mount(agentCtx, cfg.preset)).then(() => undefined);
      }
      return undefined;
    };
  }

  /**
   * 收藏会话提权：danger-full-access 让脚本能写真实 Vault，
   * approval=never 让任何仍需审批的操作**快速失败回执**而不是挂起。
   *
   * @param {object} cfg - 会话配置。
   * @param {object} agent - 已创建的 agent。
   * @param {object} sessions - sessions 服务。
   */
  applyCollectorPermissions(cfg, agent, sessions) {
    if (!cfg.collector) return;
    try {
      const permissionPresets = this.ctx && this.ctx.get ? this.ctx.get('permissionPresets') : undefined;
      const approval = this.ctx && this.ctx.get ? this.ctx.get('approval') : undefined;
      const session = (agent && agent.session)
        || (sessions && sessions.get ? sessions.get(cfg.sessionId) : undefined);
      if (permissionPresets && session) {
        permissionPresets.set(session, 'danger-full-access');
        this.log('permissions', { sessionId: cfg.sessionId, mode: 'danger-full-access' });
      }
      if (approval && agent) {
        approval.setPolicy(agent, 'never');
        this.log('approval', { sessionId: cfg.sessionId, policy: 'never' });
      }
    } catch (error) {
      this.log('permissions.failed', { message: String((error && error.message) || error) });
    }
  }

  /**
   * 取回（或创建）一个 Agent。
   *
   * @param {object} cfg - 会话配置。
   * @param {object} services - `{ agentLoop, agents, sessions }`。
   * @returns {Promise<object>} agent 实例。
   */
  async ensureAgentFor(cfg, services) {
    const { agentLoop, agents, sessions } = services;
    const live = agents && agents.get ? agents.get(cfg.sessionId) : undefined;
    if (live) return live;

    if (agentLoop && agentLoop.resume) {
      try {
        const handle = await agentLoop.resume(this.ctx, {
          resumeSessionId: cfg.sessionId,
          agentOptions: cfg.options,
          setup: this.presetSetupFor(cfg),
        });
        this.agents.set(cfg.sessionId, handle);
        this.log('agent.resumed', { sessionId: cfg.sessionId });
        this.applyCollectorPermissions(cfg, handle.agent, sessions);
        return handle.agent;
      } catch (error) {
        this.log('agent.resume.failed', { sessionId: cfg.sessionId, message: String((error && error.message) || error) });
      }
    }

    if (agentLoop && agentLoop.createAgent) {
      const handle = await agentLoop.createAgent(this.ctx, {
        sessionId: cfg.sessionId,
        meta: { cwd: cfg.cwd, agentPreset: cfg.preset },
        seed: [],
        agentOptions: cfg.options,
        setup: this.presetSetupFor(cfg),
      });
      this.agents.set(cfg.sessionId, handle);
      this.log('agent.created', { sessionId: cfg.sessionId, cwd: cfg.cwd, preset: cfg.preset });
      this.applyCollectorPermissions(cfg, handle.agent, sessions);
      return handle.agent;
    }

    throw new Error('agentLoop 不可用：无法创建会话');
  }

  /**
   * 跑一个回合并取回最终正文。
   *
   * 不能用 `agent.whenIdle()`：`followup` 刚入队、驱动尚未开跑时 agent 仍是
   * 空闲的，会立刻 resolve（原实现实测踩过）。只能轮询 live session 的事件，
   * 等本回合的 `turn/end`。
   *
   * @param {object} cfg - 会话配置。
   * @param {string} text - 用户正文。
   * @param {object} services - `{ agentLoop, agents, sessions }`。
   * @returns {Promise<{ok: boolean, text: string, reason: string}>} 回合结果。
   */
  async runTurn(cfg, text, services) {
    const agent = await this.ensureAgentFor(cfg, services);
    const session = agent.session;
    const readEvents = () => {
      if (!session || typeof session.snapshotEvents !== 'function') return null;
      try {
        const events = session.snapshotEvents();
        return Array.isArray(events) ? events : null;
      } catch {
        return null;
      }
    };

    const before = readEvents();
    const startSeq = before ? before.length - 1 : -1;
    const startTurn = before
      ? before.reduce((max, event) => (
        event && event.type === 'turn/start' && event.data && typeof event.data.turn === 'number'
          ? Math.max(max, event.data.turn)
          : max
      ), 0)
      : 0;

    agent.followup(makeUserMessage(text));
    this.log('turn.started', { sessionId: cfg.sessionId, len: String(text).length });

    const deadline = Date.now() + this.turnTimeoutMs;
    const collected = [];
    for (;;) {
      if (Date.now() > deadline) {
        this.log('turn.timeout', { sessionId: cfg.sessionId });
        try { agent.cancel({ kind: 'user' }); } catch { /* noop */ }
        return { ok: false, text: collected.join('\n'), reason: 'timeout' };
      }

      const events = readEvents();
      if (events && events.length > 0) {
        for (let i = Math.max(startSeq + 1, 0); i < events.length; i += 1) {
          const event = events[i];
          if (!event) continue;
          if (event.type === 'assistant/message') {
            const chunk = textOfMessage(event.data && event.data.message);
            if (chunk && !collected.includes(chunk)) collected.push(chunk);
          }
          if (event.type === 'turn/end' && event.data && event.data.turn > startTurn) {
            const kind = (event.data.reason && event.data.reason.kind) || 'end';
            const finalText = collected.length > 0 ? collected[collected.length - 1] : '';
            if (kind === 'error') {
              this.log('turn.error', { sessionId: cfg.sessionId, detail: event.data.reason && event.data.reason.error });
              return { ok: false, text: finalText, reason: 'error' };
            }
            if (kind === 'blocked' || kind === 'interrupted' || kind === 'aborted') {
              return { ok: false, text: finalText, reason: kind };
            }
            this.log('turn.end', { sessionId: cfg.sessionId, kind, answerLen: finalText.length });
            return { ok: finalText.length > 0, text: finalText, reason: kind };
          }
        }
      }
      await sleep(300);
    }
  }

  /** 同一会话串行执行，避免两条消息同时跑一个 agent。 */
  serialize(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  /**
   * 一条入站消息的完整处理：闸门 → 路由 → 排队 → 跑回合 → 返回正文。
   *
   * @param {object} input - `{ label, text, bot, services }`。
   * @returns {Promise<string>} 要回给用户的正文。
   */
  async handle(input) {
    const { label, text, bot, services } = input;
    const config = bot || {};

    // ── 闸门（decision order 的第一步）────────────────────────────────────
    // `policy: allowlist` 的机器人：未命中白名单就直接固定话术直回，
    // **不创建任何会话、不产生任何 agent 调用**。这是「不属于本企业但仍要
    // 接入」的机器人唯一的约束点 —— 企业侧限制不了它。
    if (String(config.policy || 'open') === 'allowlist') {
      if (!isAllowlisted(text, config.allowlist)) {
        this.log('gate.blocked', { label, reason: 'allowlist', len: String(text).length });
        return String(config.blockedReply || '该指令未对本机器人开放。');
      }
      this.log('gate.allowed', { label });
    }

    const collectEnabled = config.collectEnabled !== false;
    const isCollect = collectEnabled && isCollectorRequest(text);
    const cfg = this.buildConfig(label, isCollect, config);
    this.log('route', { sessionId: cfg.sessionId, collector: isCollect });

    const out = await this.serialize(cfg.sessionId, () => this.runTurn(cfg, text, services));
    const answer = out && out.text && out.text.trim() ? out.text.trim() : '';
    if (answer) return answer;
    return `抱歉，这次没有生成可回复的内容（原因：${(out && out.reason) || 'unknown'}）。请重试或换个问法。`;
  }

  /** 释放本编排器持有的全部 agent 句柄。 */
  async dispose() {
    for (const handle of this.agents.values()) {
      try { if (handle && typeof handle.dispose === 'function') await handle.dispose(); }
      catch { /* noop */ }
    }
    this.agents.clear();
    this.queues.clear();
  }
}
