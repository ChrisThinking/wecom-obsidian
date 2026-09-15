#!/usr/bin/env bash
# ============================================================================
# 从旧版企微桥接迁移配置到 dsh-wecom-obsidian 的设置 namespace
# ----------------------------------------------------------------------------
# 迁移来源（旧实现的三处分散配置）：
#   1. ${WECOM_ENV_FILE}（0600 的 KEY=VALUE 文件；默认按常见位置自动探测）
#        → 各机器人的 Bot ID / Secret
#   2. <obsidian工作区>/config/wecom-bots.json（能力矩阵）
#        → 会话 id、收藏会话 id、能力开关、放行策略与白名单、独立 cwd/inbox
#   3. <obsidian工作区>/config/obsidian.json + runtime.json
#        → vault 根、存储路径规则、顶层目录、assets 目录、markitdown CLI
#
# 用法：
#   bash install/migrate-legacy-config.sh            # 迁移并打印结果（密钥打码）
#   bash install/migrate-legacy-config.sh --dry-run  # 只看将要写入什么
#
# 安全性：脚本本身**不写** settings.yaml。它把「迁移计划」算出来交给
# `dsh` 侧的设置服务写入（见文件末尾打印的可执行片段），因此：
#   · 密钥只经 0600 环境文件 → 0600 设置文档，不经过命令行、不进日志；
#   · 写入前由 schema 校验，字段名写错会当场被拒；
#   · 已有用户改动不会被覆盖（只 merge 缺失/空值字段）。
#
# 这是**参考实现 + 计划生成器**。真正的写入由 install/apply-plan.mjs 执行，
# 它需要一个能访问 ctx.settings 的进程（DSH 宿主）。
# ============================================================================
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# 旧凭证文件位置：显式指定 > 常见位置探测 > 放弃（并提示）
if [ -z "${WECOM_ENV_FILE:-}" ]; then
  for cand in \
    "$DSH_HOME/../wecom-bot.env" \
    "$HOME/.dsh/wecom-bot.env" \
    "$HOME/wecom-bot.env"
  do
    if [ -f "$cand" ]; then WECOM_ENV_FILE="$cand"; break; fi
  done
fi
WECOM_ENV_FILE="${WECOM_ENV_FILE:-$HOME/wecom-bot.env}"
# 旧工作区名随部署而变（历史上是 <DSH_HOME>/workspaces/<名字>）；默认给一个中性值，
# 实际路径不同请用 OBS_WORKSPACE 指定（找不到时会告警并提示）。
OBS_WS="${OBS_WORKSPACE:-$DSH_HOME/workspaces/obsidian}"

say()  { printf '\033[1;36m[migrate]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

say "插件目录     ：$PLUGIN_DIR"
say "环境文件     ：$WECOM_ENV_FILE"
say "旧工作区     ：$OBS_WS"

[ -f "$WECOM_ENV_FILE" ] || warn "找不到旧凭证文件 ${WECOM_ENV_FILE}（可设 WECOM_ENV_FILE 指定）"
[ -d "$OBS_WS" ] || warn "找不到旧工作区 ${OBS_WS}（可设 OBS_WORKSPACE 指定）"

# 把计划交给 node 计算（YAML/JSON 解析用 node 更稳，且不引额外依赖）。
node - "$PLUGIN_DIR" "$DSH_HOME" "$WECOM_ENV_FILE" "$OBS_WS" "$DRY" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [pluginDir, dshHome, envFile, obsWs, dryFlag] = process.argv.slice(2);
const dry = dryFlag === '1';

/** 读 0600 的 KEY=VALUE 环境文件；绝不打印值。 */
function readEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch (error) {
    console.error(`  ! 无法读取环境文件：${error.message}`);
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const env = readEnvFile(envFile);
const matrix = readJson(path.join(obsWs, 'config', 'wecom-bots.json'));
const obsidian = readJson(path.join(obsWs, 'config', 'obsidian.json'));
const runtime = readJson(path.join(obsWs, 'config', 'runtime.json'));

const mask = (v) => (v ? `已设置(${String(v).length}字符)` : '缺失');

// ── 机器人 ────────────────────────────────────────────────────────────────
const bots = [];
if (matrix && matrix.bots) {
  for (const [key, row] of Object.entries(matrix.bots)) {
    const idEnv = (row.env && row.env.botId) || '';
    const secretEnv = (row.env && row.env.secret) || '';
    const botId = env[idEnv] || '';
    const secret = env[secretEnv] || '';
    const caps = Array.isArray(row.capabilities) ? row.capabilities : [];
    bots.push({
      label: row.alias || key,
      enabled: Boolean(botId && secret),
      botId,
      secret,
      sessionId: row.sessionId || '',
      collectorSessionId: row.collectorSessionId || '',
      collectEnabled: caps.includes('collect'),
      mediaEnabled: caps.includes('media'),
      policy: row.policy || 'open',
      allowlist: Array.isArray(row.allowlist) ? row.allowlist.slice() : [],
      blockedReply: (matrix.defaults && matrix.defaults.blockedReply) || '该指令未对本机器人开放。',
      provider: '',
      model: '',
      reasoningEffort: 'high',
      _srcKey: key,
      _idEnv: idEnv,
      _secretEnv: secretEnv,
    });
  }
} else {
  console.error('  ! 读不到能力矩阵，跳过机器人迁移');
}

// ── 路径与规则 ────────────────────────────────────────────────────────────
const store = (obsidian && obsidian.store) || {};
const vaultRoot = (obsidian && obsidian.vault && obsidian.vault.vault_root) || '';
const cli = (runtime && runtime.markitdown && runtime.markitdown.cli) || '';

const plan = {
  version: 1,
  bots,
  vaultRoot,
  workspaceRoot: '',   // 留空 = 用插件数据目录（推荐，避免与旧工作区耦合）
  store: {
    folderPattern: store.folder_pattern || '{top}/{YYYY}/{MM}/{name}',
    topFolder: store.top_folder || '01_文章分享',
    assetsDir: store.assets_dir || 'assets',
    conflictSuffix: true,
  },
  pipeline: {
    markitdownCli: cli,
  },
};

// ── 打印（密钥打码）────────────────────────────────────────────────────────
console.log('\n════════ 迁移计划 ════════\n');
console.log(`vaultRoot        = ${vaultRoot || '(空)'}`);
console.log(`folderPattern    = ${plan.store.folderPattern}`);
console.log(`topFolder        = ${plan.store.topFolder}`);
console.log(`assetsDir        = ${plan.store.assetsDir}`);
console.log(`markitdownCli    = ${cli || '(空)'}`);
console.log(`workspaceRoot    = (留空 → ${path.join(dshHome, 'wecom-obsidian', 'workspace')})`);
console.log(`\n机器人 (${bots.length}):`);
for (const b of bots) {
  console.log(`  · ${b.label}  [矩阵键 ${b._srcKey}]`);
  console.log(`      botId  = ${mask(b.botId)}  (env ${b._idEnv || '-'})`);
  console.log(`      secret = ${mask(b.secret)}  (env ${b._secretEnv || '-'})`);
  console.log(`      enabled=${b.enabled}  collect=${b.collectEnabled}  media=${b.mediaEnabled}  policy=${b.policy}`);
  console.log(`      session=${b.sessionId || '(自动)'}  collector=${b.collectorSessionId || '(自动)'}`);
  if (b.policy === 'allowlist') console.log(`      allowlist=${JSON.stringify(b.allowlist)}`);
}

// 计划落盘到临时文件（含密钥，0600），供 apply 步骤读取。
const planFile = path.join(dshHome, 'wecom-obsidian', 'migration-plan.json');
if (!dry) {
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), { mode: 0o600 });
  console.log(`\n计划已写入（0600）：${planFile}`);
} else {
  console.log('\n(--dry-run：未写任何文件)');
}

// 机器可读摘要（不含密钥），给上层日志用
console.log('\nSUMMARY ' + JSON.stringify({
  bots: bots.length,
  enabledBots: bots.filter((b) => b.enabled).length,
  vaultRoot,
  folderPattern: plan.store.folderPattern,
}));
NODE

cat <<EOF

$(say "计划已生成。")

下一步：把计划写进 DSH 设置文档。

设置文档由 DSH 的设置服务管理（schema 校验 + revision 栅栏 + 原子落盘），
**进程外改不了它**。两条路：

  A) 设置页手工填（最直观）
     打开「设置 → 企微 Obsidian 收藏」，照上面的计划逐项填写。
     Secret 是只写字段：留空表示不修改。

  B) 让插件自己执行迁移（推荐，密钥不出进程）
     在 DSH 会话里让 agent 读取并写入：
       ${DSH_HOME}/wecom-obsidian/migration-plan.json
     经 ctx.settings.update('wecom-obsidian', plan) 合并写入 ——
     只补缺失/空值字段，不覆盖已改过的项。

无论走哪条路，写完后请删除计划文件（含密钥）：
  rm -f "${DSH_HOME}/wecom-obsidian/migration-plan.json"
EOF
