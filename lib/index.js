/**
 * dsh-wecom-obsidian —— Host 半边
 * ============================================================================
 * 把「企业微信机器人收藏网址 → Obsidian」整条链路封装成一个 DSH 插件：
 *
 *   设置 namespace `wecom-obsidian`
 *        ↕（浏览器设置页读写，secret 字段只写不回传）
 *   本插件 apply()
 *        ├─ 物化工作区：把设置写成流水线读取的 config/*.json，并落位脚本骨架
 *        ├─ 注册 shell 环境变量：让收藏会话里的 bash 直接知道工作区与 vault 位置
 *        └─ 按 bots[] 起停企微长连接实例（每个机器人一条 wss + 两条会话线）
 *
 * 关键形态决策
 * ------------
 * * **配置只有一份**：设置 namespace。旧实现里 `wecom-bots.json` 是矩阵事实源、
 *   凭证在 0600 的 env 文件、工作区另有一份 `obsidian.json` —— 三处要同步。
 *   这里把三者收敛成「设置 → 物化」，物化产物是可随时重建的派生物。
 * * **脚本零改动**：流水线脚本本来就读 `OBS_WS_ROOT` / `OBS_VAULT_ROOT` /
 *   `OBS_LEDGER_FILE`，所以插件不去改 Python，只把工作区准备好、把环境指对。
 * * **agent / skill 一起封装**：收藏预设与三 Skill 随插件分发，安装脚本把预设
 *   装进 `${DSH_HOME}/.agent-presets/`，模型因此天然具备收藏能力。
 *
 * 生命周期纪律（这里出错会让 DSH 直接起不来，故显式约束）
 * ------------------------------------------------------
 * * `apply()` 里只做**不会抛出**的注册；任何一处失败都降级为日志。
 * * `ctx.effect()` 的清理函数必须是**同步**的：异步拆解在里面 fire-and-forget，
 *   并用世代号判断「还要不要继续」，避免旧世代收尾时把新世代拆掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { WecomBot, labelSlug } from './wecom-client.js';
import { CollectorRouter } from './session-router.js';
import { SETTINGS_NS, WecomObsidianSchema } from './settings-ns.js';
import { dataRoot, materialize, workspaceRoot } from './workspace.js';

/** 插件标识，用于日志与服务归属。 */
export const name = 'wecom-obsidian';

/**
 * 硬依赖：会话创建、机器人实例检索、设置读写、shell 环境注册。
 *
 * `shellEnv` 也必须是硬依赖：它是**宿主 composition** 里的注册表
 * （`dsh-bash-local` / `dsh-bash-sandbox` 与 `dsh-tool-bash` 都消费它），
 * 而且是 Cordis 的受限服务 —— 未在 `inject` 中声明就读会直接抛
 * `cannot get property "shellEnv" without inject`。
 */
export const inject = ['agentLoop', 'agents', 'settings', 'shellEnv'];

/** 收藏会话使用的 Agent 预设 id（由安装脚本装到 `.agent-presets/`）。 */
const COLLECTOR_PRESET = 'wecom-obsidian-collector';

/**
 * 单例守卫（进程级）。
 *
 * 为什么需要它：本包是**双面包** —— `package.json` 同时声明 `dsh.bundle`
 * （宿主入口行）与 `dsh.client`（浏览器入口）。DSH 的客户端模块系统会为每个
 * 声明 `dsh.client` 的包再派生一个 `ui-<id>` 装载入口，而这个派生入口的模块
 * 解析**落回本包的宿主入口**（`main`），于是 `apply()` 会在同一个进程里被调用
 * 两次。第二次会撞上「settings namespace 已注册」并把整棵插件树打挂。
 *
 * 所以：同一个进程内只允许一次真正的 apply。第二次直接短路（仍然返回一个
 * 空的清理函数，保持 `ctx.effect` 的既有语义）。
 *
 * 这是防御性设计，不依赖「派生入口一定指向 main」这一实现细节：即使将来 DSH
 * 改成只调用一次，守卫也只是不生效而已。
 */
let applied = false;

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件 Context。
 */
export function apply(ctx) {
  // 日志走 console：DSH 把插件进程的 stdout/stderr 收进 launchd 日志，
  // 而 ctx.logger 在部分宿主配置下不落盘，排障时会看不到插件自己在说什么。
  const log = (event, extra) => {
    const line = `[wecom-obsidian] ${JSON.stringify({ t: new Date().toISOString(), ev: event, ...(extra || {}) })}`;
    if (String(event).includes('failed') || String(event).includes('error')) console.error(line);
    else console.log(line);
  };

  if (applied) {
    log('apply.skipped', { reason: '同一进程内已 apply 过（双面包派生的第二个装载入口）' });
    return;
  }
  applied = true;

  try {
    applyOnce(ctx, log);
  } catch (error) {
    // 失败时释放守卫：让另一个装载入口（或下一次 reload）有机会重试，
    // 而不是把一个「注册到一半」的坏状态固定下来。
    applied = false;
    log('apply.error', {
      message: String((error && error.message) || error),
      stack: String((error && error.stack) || '').split('\n').slice(0, 6).join(' | '),
    });
    throw error;
  }
}

/**
 * 真正的装配逻辑，只允许执行一次。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件 Context。
 * @param {(event: string, extra?: object) => void} log - 结构化日志。
 */
function applyOnce(ctx, log) {

  // ── 0. 运行时目录 ─────────────────────────────────────────────────────────
  const dirs = {
    healthDir: path.join(dataRoot(), 'health'),
    controlDir: path.join(dataRoot(), 'control'),
  };
  try {
    for (const dir of [dirs.healthDir, dirs.controlDir, path.join(dataRoot(), 'logs')]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (error) {
    log('dirs.failed', { message: String((error && error.message) || error) });
  }

  // ── 1. 注册设置 namespace ─────────────────────────────────────────────────
  // 不传 base：schema 默认值就够，用户第一次改动即落到 user 层，
  // 从而能区分「没配过」与「配成了空」。
  //
  // 这里**不允许**抛错：注册失败（同名已被注册）会把整棵插件树打挂、DSH 起不来。
  // 正常形态下本插件只被装载一次；但双面包（dsh.bundle + dsh.client）在某些
  // 组合下可能派生出第二个装载入口，因此这里做一次防御：发现已注册就复用，
  // 让插件降级为「只注册一次」，而不是让宿主启动失败。
  let scope;
  try {
    scope = ctx.settings.register(SETTINGS_NS, WecomObsidianSchema, { applies: 'live' });
  } catch (error) {
    const message = String((error && error.message) || error);
    if (!message.includes('already registered')) throw error;
    log('settings.already-registered', { message, note: '复用已注册的 scope，跳过重复注册' });
    scope = {
      get: () => ctx.settings.get(SETTINGS_NS),
      watch: () => () => {},
      update: (patch) => ctx.settings.update(SETTINGS_NS, patch),
      replace: (section) => ctx.settings.replace(SETTINGS_NS, section),
    };
  }

  const readSettings = () => {
    try {
      const value = scope.get();
      if (!value || typeof value !== 'object') return {};
      const overrides = value.botOverrides && typeof value.botOverrides === 'object'
        ? value.botOverrides
        : {};
      const bots = Array.isArray(value.bots)
        ? value.bots.map((bot, index) => ({ ...(bot || {}), ...(overrides[String(index)] || {}) }))
        : [];
      return { ...value, bots };
    } catch (error) {
      log('settings.read.failed', { message: String((error && error.message) || error) });
      return {};
    }
  };

  // ── 2. 工作区物化 ─────────────────────────────────────────────────────────
  /** 最近一次物化的路径集合；永远指向一个可用对象。 */
  let paths = {
    workspace: '',
    vaultEnvRoot: '',
    inbox: '',
    ledgerFile: '',
    scriptsDir: '',
  };

  const refreshPaths = (settings) => {
    try {
      paths = materialize(settings);
    } catch (error) {
      log('workspace.materialize.failed', { message: String((error && error.message) || error) });
      const fallbackWorkspace = workspaceRoot(settings);
      paths = {
        workspace: fallbackWorkspace,
        vaultEnvRoot: String((settings && settings.vaultRoot) || ''),
        inbox: path.join(fallbackWorkspace, 'staging', 'inbox'),
        ledgerFile: path.join(fallbackWorkspace, 'logs', 'state', 'processed-urls.jsonl'),
        scriptsDir: path.join(fallbackWorkspace, 'scripts'),
      };
    }
    log('workspace.ready', {
      workspace: paths.workspace,
      vault: paths.vaultEnvRoot,
      bots: Array.isArray(settings.bots) ? settings.bots.length : 0,
    });
    return paths;
  };

  refreshPaths(readSettings());

  // ── 3. shell 环境变量 ─────────────────────────────────────────────────────
  // 注册进 shellEnv，模型在收藏会话里执行 bash 时即可直接使用这些名字；
  // 也让运维能从命令行复现同一条链路。
  //
  // 契约（`BashEnvContributor`）：
  //   { name, variables: { KEY: { description } }, resolve(execution) => { KEY: string } }
  //
  // 注意：`resolve` 是**贡献者级的一个函数**，不是每个变量各带一个 resolve。
  // 写错会让 `collect()` 在每次 shell 调用时抛 `contributor.resolve is not a function`，
  // 从而把整个 bash 工具打挂 —— 这个坑已踩过一次。
  try {
    ctx.shellEnv.register({
      name: 'wecom-obsidian',
      variables: {
        DSH_WECOM_OBS_WS: { description: 'wecom-obsidian 收藏流水线工作区根（脚本以 OBS_WS_ROOT 使用它）' },
        DSH_WECOM_OBS_VAULT: { description: 'wecom-obsidian 收藏链路的 vault 根（年/月由脚本拼在其后）' },
        DSH_WECOM_OBS_LEDGER: { description: 'wecom-obsidian 收藏去重账本（processed-urls.jsonl）' },
      },
      resolve: () => ({
        DSH_WECOM_OBS_WS: paths.workspace || '',
        DSH_WECOM_OBS_VAULT: paths.vaultEnvRoot || '',
        DSH_WECOM_OBS_LEDGER: paths.ledgerFile || '',
      }),
    });
  } catch (error) {
    log('shellEnv.register.failed', { message: String((error && error.message) || error) });
  }

  /** 为「有意未启用 / 启动失败」的机器人落一份状态，便于运维区分原因。 */
  const writeDisabledHealth = (slug, label, reason) => {
    try {
      fs.writeFileSync(path.join(dirs.healthDir, `${slug}.json`), JSON.stringify({
        label, slug, pid: process.pid, state: 'disabled', reason, lastHeartbeat: 0, updatedAt: Date.now(),
      }, null, 2));
    } catch (error) {
      log('health.disabled.failed', { label, message: String((error && error.message) || error) });
    }
  };

  // ── 4. 机器人实例管理 ─────────────────────────────────────────────────────
  /** @type {Array<{label: string, instance: object, router: object, config: object}>} */
  let running = [];
  /** 世代号：只有最新世代的收尾/启动结果被采纳，避免并发 reconcile 互相拆台。 */
  let generation = 0;
  let disposed = false;

  const stopBot = async (bot, reason) => {
    try { if (bot.router) await bot.router.dispose(); }
    catch (error) { log('router.dispose.failed', { label: bot.label, message: String((error && error.message) || error) }); }
    try { await bot.instance.dispose(); }
    catch (error) { log('instance.dispose.failed', { label: bot.label, message: String((error && error.message) || error) }); }
    log('bot.stopped', { label: bot.label, reason });
  };

  /**
   * 起一个机器人实例。缺凭证 / SDK 缺失 / 连接异常都只记日志，
   * 不影响其它机器人，更不能让插件整体失败。
   */
  const startBot = (label, slug, botConfig, settings) => {
    const services = {
      agentLoop: ctx.agentLoop,
      agents: ctx.agents,
      sessions: ctx.get ? ctx.get('sessions') : undefined,
    };

    const router = new CollectorRouter({
      getSettings: readSettings,
      getPaths: () => paths,
      onLog: (entry) => log('bot', { label, ...entry }),
      turnTimeoutMs: Number((settings.pipeline && settings.pipeline.pipelineTimeoutSec) || 600) * 1000,
    }).bind(ctx);
    router.collectorPreset = COLLECTOR_PRESET;
    // 部署默认模型路由的来源：未单独指定模型的机器人跟随它，
    // 保证提示词里的 {{provider}}/{{model}} 永远解析得出值。
    router.settingsService = ctx.settings;

    const instance = new WecomBot({
      label,
      slug,
      botId: botConfig.botId,
      secret: botConfig.secret,
      paths: { ...dirs, inboxDir: paths.inbox },
      mediaMaxMb: Number((settings.pipeline && settings.pipeline.mediaMaxMb) || 50),
      onLog: (entry) => log('channel', { label, ...entry }),
      onMessage: ({ text }) => router.handle({ label, text, bot: botConfig, services }),
    });

    instance.start();
    return { label, slug, instance, router, config: botConfig };
  };

  /** 按当前设置全量对齐实例集合。 */
  const reconcile = () => {
    const myGeneration = ++generation;
    const settings = readSettings();
    refreshPaths(settings);

    void (async () => {
      const previous = running;
      running = [];
      for (const bot of previous) await stopBot(bot, 'reconcile');
      if (disposed || myGeneration !== generation) return;

      const bots = Array.isArray(settings.bots) ? settings.bots : [];
      for (const [index, bot] of bots.entries()) {
        const label = String(bot.label || `bot${index + 1}`).trim() || `bot${index + 1}`;
        // slug 带序号，保证健康文件/控制通道名唯一（中文名归一后会撞车）。
        const slug = labelSlug(label, index + 1);
        if (bot.enabled === false) {
          log('bot.disabled', { label, slug });
          writeDisabledHealth(slug, label, '在设置中停用');
          continue;
        }
        if (!bot.botId || !bot.secret) {
          log('bot.skipped', { label, slug, reason: '缺少 Bot ID 或 Secret' });
          writeDisabledHealth(slug, label, '缺少 Bot ID 或 Secret');
          continue;
        }
        try {
          running.push(startBot(label, slug, bot, settings));
        } catch (error) {
          const message = String((error && error.message) || error);
          log('bot.start.failed', { label, slug, message });
          writeDisabledHealth(slug, label, message);
        }
      }
      log('reconciled', { started: running.map((item) => item.slug) });
    })();
  };

  // 订阅设置变更：任何一次提交都可能改了凭证/路径/机器人列表，
  // 全量 reconcile 是最简单也最不容易漏的收敛方式。
  try {
    ctx.effect(() => scope.watch(() => {
      log('settings.changed');
      reconcile();
    }), 'wecom-obsidian: settings reconcile');
  } catch (error) {
    log('watch.failed', { message: String((error && error.message) || error) });
  }

  // 生命周期：清理函数必须同步；异步拆解在内部自行推进。
  ctx.effect(() => () => {
    disposed = true;
    generation += 1;
    const previous = running;
    running = [];
    void (async () => {
      for (const bot of previous) await stopBot(bot, 'dispose');
    })();
  }, 'wecom-obsidian: dispose bots');

  // 首次启动
  reconcile();

  log('applied', {
    settingsNs: SETTINGS_NS,
    dataRoot: dataRoot(),
    workspace: paths.workspace,
    collectorPreset: COLLECTOR_PRESET,
  });
}
