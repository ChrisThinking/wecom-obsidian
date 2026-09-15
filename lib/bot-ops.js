import crypto from 'node:crypto';

/**
 * 机器人列表的**结构变更**逻辑（新增 / 删除）——纯函数，宿主与测试共用。
 * ============================================================================
 * 为什么这部分必须留在宿主、而不能在浏览器里做：
 *
 *   `botId` / `secret` 是 `role('secret')` 字段，DSH 设置服务的**每一次 Remote
 *   读数都会脱敏**（`settings.describe({redactSecrets:true})`），浏览器拿到的
 *   `bots[]` 与 `botOverrides{}` 里**根本没有 secret 键**，只有一个 `{path,set}`
 *   侧车。因此「把浏览器读到的 bots 整体写回」必然抹掉其余机器人的 Secret。
 *
 *   另外 DSH 的 path mutation **不能深入数组**：`applyPathOp` 对非 plain-object
 *   的子节点（数组）会整段替换，`{op:'set', path:['bots','0']}` 会把 bots 变成
 *   对象 `{"0":…}`，随即被 `z.array(BotSchema)` 拒绝（实测报
 *   `$.bots expected array but got [object Object]`）。
 *
 * 所以：浏览器只提交一条「意图」（`botOps[]`，不含任何密钥），宿主拿着**未脱敏**
 * 的原始 user 段执行结构变更，再用 `scope.replace()` 精确写回。secret 既不会被
 * 读出浏览器，也不会被整体覆盖。
 *
 * 增删都要同步重排 `botOverrides` 的下标键：它按数组下标存，删除中间一项后不
 * 重排，覆盖会整体错位 —— 等于把 A 的凭证套到 B 身上（本仓库真实踩过的坑）。
 */

/**
 * 机器人名称 → 会话 id 用的稳定 slug。
 *
 * 这是 `client/client.js` 里 `slugOf` 的宿主侧镜像（客户端 bundle 无法 import
 * 宿主模块，只能各自保留一份，改动时必须同步）。它只负责会话 id 的**可读前缀**，
 * 唯一性由 `newSessionToken()` 的随机后缀保证（见 `defaultBotConfig`）。
 *
 * 注意与 `wecom-client.js` 的 `labelSlug` 不是同一个东西：后者用于健康状态
 * 文件名/控制通道，保留 `-<序号>` 后缀，两者不可互换。
 *
 * @param {string} label - 机器人名称。
 * @param {number} index - 从 1 开始的序号。
 * @returns {string} 可用作会话 id 的片段。
 */
export function slugOf(label, index) {
  const ascii = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return ascii || `bot${index}`;
}

/**
 * 为一台**新**机器人生成一次性的会话身份后缀。
 *
 * 会话 id 必须「一台机器人一个，且**永不复用**」：路由按 sessionId 恢复历史会话
 * （`CollectorRouter.ensureAgentFor` → `agentLoop.resume({ resumeSessionId })`）。
 * 复用展示编号（机器人2）没问题，但复用会话 id 会让「删掉一台再新增」拿到旧 id ——
 * 新机器人若换成另一家企业微信账号，开场就带着上一个账号的历史上下文。
 */
export function newSessionToken() {
  return crypto.randomBytes(3).toString('hex');
}

/**
 * 一台新机器人的完整默认配置（除名称/Bot ID/Secret 外全部自动推断）。
 *
 * 写进配置而不是运行时兜底，是为了让 settings.yaml 自己就是一份完整、可读、
 * 可手改的真值。
 *
 * **展示编号与会话身份分开**：`label`/序号可以复用（删中间一台后补位符合直觉），
 * 但 `sessionId` / `collectorSessionId` 一定带随机 token，永不复用。
 *
 * @param {number} index - 从 1 开始的序号（仅用于展示名与可读前缀）。
 * @param {string} [token] - 身份后缀；测试里显式传入以便两端同形断言。
 * @returns {object} 完整 bot 配置（secret 为空，等用户在设置页填写）。
 */
export function defaultBotConfig(index, token) {
  const label = `机器人${index}`;
  const slug = slugOf(label, index);
  const id = String(token || newSessionToken());
  return {
    label,
    enabled: true,
    botId: '',
    secret: '',
    sessionId: `wecom-${slug}-${id}`,
    collectorSessionId: `wecom-${slug}-${id}-collector`,
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

/**
 * 收集现有机器人已占用的展示名。
 *
 * 只关心 `label`：会话 id 现在带随机 token（`defaultBotConfig`），天然唯一；
 * 需要保证不撞车的只剩「机器人N」这个给人看的编号。
 *
 * @param {Array} bots - 现有机器人（原始段，字段可能不全）。
 * @returns {Set<string>} 已占用的展示名。
 */
function usedLabels(bots) {
  const labels = new Set();
  for (const item of Array.isArray(bots) ? bots : []) {
    const bot = item && typeof item === 'object' ? item : {};
    if (bot.label) labels.add(String(bot.label));
  }
  return labels;
}

/**
 * 为「新增机器人」挑一个**未被占用**的展示编号。
 *
 * 为什么不能用 `bots.length + 1`：删除中间一台后数组长度与现有编号就错位了 ——
 * 三台（机器人1/2/3）删掉第二台剩两台，`length + 1` 又是 3 → 新增出第二台
 * 「机器人3」，两台机器人重名（会话 id 已由 token 保证不同，但设置页会撞脸）。
 *
 * 取「最小空闲编号」让显示回到被删掉的位置（符合直觉）。它只决定**展示名**：
 * 会话身份由 `defaultBotConfig` 的随机 token 负责，绝不复用旧的 sessionId。
 *
 * @param {Array} bots - 现有机器人。
 * @returns {number} 可用的展示编号（从 1 开始）。
 */
export function nextBotIndex(bots) {
  const list = Array.isArray(bots) ? bots : [];
  const labels = usedLabels(list);
  const limit = list.length + 2;
  for (let n = 1; n <= limit; n += 1) {
    if (!labels.has(`机器人${n}`)) return n;
  }
  return limit + 1;
}

/**
 * 删除某台机器人后，重排覆盖表的键，使其与新的 `bots` 下标继续对齐。
 *
 * `botOverrides` 按**下标字符串**存键，所以删掉中间一台后不同步重排，覆盖就会
 * 整体错位：原本属于第 1 台的凭证/策略会套到新的第 0 台上（本仓库真实踩过的坑）。
 *
 * @param {object|undefined} overrides - 现有覆盖表（键为下标字符串）。
 * @param {number} removedIndex - 被删除的下标。
 * @returns {object} 重排后的覆盖表。
 */
export function reindexOverridesAfterRemove(overrides, removedIndex) {
  const src = (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) ? overrides : {};
  const next = {};
  for (const [key, val] of Object.entries(src)) {
    const i = Number(key);
    if (!Number.isInteger(i) || i === removedIndex) continue;
    next[String(i > removedIndex ? i - 1 : i)] = val;
  }
  return next;
}

/**
 * 对**未脱敏**的机器人状态执行一条结构变更，返回新的 `{bots, botOverrides}`。
 *
 * 传入的 `bots` / `botOverrides` 必须是宿主侧读到的原始值（含 secret）：函数
 * 只移动、只追加、只删除，不理解也不改写单个字段，因此任何密钥都原样保留。
 *
 * 新增位置由函数自己按 `bots.length` 决定（不信任调用方给的 index）：
 * 命令在队列里排队期间列表可能已经变了，用调用方的下标会把新机器人插错位置。
 *
 * @param {{bots?: Array, botOverrides?: object}} state - 当前原始状态。
 * @param {string} op - `'add'` 或 `'remove'`。
 * @param {number} [index] - `remove` 的目标下标。
 * @returns {{bots: Array, botOverrides: object}} 新状态（原对象不被修改）。
 * @throws {Error} 操作未知或下标越界时抛出（调用方负责记录并丢弃该命令）。
 */
export function applyBotOp(state, op, index) {
  const src = state && typeof state === 'object' ? state : {};
  const bots = Array.isArray(src.bots) ? src.bots : [];
  const overrides = (src.botOverrides && typeof src.botOverrides === 'object' && !Array.isArray(src.botOverrides))
    ? { ...src.botOverrides }
    : {};

  if (op === 'add') {
    const at = bots.length;
    // 序号取「最小空闲」，**不能**用 at + 1：删除中间一台后长度与编号错位，
    // 会新增出与既有机器人同名的会话 id（两台机器人共用上下文）。
    const nextBots = [...bots, defaultBotConfig(nextBotIndex(bots))];
    // 「删掉又新增」不能继承上一个机器人的覆盖（含凭证/策略），所以清掉该下标。
    delete overrides[String(at)];
    return { bots: nextBots, botOverrides: overrides };
  }

  if (op === 'remove') {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= bots.length) {
      throw new Error(`removeBot 下标越界: ${String(index)}（当前 ${bots.length} 台）`);
    }
    return {
      bots: bots.filter((_, k) => k !== i),
      botOverrides: reindexOverridesAfterRemove(overrides, i),
    };
  }

  throw new Error(`未知的机器人操作: ${String(op)}`);
}

/**
 * 依次消费一批结构变更命令，返回最终状态。
 *
 * 单条命令失败（下标越界 / 未知操作）只丢弃该条并记录，不影响其余命令 ——
 * 否则一条坏命令会让整个机器人列表永久卡住。
 *
 * @param {{bots?: Array, botOverrides?: object}} state - 当前原始状态。
 * @param {Array<{op?: string, index?: number}>} queued - 待执行命令。
 * @param {(event: string, extra?: object) => void} [onLog] - 失败记录回调。
 * @returns {{bots: Array, botOverrides: object, applied: number, failed: number}}
 */
export function applyBotOps(state, queued, onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const list = Array.isArray(queued) ? queued : [];
  let current = state && typeof state === 'object' ? state : {};
  let applied = 0;
  let failed = 0;
  for (const item of list) {
    const op = String((item && item.op) || '');
    try {
      current = applyBotOp(current, op, item && item.index);
      applied += 1;
    } catch (error) {
      failed += 1;
      log('botOp.failed', { op, index: item && item.index, message: String((error && error.message) || error) });
    }
  }
  return { ...current, applied, failed };
}

/**
 * 消费设置里的 `botOps[]` 意图队列，并把结果精确写回。
 *
 * 依赖以三个回调注入，宿主与测试传同一套语义：
 *   · `readUserSection()` —— 读**未脱敏**原始 user 段（宿主用
 *     `ctx.settings.describe()`，测试用真实 `SettingsProvider.describe()`）；
 *   · `replace(section)`  —— 整段替换（`update` 的合并语义删不掉字典键）；
 *   · `isDisposed()`      —— 已拆解时不再写入。
 *
 * 写回用 `replace` 而非 `update`：删除机器人要重排 `botOverrides[]` 的下标键，
 * 合并语义无法删除越界的旧键，会把凭证留在错误的下标上。写回内容以原始 user 段
 * 为基线，因此除 `bots`/`botOverrides`/`botOps` 外的字段与**全部 secret**原样保留。
 *
 * @param {{readUserSection: Function, replace: Function, isDisposed?: Function}} deps - 读写通道。
 * @param {object} settings - 当前已解析设置（含 `botOps[]`）。
 * @param {(event: string, extra?: object) => void} [onLog] - 结构化日志。
 * @returns {Promise<boolean>} 是否消费了命令（队列非空且未被拆解）。
 */
export async function consumeBotOps(deps, settings, onLog) {
  const log = typeof onLog === 'function' ? onLog : () => {};
  const {
    readUserSection,
    replace,
    isDisposed = () => false,
    lastNonceRef,
  } = deps || {};
  const queued = Array.isArray(settings && settings.botOps) ? settings.botOps : [];
  if (queued.length === 0) return false;
  if (isDisposed()) return false;

  const previousNonce = lastNonceRef && typeof lastNonceRef === 'object' ? String(lastNonceRef.value || '') : '';
  const pending = queued.filter((item) => {
    const nonce = String((item && item.nonce) || '');
    return !nonce || nonce !== previousNonce;
  });
  if (pending.length === 0) {
    // 队列里全是已消费过的命令（重复投递 / 重启回放）：清掉即可。
    try { await replace({ ...readUserSection(), botOps: [] }); }
    catch (error) { log('botOps.clear.failed', { message: String((error && error.message) || error) }); }
    return true;
  }

  const user = readUserSection();
  const result = applyBotOps({ bots: user.bots, botOverrides: user.botOverrides }, pending, log);
  if (lastNonceRef && typeof lastNonceRef === 'object') {
    for (const item of pending) {
      const nonce = String((item && item.nonce) || '');
      if (nonce) lastNonceRef.value = nonce;
    }
  }

  try {
    await replace({
      ...user,
      bots: result.bots,
      botOverrides: result.botOverrides,
      // 清空队列：命令只执行一次，写回后即使宿主重启也不会重放。
      botOps: [],
    });
    log('botOps.applied', {
      applied: result.applied,
      failed: result.failed,
      bots: Array.isArray(result.bots) ? result.bots.length : 0,
    });
  } catch (error) {
    log('botOps.write.failed', { message: String((error && error.message) || error) });
    try {
      await replace({ ...user, botOps: [] });
    } catch (retryError) {
      log('botOps.clear.failed', { message: String((retryError && retryError.message) || retryError) });
    }
  }
  return true;
}
