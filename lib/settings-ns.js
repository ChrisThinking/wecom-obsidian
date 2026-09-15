/**
 * 设置 namespace：`wecom-obsidian`
 * ============================================================================
 * 本插件**唯一**的配置事实源。浏览器设置页读写它，Host 半边订阅它。
 *
 * 设计要点
 * --------
 * 1. 凭证不进磁盘上的第二份明文：设置服务本身把文档写在 `${DSH_HOME}` 下的
 *    0600 文件里（`settings.yaml`），与 `DSH_HOME` 同权限级；`secret` 字段额外
 *    声明 `role('secret')`，因此**永远不会**随 Remote 读数回传浏览器 ——
 *    设置页只拿得到一个 `{path, set}` 槽位，输入框按「只写」渲染。
 * 2. 路径规则是数据，不是代码：`store` 段决定入库布局。默认
 *    `顶层/年/月/标题`（用户要求的「年/月」）。改成 `{top}/{YYYY}/{name}`
 *    即退回按年布局。
 * 3. schema 走 schemastery 的 `toJSON()` 序列化后交给设置页，因此字段增删
 *    不需要同步改两份代码；设置页只负责渲染。
 */
import z from '@deepseek-ai/schemastery';

/** 本插件的设置 namespace 键。必须以连字符小写标识符形式出现。 */
export const SETTINGS_NS = 'wecom-obsidian';

/** 一个企业微信机器人的配置。 */
const BotSchema = z.object({
  /** 展示名，同时作为健康状态文件名与控制通道 label。 */
  label: z.string().default('机器人0号'),
  /** 是否启用这条长连接。 */
  enabled: z.boolean().default(true),
  /** 企微智能机器人 Bot ID。 */
  botId: z.string().default(''),
  /** 企微智能机器人 Secret（只写字段，不回传浏览器）。 */
  secret: z.string().role('secret').default(''),
  /** 普通对话会话 id（同一机器人长期复用，保证上下文连续）。 */
  sessionId: z.string().default(''),
  /** 收藏会话 id（收藏链路独立会话，避免污染聊天上下文）。 */
  collectorSessionId: z.string().default(''),
  /** 该机器人是否开放「收藏」能力。关闭后所有消息都只走普通对话。 */
  collectEnabled: z.boolean().default(true),
  /** 该机器人是否下载图片/文件到收件目录。 */
  mediaEnabled: z.boolean().default(true),
  /**
   * 放行策略：
   *   `open`      —— 除 deny 外全部放行到 agent（默认）
   *   `allowlist` —— 仅白名单消息进入 agent，其余固定话术直回、**不产生任何 agent 调用**
   *
   * 白名单模式用于「不属于本企业、但仍要接入」的机器人：企业侧限制不了它，
   * 只能在桥接这一层用闸门约束。
   */
  policy: z.string().default('open'),
  /**
   * `policy: allowlist` 时的白名单。逐条按**句首**锚定匹配（禁止子串匹配，
   * 否则「帮我收藏这个」会借「帮助」之类的词绕过闸门）。
   */
  allowlist: z.array(z.string()).default([]),
  /** 命中白名单之外的回复话术。 */
  blockedReply: z.string().default('该指令未对本机器人开放。'),
  /** 对话用的 provider / model / 推理强度，留空则跟随 DSH 默认。 */
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default('high'),
});

// DSH 的 path mutation 不能深入数组。配置页对单台机器人的改动写到这个
// 字符串索引对象中，Host 再覆盖合并到 bots[]；这样无需把其它 secret 回传
// 浏览器，也不会在保存第三台机器人时清掉前两台的凭证。
const BotOverrideSchema = z.object({
  label: z.string(),
  enabled: z.boolean(),
  botId: z.string(),
  secret: z.string().role('secret'),
  sessionId: z.string(),
  collectorSessionId: z.string(),
  collectEnabled: z.boolean(),
  mediaEnabled: z.boolean(),
  policy: z.string(),
  allowlist: z.array(z.string()),
  blockedReply: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
});

/**
 * 一条「机器人列表结构变更」意图（新增 / 删除）。
 *
 * 浏览器**不能**自己改 `bots[]`：数组无法被 path mutation 深入，而且从脱敏读数
 * 拼出来的 bots 会丢掉其余机器人的 secret。所以配置页只往 `botOps[]` 里追加一条
 * 意图（本对象不含任何密钥），宿主拿着未脱敏的原始段执行，再精确写回。
 */
const BotOpSchema = z.object({
  /** `add` 追加一台带默认值的新机器人；`remove` 删除 `index` 指向的那台。 */
  op: z.string().default(''),
  /** `remove` 的目标下标；`add` 由宿主按当前长度决定，此值仅作诊断。 */
  index: z.number().default(-1),
  /** 幂等标记：宿主消费时去重，避免同一条命令被重复执行。 */
  nonce: z.string().default(''),
});

/** 入库路径与命名规则。 */
const StoreSchema = z.object({
  /**
   * 入库相对路径模式。占位符：`{top}` 顶层目录、`{YYYY}` 年、`{MM}` 月、
   * `{platform}` 平台、`{name}` 笔记名。默认「年/月」。
   */
  folderPattern: z.string().default('{top}/{YYYY}/{MM}/{name}'),
  /** 顶层目录名（Obsidian 库内）。 */
  topFolder: z.string().default('01_文章分享'),
  /** 资产目录名（图片等随包资源）。 */
  assetsDir: z.string().default('assets'),
  /** 同名冲突时的后缀策略，`-2/-3` 递增。 */
  conflictSuffix: z.boolean().default(true),
});

/** 采集流水线运行参数。 */
const PipelineSchema = z.object({
  /** markitdown CLI 绝对路径，用于通用网页转换。留空则从 PATH 自动发现。 */
  markitdownCli: z.string().default(''),
  /** Python 解释器绝对路径，留空则从 PATH 自动发现 `python3`。 */
  pythonBin: z.string().default(''),
  /**
   * Python 第三方包目录（微信图文转换器需要的 beautifulsoup4）。
   * 留空则用插件数据目录下的 `pylibs`。
   */
  bs4Dir: z.string().default(''),
  /** 单篇转换的超时秒数。 */
  convertTimeoutSec: z.number().default(180),
  /** 整条收藏链（convert→format→store）的超时秒数。 */
  pipelineTimeoutSec: z.number().default(600),
  /** 媒体文件大小上限（MB）。 */
  mediaMaxMb: z.number().default(50),
});

/**
 * 完整设置 schema。
 *
 * `bots` 是数组 —— 一个元素 = 一条独立 wss 连接 + 独立会话，因此支持多个
 * 企业微信账号并存（原实现的三机器人矩阵即由此表达）。
 */
export const WecomObsidianSchema = z.object({
  /** 配置版本，便于将来迁移。 */
  version: z.number().default(1),
  /** 机器人列表。 */
  bots: z.array(BotSchema).default([]),
  /** 配置页针对 bots[] 元素的安全增量覆盖，键为数组下标字符串。 */
  botOverrides: z.dict(BotOverrideSchema).default({}),
  /**
   * 配置页提交的机器人结构变更意图队列（由宿主消费并清空）。
   *
   * 不动 `bots[]` 本身，是因为浏览器读不到 secret，也没有可用的数组深路径写入
   * （见 `lib/bot-ops.js` 顶部说明）。
   */
  botOps: z.array(BotOpSchema).default([]),
  /** Obsidian 库根目录（vault 绝对路径）。 */
  vaultRoot: z.string().default(''),
  /** 收藏内容/中间产物的工作目录；留空则用插件数据目录。 */
  workspaceRoot: z.string().default(''),
  /** 普通对话会话的工作目录（cwd）；留空则同收藏工作目录。 */
  chatCwd: z.string().default(''),
  /** 普通对话会话使用的 Agent 预设 id。 */
  chatPreset: z.string().default('cordis'),
  /** 收藏会话的工作目录（cwd）；留空则用收藏工作目录。 */
  collectorCwd: z.string().default(''),
  /**
   * 媒体收件目录（企微发来的图片/文件落盘位置）。
   *
   * 留空 = `<库根>/<顶层目录>/attachments`（推荐，媒体与笔记同在 Obsidian 库内）。
   * 占位符：`{top}` 收藏主目录 · `{vault}` 库根 · `{workspace}` 插件工作区。
   */
  inboxDir: z.string().default('{top}/attachments'),
  /** 入库路径与命名。 */
  store: StoreSchema.default({}),
  /** 流水线运行参数。 */
  pipeline: PipelineSchema.default({}),
  /** 桥接行为：是否在收到媒体消息时自动回复说明。 */
  replyAck: z.boolean().default(true),
});

/**
 * 用 `base` 层给 schema 一个**部署默认值**：设置页里没被用户写过的字段
 * 走 schema 默认，用户一改就落到 user 层（`user` 里出现即代表「已覆盖」）。
 *
 * @param {object} overrides - 由安装脚本/环境推导出的默认值。
 * @returns {object} composition base 层。
 */
export function baseLayer(overrides = {}) {
  const base = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && value !== null && value !== '') base[key] = value;
  }
  return base;
}
