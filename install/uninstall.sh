#!/usr/bin/env bash
# ============================================================================
# dsh-wecom-obsidian 卸载
# ----------------------------------------------------------------------------
# 只撤销「安装脚本做的四件事」，不动用户数据：
#
#   bash install/uninstall.sh              # 卸载插件，保留运行时数据与设置
#   bash install/uninstall.sh --purge      # 连运行时数据一起删（设置文档里的
#                                          # namespace 需在设置页手工重置）
#
# 具体动作：
#   1. 从 Profile 的 dsh.profile.bundles 移除本插件；
#   2. 从 Profile 依赖表移除 link 依赖；
#   3. 删除已安装的收藏 Agent 预设目录；
#   4. --purge 时删除 ${DSH_HOME}/wecom-obsidian/。
# ============================================================================
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PACKAGE_NAME="dsh-wecom-obsidian"
PRESET_DIR="$DSH_HOME/.agent-presets/wecom-obsidian-collector"
DATA_DIR="$DSH_HOME/wecom-obsidian"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

say()  { printf '\033[1;36m[uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

[ -d "$PROFILE_DIR" ] || { warn "找不到 Profile 目录 $PROFILE_DIR，跳过 Profile 清理"; }

# ── 1/2. Profile 登记 ──────────────────────────────────────────────────────
if [ -f "$PROFILE_DIR/package.json" ]; then
  say "从 Profile 移除 bundle 与依赖登记…"
  node - "$PROFILE_DIR/package.json" "$PACKAGE_NAME" <<'NODE'
const fs = require('node:fs');
const [file, name] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
if (pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) {
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((row) => row !== name);
}
if (pkg.dependencies && pkg.dependencies[name]) delete pkg.dependencies[name];
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('剩余 bundles =', ((pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []).join(', '));
NODE
fi

# ── 3. 预设 ────────────────────────────────────────────────────────────────
if [ -d "$PRESET_DIR" ]; then
  say "删除收藏 Agent 预设：$PRESET_DIR"
  rm -rf "$PRESET_DIR"
fi

# ── 4. 运行时数据 ──────────────────────────────────────────────────────────
if [ "$PURGE" = "1" ]; then
  if [ -d "$DATA_DIR" ]; then
    say "删除运行时数据：$DATA_DIR"
    rm -rf "$DATA_DIR"
  fi
else
  say "保留运行时数据：$DATA_DIR（要一并删除请加 --purge）"
fi

cat <<EOF

$(say "卸载完成。")

重启 DSH 后生效：
  launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh.web

注意：设置文档 ${DSH_HOME}/settings.yaml 里的 wecom-obsidian 段不会被自动删除
（那是 DSH 的设置服务在管，不是插件目录）。如需彻底清空，请在设置页把字段清空，
或手工删除该段后重启。

EOF
