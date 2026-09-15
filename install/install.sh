#!/usr/bin/env bash
# ============================================================================
# dsh-wecom-obsidian 一键安装 / 重装
# ----------------------------------------------------------------------------
# 重装 DSH 之后，只要插件包还在（或重新拿到这个目录），跑这一条命令即可恢复
# 插件能力（长连接 SDK / Profile 登记 / 收藏 Agent 预设 / 运行时目录）：
#
#   bash install/install.sh
#
# 注意：本脚本**不负责**恢复你的配置 —— Bot 凭证与 Vault 路径在
# ${DSH_HOME}/settings.yaml（DSH 设置服务管理），运行账本在工作区里。
# DSH_HOME 不变时它们自然还在；DSH_HOME 变了请先自行备份/迁移这两处。
# DSH_HOME 的解析顺序：显式 $DSH_HOME > 正在运行的 dsh 进程环境 > ~/.dsh。
#
# 脚本做的事（全部幂等，可反复执行）：
#   1. 装好插件包自身的 Node 依赖（企微长连接 SDK）；
#   2. 把插件注册进 DSH Profile（依赖 + bundle 层），DSH 下一轮启动即加载；
#      并**校验** Profile 的 node_modules 里真的能解析到本包，否则以非 0 退出；
#   3. 安装收藏专用 Agent 预设到 ${DSH_HOME}/.agent-presets/，并把插件里的
#      三 Skill 路径写进去，使收藏会话天然具备 acquire/format/store 能力；
#   4. 建立运行时数据目录；
#   5. 检测并（可选）停用旧的企微桥接行，避免同一机器人被两条连接互相顶下线。
#
# 安装完在浏览器里打开「设置 → 企微 Obsidian 收藏」填 Bot ID / Secret /
# Obsidian 库路径即可，不需要再手改任何配置文件。
# ============================================================================
set -euo pipefail

# 本脚本位于 <repo>/install/install.sh，插件包本体就是仓库根 ——
# `package.json` / `dsh.bundle` 都在根目录，这样 `dsh plugin add github:<user>/<repo>`
# 与 profile 的 link 依赖都能正常解析（DSH 读的是 node_modules/<name>/package.json）。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT"

say()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$PLUGIN_DIR/package.json" ] || die "找不到 $PLUGIN_DIR/package.json —— 请从仓库内运行本脚本"

PROFILE="${DSH_PROFILE:-web}"
PACKAGE_NAME="$(node -p "require('$PLUGIN_DIR/package.json').name" 2>/dev/null || echo dsh-wecom-obsidian)"

# ── 解析 DSH_HOME ───────────────────────────────────────────────────────────
# 优先级：显式 $DSH_HOME > 正在运行的 dsh 进程环境 > ~/.dsh。
#
# 为什么不能只默认 ~/.dsh：DSH 允许把 DSH_HOME 指到任意目录（本机就是
# 一个工作区目录），只认 ~/.dsh 会去找一个根本不存在的 profile，或者更糟 ——
# 在错误的位置写 preset 和依赖登记，而插件永远不会被加载。
detect_dsh_home() {
  local candidate
  if [ -n "${DSH_HOME:-}" ]; then
    printf '%s\n' "$DSH_HOME"
    return 0
  fi
  local pid env_home
  if command -v pgrep >/dev/null 2>&1 && command -v ps >/dev/null 2>&1; then
    pid="$(pgrep -f 'dsh/lib/bin.js' 2>/dev/null | head -1 || true)"
    if [ -n "${pid:-}" ]; then
      env_home="$(ps eww -p "$pid" 2>/dev/null | tr ' ' '\n' | sed -n 's/^DSH_HOME=//p' | head -1 || true)"
      if [ -n "${env_home:-}" ] && [ -d "$env_home" ]; then
        printf '%s\n' "$env_home"
        return 0
      fi
    fi
  fi
  printf '%s\n' "$HOME/.dsh"
}

if [ -n "${DSH_HOME:-}" ]; then
  DSH_HOME="$DSH_HOME"
else
  DSH_HOME="$(detect_dsh_home)"
  [ "$DSH_HOME" = "$HOME/.dsh" ] || say "自动识别到 DSH_HOME：$DSH_HOME"
fi
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PRESET_ID="wecom-obsidian-collector"
PRESET_DIR="$DSH_HOME/.agent-presets/$PRESET_ID"
DATA_DIR="$DSH_HOME/wecom-obsidian"
STAMP="$(date +%Y%m%d-%H%M%S)"

# 记录「插件到底有没有被登记成功」，供结尾的完成/未完成判定使用。
PROFILE_LINKED=0
RUNTIME_WARN=0

# ── 0. 环境检查 ─────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "找不到 node"
command -v npm  >/dev/null 2>&1 || die "找不到 npm"
if [ ! -d "$PROFILE_DIR" ]; then
  die "找不到 DSH Profile 目录：$PROFILE_DIR
       DSH_HOME=$DSH_HOME 可能是错的（本机实际 DSH_HOME 见正在运行的 dsh 进程）。
       请显式指定后重跑，例如：
         DSH_HOME=/path/to/dsh-home bash install/install.sh
       可用 'ps eww -p \$(pgrep -f dsh/lib/bin.js | head -1)' 查当前 DSH_HOME。"
fi
say "插件目录：$PLUGIN_DIR"
say "DSH_HOME：$DSH_HOME   Profile：$PROFILE"

# Node 版本：插件用了 `node:` 前缀模块与顶层 await，需要 18+。
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  warn "Node 版本偏低（$(node -v 2>/dev/null)）。建议 18+。"
fi

# ── 0b. 采集链依赖预检（只报告，不阻断安装）────────────────────────────────
# 这些是**运行期**依赖，缺了只影响对应的一路收藏，不影响插件加载与机器人对话。
say "采集链依赖预检："
PY_ANY="$(command -v python3 || command -v python || true)"
if [ -z "$PY_ANY" ]; then
  warn "  ✗ python3 缺失 —— 收藏链路不可用（对话不受影响）"
else
  say "  ✓ python3 → $PY_ANY ($("$PY_ANY" -V 2>&1 | head -1))"
  if "$PY_ANY" -c "import bs4" >/dev/null 2>&1; then
    say "  ✓ beautifulsoup4 可用（微信图文转换器）"
  else
    warn "  ✗ beautifulsoup4 缺失 —— 微信图文收藏会失败，下面会自动安装"
  fi
fi
if command -v markitdown >/dev/null 2>&1 || [ -x "$HOME/.local/bin/markitdown" ]; then
  say "  ✓ markitdown 可用（其它任意网页）"
else
  warn "  ✗ markitdown 缺失 —— 只影响「其它任意网页」；微信/小红书/头条各有专用转换器"
fi

# ── 1. Node 依赖 ────────────────────────────────────────────────────────────
# 分两类：
#   (a) 真正属于插件的第三方包（企微长连接 SDK 及其闭包）—— 优先从本机已有副本
#       离线复制（快且不依赖网络），没有副本时才联网 npm install；
#   (b) 必须与宿主**同一份**的 DSH 内部包（cordis / schemastery）—— 由 Profile
#       依赖的 link 解析提供（Node 从 package 真实路径向上逐级查找 node_modules），
#       因此插件目录**不**自带这两个包，避免出现两份 cordis。
PLUGIN_NODE_MODULES="$PLUGIN_DIR/node_modules"
COPY_DEPS="$PLUGIN_DIR/install/copy-deps.mjs"

if [ -d "$PLUGIN_NODE_MODULES/@wecom/aibot-node-sdk" ]; then
  say "企微长连接 SDK 已存在，跳过依赖安装"
else
  say "安装企微长连接 SDK…"
  SDK_SOURCE=""
  # 离线兜底：本机若已有该 SDK 的副本就直接复制（快、且不依赖网络）。
  # 这是**可选优化**，不是必需步骤；找不到就联网装。
  # 需要时可显式指定：WECOM_SDK_SOURCE=/path/to/node_modules
  for candidate in \
    "${WECOM_SDK_SOURCE:-}" \
    "$DSH_HOME/../wecom-aibot-host/node_modules" \
    "$HOME/wecom-aibot-host/node_modules"
  do
    [ -n "$candidate" ] && [ -d "$candidate/@wecom/aibot-node-sdk" ] || continue
    SDK_SOURCE="$candidate"
    break
  done

  if [ -n "$SDK_SOURCE" ]; then
    say "从本机副本离线复制依赖闭包：$SDK_SOURCE"
    node "$COPY_DEPS" "$SDK_SOURCE" "$PLUGIN_NODE_MODULES" @wecom/aibot-node-sdk || true
  fi

  if [ ! -d "$PLUGIN_NODE_MODULES/@wecom/aibot-node-sdk" ]; then
    say "联网安装依赖（npm install）…"
    ( cd "$PLUGIN_DIR" && npm install --no-audit --no-fund --loglevel=error ) \
      || warn "npm install 失败（离线环境？）"
  fi
fi

if [ ! -d "$PLUGIN_NODE_MODULES/@wecom/aibot-node-sdk" ]; then
  warn "仍缺少 @wecom/aibot-node-sdk。机器人长连接将无法建立（插件其余部分不受影响）。"
  warn "可稍后联网执行：cd \"$PLUGIN_DIR\" && npm install"
fi

# ── 1b. 链接宿主的 DSH 内部包 ───────────────────────────────────────────────
# 插件只依赖两个 DSH 内部包：
#   @deepseek-ai/cordis        —— Service 基类（类身份必须与宿主同一份）
#   @deepseek-ai/schemastery   —— 设置 schema 定义
# 这两个必须与宿主**同一实例**，不能各自装一份。Node 的模块解析是沿 package
# 的**真实路径**向上找 node_modules；当插件目录与 DSH 安装目录不在同一卷时
# 这条链是断的，所以显式软链进来。
find_dsh_modules() {
  local candidates=(
    "${DSH_INSTALL_DIR:-}/node_modules"
    "$DSH_HOME/profiles/node_modules"
    # 挂载在 dsh 安装目录同级的常见布局（安装脚本自己的 cwd 反查见下）
    "$HOME/.dsh/profiles/node_modules"
    "/usr/local/lib/node_modules"
  )
  # 用正在运行的 dsh 进程反查（launchd 下 cwd 就是安装目录，最可靠）。
  local pid cwd
  pid="$(pgrep -f 'dsh/lib/bin.js' 2>/dev/null | head -1 || true)"
  if [ -n "${pid:-}" ]; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1 || true)"
    if [ -n "${cwd:-}" ]; then
      candidates=("$cwd/node_modules" "$(dirname "$cwd")/profiles/node_modules" "${candidates[@]}")
    fi
  fi
  for dir in "${candidates[@]}"; do
    [ -n "$dir" ] || continue
    if [ -d "$dir/@deepseek-ai/cordis" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
  done
  return 1
}

# 若插件目录已经能解析到宿主那两个包（例如它本来就装在 profile 的 node_modules
# 下方、Node 向上查找即可命中），则**不需要**软链，跳过即可 —— 这是正常布局。
if node -e "require.resolve('@deepseek-ai/cordis',{paths:['$PLUGIN_DIR']})" >/dev/null 2>&1; then
  say "宿主 DSH 内部包已可解析（Node 向上查找命中），无需软链"
else
  DSH_MODULES=""
  if DSH_MODULES="$(find_dsh_modules)"; then
    say "宿主 DSH 内部包来源：$DSH_MODULES"
    mkdir -p "$PLUGIN_NODE_MODULES/@deepseek-ai"
    for pkg in cordis schemastery; do
      target="$PLUGIN_NODE_MODULES/@deepseek-ai/$pkg"
      source="$DSH_MODULES/@deepseek-ai/$pkg"
      if [ ! -d "$source" ]; then
        warn "  $DSH_MODULES 里没有 ${pkg}，跳过"
        continue
      fi
      if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
        say "  @deepseek-ai/$pkg 已链接，跳过"
      else
        rm -rf "$target"
        ln -s "$source" "$target"
        say "  链接 @deepseek-ai/$pkg → $source"
      fi
    done
  else
    warn "找不到宿主 DSH 的 @deepseek-ai 包目录，插件加载时会报模块解析失败。"
    warn "请显式指定后重跑：DSH_INSTALL_DIR=/path/to/dsh bash install/install.sh"
  fi
fi

# ── 2. 注册进 DSH Profile ──────────────────────────────────────────────────
# 两件事，缺一不可；而且只做这两件 —— **不要**再往 profile 的
# cordis.patch.yml 里插行。
#
#   依赖：DSH 从 Profile 解析行的模块位置，包必须在 dependencies 里（link 即可）。
#   bundle 层：包自己声明了 `dsh.bundle.patch`，列进 `dsh.profile.bundles`
#              才会被叠加进 composition。
#
#   ⚠️ 曾经多写了一步「在 cordis.patch.yml 里也 insert 一行」，结果同一份行被
#      bundle 补丁和 profile 补丁各插一次，插件 apply 跑两遍，第二次撞上
#      「settings namespace 已注册」直接把整棵插件树打挂（DSH 起不来）。
#      所以本脚本只登记 bundle；composition 行由插件包自己的补丁提供。
#
# 用数组而不是拼接字符串：`PNPM="corepack pnpm"` 再 `"$PNPM" add` 会把
# 「corepack pnpm」当成**一个命令名**去执行（实测 `command not found`），
# 于是 pnpm 分支永远失败、却因为 `|| warn` 被吞掉，最后照样打印「安装完成」。
PNPM=()
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  # corepack 是 Node 自带的 pnpm/yarn 代理，很多环境用它而非全局 pnpm
  PNPM=(corepack pnpm)
fi

if [ "${#PNPM[@]}" -gt 0 ]; then
  say "把插件登记为 Profile 依赖（link:${PLUGIN_DIR}）…"
  ( cd "$PROFILE_DIR" && "${PNPM[@]}" add "link:$PLUGIN_DIR" --silent ) \
    || warn "pnpm add 失败；稍后由下面的依赖表兜底写入"
else
  warn "本机没有 pnpm / corepack，跳过 pnpm add；依赖表仍会写入，但需要你手工执行一次 pnpm install"
fi

# 依赖表 + bundle 层（直接改 package.json，不依赖 pnpm 是否可用）。
say "登记依赖与 bundle 层（$PROFILE_DIR/package.json）…"
node - "$PROFILE_DIR/package.json" "$PACKAGE_NAME" "$PLUGIN_DIR" <<'NODE'
const fs = require('node:fs');
const [file, name, dir] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies[name] = `link:${dir}`;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : [];
if (!bundles.includes(name)) bundles.push(name);
pkg.dsh.profile.bundles = bundles;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('  bundles  =', bundles.join(', '));
console.log('  dependency =', name, '→', pkg.dependencies[name]);
NODE

# profile 自带的 patch 层若残留本插件的 insert 行，就地清理（历史安装可能留下）。
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
if [ -f "$PATCH_FILE" ] && grep -q "dsh-wecom-obsidian" "$PATCH_FILE"; then
  cp "$PATCH_FILE" "$PATCH_FILE.bak-dedup-$STAMP"
  node - "$PATCH_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const lines = fs.readFileSync(file, 'utf8').split('\n');
const out = [];
let removed = 0;
for (let i = 0; i < lines.length; i += 1) {
  // 命中插件行的 name 时，连同紧邻的 "- id: ..." 一起注释掉，避免重复插入。
  if (/^\s*name:\s*'dsh-wecom-obsidian'\s*$/.test(lines[i])) {
    if (out.length > 0 && /^\s*-\s*id:\s*wecom-obsidian\s*$/.test(out[out.length - 1])) {
      out[out.length - 1] = `# [wecom-obsidian 去重] ${out[out.length - 1]}`;
    }
    out.push(`# [wecom-obsidian 去重] ${lines[i]}`);
    removed += 1;
    continue;
  }
  out.push(lines[i]);
}
fs.writeFileSync(file, out.join('\n'));
console.log('  已从 profile patch 去除重复行:', removed);
NODE
  say "composition 行只由插件 bundle 提供（备份：$PATCH_FILE.bak-dedup-${STAMP}）"
fi

# 依赖表兜底：即使 pnpm add 没跑成功，这里也写上 link 依赖，
# 让下一次 `pnpm install` 能把包挂进 Profile 的 node_modules。
node - "$PROFILE_DIR/package.json" "$PACKAGE_NAME" "$PLUGIN_DIR" <<'NODE'
const fs = require('node:fs');
const [file, name, dir] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.dependencies = pkg.dependencies || {};
if (!pkg.dependencies[name] || !String(pkg.dependencies[name]).startsWith('link:')) {
  pkg.dependencies[name] = `link:${dir}`;
}
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('dependency', name, '=', pkg.dependencies[name]);
NODE

# 校验「插件是否真的会被 DSH 加载」：光写依赖表不够，Profile 的 node_modules
# 里必须真的能解析到本包（否则下一次启动直接报模块解析失败）。
# 失败时再补一次 pnpm install，仍失败就明确标记「安装未完成」，不再打印完成。
if [ -e "$PROFILE_DIR/node_modules/$PACKAGE_NAME/package.json" ]; then
  PROFILE_LINKED=1
elif [ "${#PNPM[@]}" -gt 0 ]; then
  say "Profile 里还没有插件链接，补一次 pnpm install…"
  ( cd "$PROFILE_DIR" && "${PNPM[@]}" install --silent ) || warn "pnpm install 失败"
  if [ -e "$PROFILE_DIR/node_modules/$PACKAGE_NAME/package.json" ]; then
    PROFILE_LINKED=1
  fi
fi
if [ "$PROFILE_LINKED" = "1" ]; then
  say "插件已在 Profile node_modules 中可解析：$PROFILE_DIR/node_modules/$PACKAGE_NAME"
else
  warn "插件尚未被登记进 Profile：$PROFILE_DIR/node_modules/$PACKAGE_NAME 不存在"
  warn "请手工执行：cd \"$PROFILE_DIR\" && pnpm install"
fi

# ── 3. 安装收藏 Agent 预设 ─────────────────────────────────────────────────
say "安装收藏 Agent 预设 → $PRESET_DIR"
mkdir -p "$PRESET_DIR"
cp "$PLUGIN_DIR/bundle/agent/preset.yml" "$PRESET_DIR/preset.yml"
# 把 @@PLUGIN_ROOT@@ 换成真实路径：技能目录必须是字面量绝对路径。
sed "s|@@PLUGIN_ROOT@@|$PLUGIN_DIR|g" "$PLUGIN_DIR/bundle/agent/agent.cordis.yml" > "$PRESET_DIR/agent.cordis.yml"
grep -q "$PLUGIN_DIR" "$PRESET_DIR/agent.cordis.yml" || die "预设路径替换失败，请检查 $PLUGIN_DIR 是否含特殊字符"
say "预设已写入，技能来源：$PLUGIN_DIR/pipeline/skills"

# ── 4. 运行时数据目录 ──────────────────────────────────────────────────────
mkdir -p "$DATA_DIR"/{workspace,health,control,logs,pylibs}
say "运行时数据目录：$DATA_DIR"

# ── 4b. 采集链的 Python 依赖 ───────────────────────────────────────────────
# 依赖矩阵（只有「微信图文」与「其它任意网页」需要额外东西）：
#   mp.weixin.qq.com 图文   → python3 + beautifulsoup4
#   mp.weixin.qq.com 分享页 → python3（纯标准库）
#   xiaohongshu / xhslink  → python3（纯标准库）
#   toutiao                → python3（纯标准库）
#   其它任意网页             → python3 + markitdown CLI
PYLIBS="$DATA_DIR/pylibs"
PY="${WECOM_PYTHON:-$(command -v python3 || command -v python || true)}"

if [ -z "$PY" ]; then
  warn "找不到 python3 —— 采集链无法运行。请安装 Python 3.8+ 后重跑本脚本。"
else
  say "Python 解释器：$PY ($("$PY" -V 2>&1))"
  if "$PY" -c "import bs4" >/dev/null 2>&1; then
    say "beautifulsoup4 已在解释器里可用，跳过安装"
  elif PYTHONPATH="$PYLIBS" "$PY" -c "import bs4" >/dev/null 2>&1; then
    say "beautifulsoup4 已在 ${PYLIBS}，跳过安装"
  else
    say "安装 beautifulsoup4 到 ${PYLIBS}（微信图文转换器需要）…"
    "$PY" -m pip install --quiet --target "$PYLIBS" beautifulsoup4 \
      || warn "pip 安装失败。可稍后手工执行：
      $PY -m pip install --target \"$PYLIBS\" beautifulsoup4"
  fi
fi

# markitdown 只服务「其它任意网页」这一路；微信/小红书/头条各有专用转换器。
MARKITDOWN_FOUND="$(command -v markitdown || true)"
if [ -n "$MARKITDOWN_FOUND" ]; then
  say "markitdown 已在 PATH：$MARKITDOWN_FOUND"
elif [ -x "$HOME/.local/bin/markitdown" ]; then
  say "markitdown 在 $HOME/.local/bin/markitdown（不在 PATH，但插件物化时会解析绝对路径）"
else
  warn "未找到 markitdown。只影响「其它任意网页」的收藏（微信/小红书/头条不受影响）。"
  warn "需要时安装：uv tool install 'markitdown[all]'   或   pipx install markitdown"
  warn "然后在设置页「采集流水线 → markitdown CLI 路径」填绝对路径即可。"
fi

# ── 5. 旧的企微桥接行检测 ──────────────────────────────────────────────────
# 旧实现（@local/dsh-wecom-aibot-host）与新插件会争抢同一条 wss：企微服务端
# 只允许一个连接，后连的会把先连的顶下线。因此必须二选一。
PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
LEGACY_MARK="@local/dsh-wecom-aibot-host"
if [ -f "$PATCH_FILE" ] && grep -q "$LEGACY_MARK" "$PATCH_FILE"; then
  warn "检测到旧的企微桥接插件行（${LEGACY_MARK}）。"
  warn "同一个机器人不允许两条长连接（后连的会把先连的顶下线），请二选一。"
  if [ "${WECOM_OBSIDIAN_DISABLE_LEGACY:-0}" = "1" ]; then
    cp "$PATCH_FILE" "$PATCH_FILE.bak-wecom-obsidian-$STAMP"
    node - "$PATCH_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
let text = fs.readFileSync(file, 'utf8');
// 只把旧桥接实例行整行注释掉，保留文件其余内容原样（含注释与其它定制）。
const out = text.split('\n').map((line) => {
  if (/^\s*name:\s*'?@local\/dsh-wecom-aibot-host'?\s*$/.test(line)) return `# [wecom-obsidian 安装脚本停用] ${line}`;
  return line;
});
fs.writeFileSync(file, out.join('\n'));
NODE
    say "已停用旧桥接行（备份：$PATCH_FILE.bak-wecom-obsidian-${STAMP}）"
  else
    warn "未自动停用。确认新插件可用后，手工把 $PATCH_FILE 里 $LEGACY_MARK 的行注释掉；"
    warn "或重跑本脚本时加 WECOM_OBSIDIAN_DISABLE_LEGACY=1 让脚本代劳。"
  fi
fi

# ── 6. 完成 / 未完成 ───────────────────────────────────────────────────────
# 只有「插件真的被登记进 Profile」才算完成。依赖登记失败却照样打印
# 「安装完成」是真实踩过的坑：用户以为装好了，重启后插件根本没加载。
if [ "$PROFILE_LINKED" != "1" ]; then
  cat <<EOF

$(warn "安装未完成：插件没有被登记进 Profile。")
  Profile：$PROFILE_DIR
  依赖表已写入，但 node_modules 里没有 ${PACKAGE_NAME}。
  请修复上面的报错后重跑：
      cd "$PROFILE_DIR" && pnpm install
      DSH_HOME="$DSH_HOME" bash "$SCRIPT_DIR/install.sh"

EOF
  exit 1
fi

cat <<EOF

$(say "安装完成。")

接下来两步：

  1) 重启 DSH，让新的 composition 生效：
       launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh.web
     （或直接重启你启动 dsh 的那个进程）

  2) 打开 DSH 设置页 → 「企微 Obsidian 收藏」，填入：
       · 机器人名称 / Bot ID / Secret
       · Obsidian 导入地址（Vault 绝对路径）
       · 存储路径规则（默认 {top}/{YYYY}/{MM}/{name}，即「年/月」）
     保存后桥接插件会自动建立长连接，无需再改任何文件。

关于「重装是否恢复配置」——本脚本只负责插件本体与预设，**不碰**你的配置：
  · Bot 凭证 / Vault 路径保存在 $DSH_HOME/settings.yaml（DSH 设置服务管理）；
  · 运行账本/工作区在 $DATA_DIR/。
  只要 DSH_HOME 不变，重跑本脚本不会丢它们；但如果 DSH_HOME 变了（或 settings.yaml
  被删），本脚本**无法**替你恢复凭证与账本 —— 请先备份这两处再迁移。

自检命令：
  # 看机器人是否在线
  cat "$DATA_DIR/health/"*.json
  # 单独停/启一个机器人（把 <label> 换成机器人名称）
  echo stop  > "$DATA_DIR/control/<label>.cmd"
  echo start > "$DATA_DIR/control/<label>.cmd"

EOF
