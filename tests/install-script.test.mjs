#!/usr/bin/env node
/**
 * install.sh 回归（hermetic：假 PATH + 临时 DSH_HOME，不碰真实 Profile）
 * ============================================================================
 * 守的是三条真实踩过的坑：
 *   1. `PNPM="corepack pnpm"` 再 `"$PNPM" add` → 把「corepack pnpm」当成一个命令名，
 *      pnpm 分支永远失败（`command not found`）；正确写法是 `"${PNPM[@]}"`。
 *   2. 依赖登记失败仍打印「安装完成」→ 用户以为装好了，重启后插件根本没加载。
 *      现在必须校验 Profile 的 node_modules 里真能解析到本包，否则非 0 退出。
 *   3. 默认只认 `$HOME/.dsh` 会在 DSH_HOME 指向别处时找错目录。现在显式 env 优先，
 *      其次运行中进程，最后才是 `~/.dsh`；找不到 profile 时给出可复制的命令。
 *
 * 用法：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const NODE_BIN = path.dirname(process.execPath);

/** 造一个假 bin 目录：corepack 桩 + 一定失败的 pgrep（避免探测到真实 dsh 进程）。 */
function makeFakeBin(corepackBody) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-install-bin-'));
  const corepack = path.join(bin, 'corepack');
  fs.writeFileSync(corepack, corepackBody, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return bin;
}

/** 起一个临时 DSH_HOME；`profile` 为 null 时不建 profile 目录。 */
function makeHome(profile = 'web') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wobs-install-home-'));
  if (profile) {
    const dir = path.join(home, 'profiles', profile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'),
      `${JSON.stringify({ name: `dsh-profile-${profile}`, private: true }, null, 2)}\n`);
  }
  return home;
}

/**
 * 跑 install.sh。
 * @param {object} opts - `{home, bin, log, env}`。
 */
function runInstall({ home, bin, log, extraEnv = {} }) {
  const env = {
    // 注意：必须包含 /usr/bin（dirname/sed/tr/pgrep 都在那），
    // 但 PATH 里**不能有真实 pnpm**，否则测不到 corepack 分支。
    // 假 bin 在最前，因此假 corepack / 假 pgrep 会先命中。
    PATH: `${bin}:${NODE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    DSH_HOME: home,
    // 用 /usr/bin/true 顶替 python3，让「bs4 是否可用」直接通过，避免联网 pip
    WECOM_PYTHON: '/usr/bin/true',
    FAKE_PNPM_LOG: log,
    PLUGIN_FOR_TEST: ROOT,
    ...extraEnv,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return spawnSync('bash', [path.join(ROOT, 'install', 'install.sh')], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000,
  });
}

const OK_COREPACK = `#!/bin/sh
echo "$*" >> "$FAKE_PNPM_LOG"
if [ "$1" = "pnpm" ] && [ "$2" = "add" ]; then
  mkdir -p "$PWD/node_modules"
  ln -sfn "$PLUGIN_FOR_TEST" "$PWD/node_modules/dsh-wecom-obsidian"
fi
exit 0
`;

const NOOP_COREPACK = `#!/bin/sh
echo "$*" >> "$FAKE_PNPM_LOG"
exit 0
`;

test('install.sh：corepack 必须以 `corepack pnpm add …` 两个词调用（不是「corepack pnpm」命令名）', () => {
  const home = makeHome();
  const log = path.join(home, 'pnpm.log');
  const bin = makeFakeBin(OK_COREPACK);
  try {
    const proc = runInstall({ home, bin, log });
    assert.equal(proc.status, 0, proc.stdout + proc.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.some((line) => line.startsWith('pnpm add link:')),
      `corepack 应收到 "pnpm add link:…"，实际：${JSON.stringify(calls)}`);
    assert.ok(calls.every((line) => !line.startsWith('add ')),
      '不允许出现「corepack 把 pnpm 当参数之外的写法」');
    assert.match(proc.stdout, /安装完成/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('install.sh：Profile 里没有插件链接时不得打印「安装完成」，并以非 0 退出', () => {
  const home = makeHome();
  const log = path.join(home, 'pnpm.log');
  const bin = makeFakeBin(NOOP_COREPACK);
  try {
    const proc = runInstall({ home, bin, log });
    assert.notEqual(proc.status, 0, '未登记成功必须非 0 退出');
    const out = proc.stdout + proc.stderr;
    assert.match(out, /安装未完成/);
    assert.doesNotMatch(out, /安装完成。/);
    assert.match(out, /pnpm install/, '必须给出可复制的补救命令');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('install.sh：未显式给 DSH_HOME 时回落到 ~/.dsh（而不是猜别的目录）', () => {
  const home = makeHome(null);
  // 该用例专门验证「无 DSH_HOME」分支：profile 必须放在 ~/.dsh/profiles/web
  const profileDir = path.join(home, '.dsh', 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2)}\n`);
  const log = path.join(home, 'pnpm.log');
  const bin = makeFakeBin(OK_COREPACK);
  try {
    const proc = runInstall({ home, bin, log, extraEnv: { DSH_HOME: undefined } });
    assert.equal(proc.status, 0, proc.stdout + proc.stderr);
    assert.match(proc.stdout, /安装完成/);
    // preset 必须落在 ~/.dsh 下
    assert.ok(fs.existsSync(path.join(home, '.dsh', '.agent-presets', 'wecom-obsidian-collector', 'preset.yml')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('install.sh：显式 DSH_HOME 指向不存在的 Profile 时，报错并给出可复制的命令', () => {
  const home = makeHome(null); // 不建 profiles/web
  const bin = makeFakeBin(OK_COREPACK);
  try {
    const proc = runInstall({ home, bin, log: path.join(home, 'pnpm.log') });
    assert.notEqual(proc.status, 0);
    const out = proc.stdout + proc.stderr;
    assert.match(out, /找不到 DSH Profile 目录/);
    assert.match(out, /DSH_HOME=\/path\/to\/dsh-home bash install\/install\.sh/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// ── 真实环境踩到的两个坑（2026-09 全新安装时复现）────────────────────────────

const STORE_AWARE_COREPACK = `#!/bin/sh
echo "$*" >> "$FAKE_PNPM_LOG"
# 模拟 pnpm：Profile 里已有 node_modules 且没显式给 --store-dir 时拒绝换 store
case " $* " in
  *" --store-dir "*) : ;;
  *)
    if [ -f "$PWD/node_modules/.modules.yaml" ]; then
      echo "ERR_PNPM_UNEXPECTED_STORE" >&2
      exit 1
    fi
    ;;
esac
# 注意：显式 store 会被插到子命令之前（pnpm --store-dir X add …），
# 所以不能假设 add 一定在 $2。
case " $* " in
  *" add "*)
    mkdir -p "$PWD/node_modules"
    ln -sfn "$PLUGIN_FOR_TEST" "$PWD/node_modules/dsh-wecom-obsidian"
    ;;
esac
exit 0
`;

test('install.sh：复用 Profile 既有 pnpm store（ERR_PNPM_UNEXPECTED_STORE 回归）', () => {
  const home = makeHome();
  // 复刻真实形态：既有 node_modules 是用另一个 store 装的
  const store = path.join(home, 'other-store');
  fs.mkdirSync(store, { recursive: true });
  const modulesDir = path.join(home, 'profiles', 'web', 'node_modules');
  fs.mkdirSync(modulesDir, { recursive: true });
  fs.writeFileSync(path.join(modulesDir, '.modules.yaml'),
    `${JSON.stringify({ packageManager: 'pnpm@11.7.0', storeDir: store }, null, 2)}\n`);
  const log = path.join(home, 'pnpm.log');
  const bin = makeFakeBin(STORE_AWARE_COREPACK);
  try {
    const proc = runInstall({ home, bin, log });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.some((line) => line.includes(`--store-dir ${store}`)),
      `必须把既有 store 显式传给 pnpm，实际：${JSON.stringify(calls)}`);
    assert.equal(proc.status, 0, proc.stdout + proc.stderr);
    assert.match(proc.stdout, /复用既有 pnpm store/);
    assert.match(proc.stdout, /安装完成/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('install.sh：旧桥接行只出现在注释里时不得误报冲突', () => {
  const home = makeHome();
  const patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  fs.writeFileSync(patch, [
    '# 旧 @local/dsh-wecom-aibot-host 运行入口已于 2026-09-14 停用。',
    '# 企微长连接统一由 bundle dsh-wecom-obsidian 托管。',
    '[]',
    '',
  ].join('\n'));
  const bin = makeFakeBin(OK_COREPACK);
  try {
    const proc = runInstall({ home, bin, log: path.join(home, 'pnpm.log') });
    const out = proc.stdout + proc.stderr;
    assert.doesNotMatch(out, /检测到旧的企微桥接插件行/, '注释里的提及不应触发冲突告警');
    assert.equal(proc.status, 0, out);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('install.sh：旧桥接行真的启用时仍然告警', () => {
  const home = makeHome();
  const patch = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  fs.writeFileSync(patch, [
    '- id: legacy-bridge',
    "  name: '@local/dsh-wecom-aibot-host'",
    '  config: {}',
    '',
  ].join('\n'));
  const bin = makeFakeBin(OK_COREPACK);
  try {
    const proc = runInstall({ home, bin, log: path.join(home, 'pnpm.log') });
    assert.match(proc.stdout + proc.stderr, /检测到旧的企微桥接插件行/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
