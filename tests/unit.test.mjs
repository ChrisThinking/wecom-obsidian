#!/usr/bin/env node
/**
 * 纯函数单测（无需启动 DSH）
 * ============================================================================
 * 覆盖的都是**真实踩过的坑**：这些函数一旦回归，症状是「静默出错」而不是报错，
 * 所以必须有断言盯着：
 *
 *   1. `resolveInboxDir` —— 媒体落点。历史上相对路径会落到 DSH 进程 cwd，
 *      `{top}` 会生成名为 `{top}` 的字面目录。
 *   2. `reindexOverridesAfterRemove` —— 覆盖表按下标存键，删除机器人后不重排
 *      会让**密钥/白名单错位到别的机器人**。
 *   3. `resolveRelDir`（Python 侧）—— 由 `pipeline/scripts/tests/test_path_rules.py` 覆盖。
 *   4. `package-lock.json` —— 依赖版本可复现性。缺 lock 时 `^` 区间会在 clone 后
 *      解析到更新的版本，症状是「本机正常、别人装完就报错」，同样属于静默出错。
 *
 * 用法：
 *   node --test pipeline/tests/*.test.mjs      # 或
 *   node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const require = createRequire(import.meta.url);

const workspaceSrc = fs.readFileSync(path.join(ROOT, 'lib', 'workspace.js'), 'utf8');
const clientSrc = fs.readFileSync(path.join(ROOT, 'client', 'client.js'), 'utf8');

// 直接导入真实模块（而不是用正则从源码里抠函数体 —— 那个做法会被正则字面量里的
// 花括号骗到）。resolveInboxDir 是 lib/workspace.js 的具名导出。
const { resolveInboxDir } = await import(path.join(ROOT, 'lib', 'workspace.js'));

// 客户端 bundle 不是模块：用最小 React 桩 + ModuleLoader 桩把它跑起来，
// 它会把内部纯函数挂到 globalThis.__wecomObsidianInternals 供这里断言。
const ReactStub = {
  createElement: () => null,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useMemo: (fn) => fn(),
  useEffect: () => {},
  useCallback: (fn) => fn,
};
const loadClientBundle = async () => {
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        // 只要执行工厂体即可：apply 不会被调用，不需要真实的 ctx。
        factory((spec) => {
          if (spec === 'react') return ReactStub;
          throw new Error(`意外的 require: ${spec}`);
        });
      },
    },
  };
  await import(`${path.join(ROOT, 'client', 'client.js')}?test=${Date.now()}`);
  const internals = globalThis.__wecomObsidianInternals;
  assert.ok(internals, 'client.js 未暴露 __wecomObsidianInternals 测试接缝');
  return internals;
};
const { reindexOverridesAfterRemove } = await loadClientBundle();

const WORKSPACE = '/tmp/test-ws/workspace';
const VAULT = '/tmp/test-vault';
const base = () => ({ vaultRoot: VAULT, store: { topFolder: '01_文章分享' } });

test('resolveInboxDir：留空默认落在库内 <top>/attachments', () => {
  const dir = resolveInboxDir({ ...base(), inboxDir: '' }, WORKSPACE);
  assert.equal(dir, path.join(VAULT, '01_文章分享', 'attachments'));
});

test('resolveInboxDir：{top}/attachments 与留空等价', () => {
  const dir = resolveInboxDir({ ...base(), inboxDir: '{top}/attachments' }, WORKSPACE);
  assert.equal(dir, path.join(VAULT, '01_文章分享', 'attachments'));
});

test('resolveInboxDir：{top} 跟随「顶层目录名」设置', () => {
  const settings = { vaultRoot: VAULT, store: { topFolder: '99_Inbox' }, inboxDir: '{top}/media' };
  assert.equal(resolveInboxDir(settings, WORKSPACE), path.join(VAULT, '99_Inbox', 'media'));
});

test('resolveInboxDir：{vault} 展开为库根', () => {
  const settings = { ...base(), inboxDir: '{vault}/_media' };
  assert.equal(resolveInboxDir(settings, WORKSPACE), path.join(VAULT, '_media'));
});

test('resolveInboxDir：{workspace} 展开为工作区（仍支持，便于放回工作区）', () => {
  const settings = { ...base(), inboxDir: '{workspace}/inbox' };
  assert.equal(resolveInboxDir(settings, WORKSPACE), path.join(WORKSPACE, 'inbox'));
});

test('resolveInboxDir：相对路径相对**库根**（不是进程 cwd）', () => {
  const settings = { ...base(), inboxDir: 'media/inbox' };
  assert.equal(resolveInboxDir(settings, WORKSPACE), path.join(VAULT, 'media', 'inbox'));
});

test('resolveInboxDir：绝对路径原样使用', () => {
  const settings = { ...base(), inboxDir: '/srv/wecom-inbox' };
  assert.equal(resolveInboxDir(settings, WORKSPACE), '/srv/wecom-inbox');
});

test('resolveInboxDir：库未配置时相对路径退回工作区', () => {
  const settings = { vaultRoot: '', store: { topFolder: '01_文章分享' }, inboxDir: 'media/inbox' };
  assert.equal(resolveInboxDir(settings, WORKSPACE), path.join(WORKSPACE, 'media', 'inbox'));
});

test('resolveInboxDir：未知占位符必须报错（不能产出 {xxx} 字面目录）', () => {
  assert.throws(
    () => resolveInboxDir({ ...base(), inboxDir: '{unknown}/x' }, WORKSPACE),
    /占位符不受支持/,
  );
});

test('resolveInboxDir：多个占位符同时展开', () => {
  const settings = { ...base(), inboxDir: '{vault}/{top}/att' };
  assert.equal(resolveInboxDir(settings, WORKSPACE), path.join(VAULT, '01_文章分享', 'att'));
});

test('reindexOverridesAfterRemove：删除中间项后覆盖与机器人保持对齐', () => {
  const overrides = {
    0: { botId: 'BOT0', secret: 'S0' },
    1: { botId: 'BOT1', secret: 'S1' },
    2: { botId: 'BOT2', secret: 'S2', policy: 'allowlist' },
  };
  const next = reindexOverridesAfterRemove(overrides, 0);
  assert.deepEqual(Object.keys(next), ['0', '1']);
  assert.equal(next['0'].botId, 'BOT1', '下标 0 应接上原下标 1 的机器人');
  assert.equal(next['1'].botId, 'BOT2');
  assert.equal(next['0'].secret, 'S1', '密钥必须随机器人移动，不能错位');
  assert.equal(next['1'].policy, 'allowlist', '白名单策略必须随机器人保留');
});

test('reindexOverridesAfterRemove：删除末尾项不影响其它', () => {
  const overrides = { 0: { botId: 'A' }, 1: { botId: 'B' } };
  const next = reindexOverridesAfterRemove(overrides, 2);
  assert.deepEqual(next, overrides);
});

test('reindexOverridesAfterRemove：删除最后一项只移除该项', () => {
  const overrides = { 0: { botId: 'A' }, 1: { botId: 'B' } };
  const next = reindexOverridesAfterRemove(overrides, 1);
  assert.deepEqual(Object.keys(next), ['0']);
  assert.equal(next['0'].botId, 'A');
});

test('reindexOverridesAfterRemove：空/非法输入安全', () => {
  assert.deepEqual(reindexOverridesAfterRemove(undefined, 0), {});
  assert.deepEqual(reindexOverridesAfterRemove(null, 0), {});
  assert.deepEqual(reindexOverridesAfterRemove({}, 3), {});
  // 非数字键（历史脏数据）应被丢弃而不是错位
  assert.deepEqual(reindexOverridesAfterRemove({ x: { a: 1 }, 0: { b: 2 } }, 5), { 0: { b: 2 } });
});

test('package.json：DSH 插件包声明完整（可发布/可安装）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.name, 'name 必须存在');
  assert.ok(!pkg.name.startsWith('@local/'), '包名不能带 @local 作用域（GitHub 安装者无法解析）');
  assert.notEqual(pkg.private, true, 'private: true 会阻止发布');
  const patch = pkg.dsh?.bundle?.patch;
  assert.ok(patch && fs.existsSync(path.join(ROOT, patch)), 'dsh.bundle.patch 必须指向存在的文件');
  const clientExport = pkg.exports?.['./client']?.default;
  assert.ok(clientExport && fs.existsSync(path.join(ROOT, clientExport)), 'exports["./client"] 必须指向存在的文件');
  assert.equal(pkg.dsh?.client?.platform, 'web');
});

/**
 * 极简 semver 判定：只覆盖本仓库实际使用的 `^` / `~` / 精确版本三种写法，
 * 其余复杂范围（`>=`、`||`、`1.x` 等）不做判定并返回 true —— 避免测试误报。
 */
const satisfiesRange = (range, version) => {
  const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m || !v) return true;
  const op = m[1];
  const want = [Number(m[2]), Number(m[3]), Number(m[4])];
  const got = [Number(v[1]), Number(v[2]), Number(v[3])];
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  if (cmp(got, want) < 0) return false;              // 低于下限
  if (op === '') return cmp(got, want) === 0;        // 精确版本
  if (op === '~') return got[0] === want[0] && got[1] === want[1];  // ~ 锁次版本
  return want[0] > 0                                 // ^ 锁主版本（0.x 时锁次版本）
    ? got[0] === want[0]
    : got[0] === 0 && got[1] === want[1];
};

test('package-lock.json：必须提交且与 package.json 依赖一致（否则 clone 后装出不同版本）', () => {
  const lockPath = path.join(ROOT, 'package-lock.json');
  assert.ok(fs.existsSync(lockPath), 'package-lock.json 必须存在（依赖版本需可复现）');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.ok(lock.lockfileVersion >= 2, `lockfileVersion 应 >= 2（当前 ${lock.lockfileVersion}）`);
  const root = lock.packages?.[''];
  assert.ok(root, 'lock 缺少根包条目 packages[""]');
  assert.equal(root.name, pkg.name, 'lock 根包 name 必须与 package.json 一致');
  assert.equal(root.version, pkg.version, 'lock 根包 version 必须与 package.json 一致');
  // 依赖集合一一对应：防止改了 package.json 却忘了同步 lock
  assert.deepEqual(
    root.dependencies ?? {}, pkg.dependencies ?? {},
    'lock 根包 dependencies 必须与 package.json 完全一致',
  );
  // 每个运行时依赖都必须钉死到确切版本，且落在声明的区间内
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    const entry = lock.packages?.[`node_modules/${name}`];
    assert.ok(entry, `lock 缺少 ${name} 的解析结果`);
    assert.match(entry.version, /^\d+\.\d+\.\d+/, `${name} 在 lock 中必须钉死确切版本`);
    assert.ok(
      satisfiesRange(range, entry.version),
      `${name} 锁定版本 ${entry.version} 不满足 package.json 声明的 ${range}`,
    );
  }
});

test('客户端 bundle：module id 必须与包名一致（否则浏览器加载失败）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const match = /window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientSrc);
  assert.ok(match, 'client.js 必须是 ModuleLoader 格式');
  assert.equal(match[1], pkg.name, 'client.js 的 id 必须等于 package.json 的 name');
});

test('源文件权限：others 必须可读（否则 clone 后无法运行）', () => {
  const files = [
    'package.json', 'lib/index.js', 'client/client.js',
    'bundle/cordis.patch.yml', 'install/install.sh',
  ];
  for (const rel of files) {
    const mode = fs.statSync(path.join(ROOT, rel)).mode & 0o777;
    assert.ok(mode & 0o004, `${rel} 必须对 others 可读（当前 ${mode.toString(8)}）`);
  }
});
