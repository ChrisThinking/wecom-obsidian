#!/usr/bin/env bash
# ============================================================================
# 发布前自检（pre-publish check）
# ----------------------------------------------------------------------------
# 本脚本守护的都是**真实踩过的坑**，不是形式化检查：
#
#   1. 文件权限   曾出现 32 个源文件是 0600 —— 别人 clone 后**根本读不到**，
#                 插件无法使用。这是最容易漏、后果最严重的一项。
#   2. 包声明     DSH 读 `${DSH_HOME}/profiles/<p>/node_modules/<name>/package.json`
#                 来解析 bundle 行，所以 package.json **必须在包根**（扁平布局），
#                 且 dsh.bundle.patch / exports["./client"] 指向的文件必须存在。
#   3. 个人化路径 源码里不能残留作者机器的绝对路径（/Users/xxx、/Volumes/xxx、
#                 某人的运行目录）—— 否则别人装上就报「找不到文件」。
#   4. 密钥泄露   仓库里不能出现真实 Bot Secret / Bot ID。
#   5. 语法       JS / Python / shell 全部可解析。
#
# 用法：
#   bash install/verify.sh
# 退出码 0 = 可以发布；非 0 = 有问题，详见输出。
# ============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[1;31m✗\033[0m %s\n' "$*"; FAIL=1; }
info() { printf '  \033[1;36m·\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── 1. 文件权限 ─────────────────────────────────────────────────────────────
head_ "1. 文件权限（clone 后可读性）"
BAD_PERM="$(find . -type f -not -path './.git/*' -not -path './node_modules/*' \
             ! -perm -o=r 2>/dev/null | wc -l | tr -d ' ')"
if [ "$BAD_PERM" = "0" ]; then
  ok "所有文件对 others 可读"
else
  bad "$BAD_PERM 个文件 others 不可读（clone 后别人读不到）—— 修正：chmod 644 <file>"
  find . -type f -not -path './.git/*' -not -path './node_modules/*' ! -perm -o=r | head -5 | sed 's/^/      /'
fi
# 安装脚本应可执行
for s in install/install.sh install/uninstall.sh; do
  [ -x "$s" ] && ok "$s 可执行" || bad "$s 不可执行（chmod 755）"
done

# ── 2. 包声明与布局 ─────────────────────────────────────────────────────────
head_ "2. 包声明与布局"
if [ ! -f package.json ]; then
  bad "package.json 不在包根 —— DSH 无法把本仓库识别为 bundle"
else
  ok "package.json 在包根（扁平布局）"
  NAME="$(node -p "require('./package.json').name")"
  info "包名: $NAME"
  case "$NAME" in
    @local/*) bad "包名带 @local 作用域 —— GitHub 安装者无法解析，请用无作用域名" ;;
    '') bad "包名缺失" ;;
    *) ok "包名可用于发布" ;;
  esac
  PRIV="$(node -p "String(require('./package.json').private === true)")"
  [ "$PRIV" = "true" ] && bad "private: true 会阻止 npm 发布" || ok "未标记 private"

  PATCH="$(node -p "require('./package.json').dsh?.bundle?.patch ?? ''")"
  [ -n "$PATCH" ] && [ -f "$PATCH" ] && ok "dsh.bundle.patch → ${PATCH}（存在）" \
    || bad "dsh.bundle.patch 缺失或指向不存在的文件: '$PATCH'"

  CLIENT="$(node -p "require('./package.json').exports?.['./client']?.default ?? ''")"
  [ -n "$CLIENT" ] && [ -f "$CLIENT" ] && ok "exports['./client'] → ${CLIENT}（存在）" \
    || bad "exports['./client'] 缺失或指向不存在的文件: '$CLIENT'"

  PLATFORM="$(node -p "require('./package.json').dsh?.client?.platform ?? ''")"
  [ "$PLATFORM" = "web" ] && ok "dsh.client.platform = web" || bad "dsh.client.platform 应为 web（当前 '$PLATFORM'）"

  # 客户端 bundle 必须是 ModuleLoader 格式（没有构建步骤）
  if [ -n "$CLIENT" ] && [ -f "$CLIENT" ]; then
    grep -q "__ModuleLoader__.load" "$CLIENT" \
      && ok "客户端 bundle 是 ModuleLoader 格式（无需构建）" \
      || bad "客户端 bundle 缺少 window.__ModuleLoader__.load 包装"
  fi
fi

# ── 3. 个人化路径 ───────────────────────────────────────────────────────────
head_ "3. 个人化路径残留"
# 例外：`package-lock.json` 里 npm 自动记录的 **extraneous 符号链接目标**
# （形如 `"../../…/node_modules/@deepseek-ai/cordis"`）。它是本机 node_modules
# 的真实路径，任何机器上跑一次 `npm install` 都会重新生成，无法靠提交修掉；
# 也正因为是自动生成键，不是「作者写进源码的路径」。其余任何位置出现绝对路径仍然报错。
HITS="$(grep -rn "/Users/[A-Za-z0-9._-]\+\|/Volumes/[A-Za-z0-9._-]\+" \
          --include='*.js' --include='*.py' --include='*.sh' --include='*.mjs' \
          --include='*.json' --include='*.yml' . 2>/dev/null \
        | grep -v '^./node_modules/' | grep -v '^./.git/' \
        | grep -v '^./install/verify.sh:' \
        | grep -v '^./package-lock\.json:.*\.\./.*node_modules/' || true)"
if [ -z "$HITS" ]; then
  ok "源码无作者机器绝对路径"
else
  bad "发现机器专属绝对路径（别人装上会找不到文件）："
  printf '%s\n' "$HITS" | head -8 | sed 's/^/      /'
fi
# 文档里允许出现示例路径，但必须是中性例子，不能是作者的真实库路径
DOC_HITS="$(grep -rn "wangbin\|SamsungT9" --include='*.md' . 2>/dev/null | grep -v '^./node_modules/' || true)"
[ -z "$DOC_HITS" ] && ok "文档无作者真实路径示例" \
  || { bad "文档里出现作者真实路径（请改成中性示例，如 /path/to/Vault）："; printf '%s\n' "$DOC_HITS" | head -5 | sed 's/^/      /'; }

# ── 4. 密钥泄露 ─────────────────────────────────────────────────────────────
head_ "4. 密钥泄露"
# 企微 Bot ID 形如 aibXXXX…；真实 Secret 长且随机。这里做保守模式匹配。
LEAK="$(grep -rn "aib[A-Za-z0-9_-]\{16,\}" --include='*.js' --include='*.json' --include='*.yml' \
          --include='*.md' . 2>/dev/null | grep -v '^./node_modules/' | grep -v '^./.git/' || true)"
[ -z "$LEAK" ] && ok "无真实 Bot ID 残留" || { bad "疑似 Bot ID 泄露："; printf '%s\n' "$LEAK" | head -5 | sed 's/^/      /'; }
SECRET_ASSIGN="$(grep -rn "WECOM_BOT[A-Z0-9_]*SECRET *=" --include='*.js' --include='*.json' \
                  --include='*.yml' --include='*.sh' . 2>/dev/null | grep -v '^./node_modules/' || true)"
[ -z "$SECRET_ASSIGN" ] && ok "无明文 Secret 赋值" || { bad "疑似 Secret 泄露："; printf '%s\n' "$SECRET_ASSIGN" | head -5 | sed 's/^/      /'; }
[ -f settings.yaml ] && bad "仓库里出现 settings.yaml（含密钥的运行时配置）" || ok "未包含运行时 settings.yaml"

# ── 5. 语法 ─────────────────────────────────────────────────────────────────
head_ "5. 语法检查"
JS_BAD=0
for f in lib/*.js client/*.js install/*.mjs; do
  [ -f "$f" ] || continue
  node --check "$f" >/dev/null 2>&1 || { bad "JS 语法: $f"; JS_BAD=1; }
done
[ "$JS_BAD" = "0" ] && ok "JavaScript 全部可解析"

PY_BAD=0
if command -v python3 >/dev/null 2>&1; then
  # 用 compile() 显式检查语法，**不写字节码**：
  # `python3 -m py_compile` 会把 .pyc 写进用户缓存目录（如 ~/Library/Caches/…），
  # 在沙箱 / 只读 HOME 环境下必然失败，于是所有文件都被误报成语法错误。
  while IFS= read -r f; do
    python3 -c 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")' "$f" 2>/dev/null \
      || { bad "Python 语法: $f"; PY_BAD=1; }
  done < <(find pipeline -name '*.py' 2>/dev/null)
  [ "$PY_BAD" = "0" ] && ok "Python 全部可解析"
  find pipeline -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
else
  info "跳过 Python 检查（无 python3）"
fi

SH_BAD=0
for f in install/*.sh pipeline/scripts/convert/install-deps.sh; do
  [ -f "$f" ] || continue
  bash -n "$f" >/dev/null 2>&1 || { bad "shell 语法: $f"; SH_BAD=1; }
done
[ "$SH_BAD" = "0" ] && ok "shell 脚本全部可解析"

# ── 5b. 测试套件（JS 单测/设置服务回归 + Python 流水线回归）─────────────────
# 发布前的最后一道闸：`npm test` 跑的就是 CI 那一套，必须全绿。
head_ "5b. 测试套件"
if npm test >/tmp/wecom-verify-test.log 2>&1; then
  # 用 -oE 抽计数：`.` 在多字节 locale 下会匹配到非 ASCII 前缀，抽取结果不稳定
  js_line="$(grep -oE 'pass [0-9]+' /tmp/wecom-verify-test.log | tail -1)"
  py_line="$(grep -oE 'Ran [0-9]+ tests|^OK' /tmp/wecom-verify-test.log | tail -1)"
  ok "测试全部通过（JS ${js_line:-pass} · Python ${py_line:-OK}）"
else
  bad "测试失败，详见 /tmp/wecom-verify-test.log"
  tail -20 /tmp/wecom-verify-test.log | sed 's/^/      /'
fi

# ── 6. 必需文件 ─────────────────────────────────────────────────────────────
head_ "6. 必需文件"
for f in readme.md LICENSE package.json bundle/cordis.patch.yml bundle/agent/agent.cordis.yml \
         lib/index.js client/client.js install/install.sh install/uninstall.sh \
         pipeline/scripts/wf_common.py pipeline/scripts/manage/store.py \
         pipeline/skills/acquire/SKILL.md; do
  [ -f "$f" ] && ok "$f" || bad "缺少 $f"
done

# ── 汇总 ────────────────────────────────────────────────────────────────────
printf '\n'
if [ "$FAIL" = "0" ]; then
  printf '\033[1;32m通过：可以发布。\033[0m\n'
else
  printf '\033[1;31m未通过：请先修复上面标 ✗ 的项。\033[0m\n'
fi
exit "$FAIL"
