/**
 * 工作区与配置物化
 * ============================================================================
 * 采集流水线的 Python 脚本原本依赖一个「工作区根」：向上找到含
 * `config/pipeline.json` 的目录即可。脚本本身已经完全参数化（`OBS_WS_ROOT`
 * 显式覆盖），因此本插件不需要改动脚本核心逻辑，只需要：
 *
 *   1. 把工作区根指到插件自己的数据目录（插件包内的 `pipeline/` 作为**只读
 *      模板源**，首次运行时复制成可写工作区）；
 *   2. 把浏览器设置页里的值**物化**成脚本读取的 `config/obsidian.json` /
 *      `config/pipeline.json`，让「设置」成为唯一事实源而不是第二份配置。
 *
 * 目录约定（全部可被设置覆盖）：
 *
 *   ${DSH_HOME}/wecom-obsidian/            ← 插件数据目录（dataRoot）
 *     settings.json                        ← 运行时快照（只读派生，非事实源）
 *     workspace/                           ← 工作区根 = OBS_WS_ROOT
 *       config/{obsidian,pipeline,runtime}.json
 *       scripts/…  templates/…  rule_src/…
 *       staging/converted|formatted|inbox
 *       logs/{runs,state}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（`lib/` 的上一级）。 */
export const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 只读模板源：随插件包分发的流水线骨架。 */
export const TEMPLATE_PIPELINE = path.join(PLUGIN_ROOT, 'pipeline');

/**
 * 解析插件数据目录。
 * @returns {string} 绝对路径。
 */
export function dataRoot() {
  const home = process.env.DSH_HOME || path.join(process.env.HOME || '.', '.dsh');
  return path.join(home, 'wecom-obsidian');
}

/**
 * 解析工作区根：设置里的 `workspaceRoot` 优先，否则用数据目录下的 `workspace`。
 * @param {object} settings - 已解析的设置值。
 * @returns {string} 绝对路径。
 */
export function workspaceRoot(settings) {
  const configured = settings && typeof settings.workspaceRoot === 'string' ? settings.workspaceRoot.trim() : '';
  return configured ? path.resolve(configured) : path.join(dataRoot(), 'workspace');
}

/**
 * 递归复制目录；已存在的文件不覆盖（模板只在首次落位）。
 *
 * `excludeTop` 用于跳过顶层某些子目录。目前只排 `skills`：Skill 的**唯一副本**
 * 在插件包的 `pipeline/skills/`，收藏预设直接指向那里；再拷一份到运行时工作区
 * 就是纯粹的重复（改一处另一处不跟着变），而工作区那份从来没被读过。
 *
 * @param {string} from - 源目录。
 * @param {string} to - 目标目录。
 * @param {Set<string>} [excludeTop] - 需要跳过的顶层条目名。
 */
function copyTreeMissing(from, to, excludeTop) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  const isTop = from === TEMPLATE_PIPELINE;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (isTop && excludeTop && excludeTop.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTreeMissing(src, dst);
    else if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
  }
}

/**
 * 原子写 JSON（先写临时文件再 rename），避免脚本读到半截配置。
 * @param {string} file - 目标文件。
 * @param {object} value - 要写入的 JSON 值。
 */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 由设置推导 `store` 段。
 *
 * 脚本读取 `store.top_folder` / `store.month_field` / `store.folder_pattern`，
 * 并**自己**把最终位置拼成 `<OBS_VAULT_ROOT>/<top_folder>/<年>[/<月>]/<name>`。
 * 因此这里要做两件事：
 *
 *   1. `top_folder` 不是「顶层目录名」而是「相对 OBS_VAULT_ROOT 的完整前缀」
 *      —— 这样 `{top}` 段后面的年/月由脚本拼，不会出现前缀被重复拼一次；
 *   2. 「是否按月」由 `month_field` 是否存在（或模式里有没有 `MM`）决定。
 *
 * @param {object} settings - 已解析的设置值。
 * @returns {object} `config/obsidian.json` 的 `store` 段。
 */
export function storeSection(settings) {
  const store = (settings && settings.store) || {};
  const topFolder = String(store.topFolder || '01_文章分享');
  const folderPattern = String(store.folderPattern || '{top}/{YYYY}/{MM}/{name}');
  const monthly = folderPattern.includes('{MM}');
  const platformDir = folderPattern.includes('{platform}');
  return {
    rule: monthly ? 'monthly' : 'yearly',
    top_folder: topFolder,
    folder_pattern: folderPattern,
    year_field: 'created',
    month_field: monthly ? 'created' : '',
    platform_map: {
      'mp.weixin.qq.com': '微信',
      'xiaohongshu.com|xhslink.cn': '小红书',
      default: '网页',
    },
    platform_dir: platformDir,
    assets_dir: String(store.assetsDir || 'assets'),
    naming: {
      pattern: '纯标题（Obsidian 默认标题命名）',
      cleanup: '禁符→_；压缩空白；去首尾点空格；上限120字',
      conflict: store.conflictSuffix === false ? '同名直接失败' : '-2/-3 递增（名称保护）',
    },
    package: '<name>/{<name>.md + assets/ + source_page.html}（原子资产包）',
    source_page: '保留在 Stored Asset',
  };
}

/**
 * 由设置推导 `config/obsidian.json` 全文。
 *
 * frontmatter schema 与真实 Obsidian WebArticle 模板对齐（字段序即模板序），
 * 刻意保持与既有实现一致，避免入库笔记结构发生漂移。
 *
 * @param {object} settings - 已解析的设置值。
 * @param {string} vaultRoot - 解析后的 vault 绝对路径。
 * @returns {object} 完整配置对象。
 */
export function obsidianConfig(settings, vaultRoot) {
  const layout = vaultLayout(settings, vaultRoot);
  const store = storeSection(settings);
  // top_folder 用「相对 vault 根的完整前缀」（含平台段），脚本据此拼年/月。
  store.top_folder = layout.top;
  return {
    说明:
      '【wecom-obsidian 插件生成】本文件由插件从浏览器设置页物化而来，不是事实源；'
      + '要改规则请改设置页，不要手改本文件（下次物化会覆盖）。',
    vault: {
      kind: 'external',
      vault_root: vaultRoot,
      vault_test_root: 'tests/tmp_vault',
      resolve_order: 'OBS_VAULT_ROOT 环境变量 > vault_root（本文件）> vault_test_root',
    },
    template: {
      name: 'WebArticle',
      path: 'templates/文章模板.md',
      note: '插件内置的 DSH 本地运行模板',
    },
    store,
    frontmatter: {
      schema: {
        title: { type: 'string', default: null, runtime: true },
        type: { type: 'const', default: 'web_article', runtime: false },
        url: { type: 'string', default: '""', runtime: false },
        'author/ID': { type: 'string', default: '""', runtime: false },
        platform: { type: 'string', default: '""', runtime: false },
        published: { type: 'string', default: '""', runtime: false },
        created: { type: 'datetime', default: null, runtime: true },
        path: { type: 'string', default: null, runtime: true },
        read: { type: 'bool', default: false, runtime: false },
        tags: { type: 'array', default: [], runtime: false },
      },
      required: ['title', 'type', 'url', 'created'],
      note: '无 status 字段；流程状态在 ledger',
    },
  };
}

/**
 * 计算交给脚本的 `OBS_VAULT_ROOT` 与相对前缀。
 *
 * **`OBS_VAULT_ROOT` 就是库根本身**：脚本侧由 `wf.resolve_rel_dir()` 依据
 * `store.folder_pattern` 拼出完整相对目录（支持 `{top}`/`{platform}`/`{YYYY}`/
 * `{MM}`/`{name}`）。因此插件这边**不再**对 `{platform}` 做特判 —— 早期把它
 * 特判成固定 `'微信'` 是旧 workaround，会让 `{top}/{platform}/…` 把顶层也变成
 * `微信`。
 *
 * @param {object} settings - 已解析的设置值。
 * @param {string} vaultRoot - vault 绝对路径。
 * @param {Date} [when] - 用于取年份的时点，默认当前。
 * @returns {{root: string, top: string, monthly: boolean, platformDir: boolean, year: string}}
 */
export function vaultLayout(settings, vaultRoot, when) {
  const store = (settings && settings.store) || {};
  const pattern = String(store.folderPattern || '{top}/{YYYY}/{MM}/{name}');
  const topFolder = String(store.topFolder || '01_文章分享').replace(/^\/+|\/+$/g, '');
  const platformDir = pattern.includes('{platform}');
  const monthly = pattern.includes('{MM}');
  const date = when instanceof Date ? when : new Date();
  // top 只用于展示/兼容：真正的落点由脚本按 pattern 解析。
  return { root: vaultRoot, top: topFolder, monthly, platformDir, year: String(date.getFullYear()) };
}

/**
 * 从 PATH 里找一个可执行文件（干净安装时的依赖发现）。
 *
 * 脚本自己会用 `markitdown` 这个名字去 PATH 找，但**只有**在它连 PATH 都找不到
 * 的时候才会回落到它源码里写死的路径。所以插件这边先把 PATH 找出来的绝对路径
 * 写进配置，让脚本走「显式路径」分支，避免踩到那个写死的默认值。
 *
 * @param {string} name - 可执行文件名。
 * @returns {string} 绝对路径，找不到时为空串。
 */
function whichSync(name) {
  try {
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* 继续找下一个目录 */ }
    }
  } catch { /* 无 PATH 时放弃 */ }
  return '';
}

/**
 * 解析 markitdown CLI 路径。
 *
 * 优先级：设置页显式配置 > PATH 里的 `markitdown` > 空串。
 * 空串会让脚本用它自己的 PATH 查找，仍找不到时那条收藏请求会明确报错
 * （只影响「其它任意网页」这一路，见 README 的依赖矩阵）。
 *
 * @param {object} settings - 已解析的设置值。
 * @returns {string} 绝对路径或空串。
 */
export function resolveMarkitdown(settings) {
  const configured = String(((settings && settings.pipeline) || {}).markitdownCli || '').trim();
  if (configured) return configured;
  return whichSync('markitdown');
}

/**
 * bs4 等 Python 第三方包的安装目录（插件自管，可用设置覆盖）。
 *
 * @param {object} settings - 已解析的设置值。
 * @returns {string} 绝对路径。
 */
export function sitePackagesOf(settings) {
  const configured = String((((settings || {}).pipeline) || {}).bs4Dir || '').trim();
  return configured || path.join(dataRoot(), 'pylibs');
}

/**
 * 解析媒体收件目录（企微发来的图片/文件下载解密后的落盘位置）。
 *
 * 默认落在 **Obsidian 库内**的收藏主目录下：`<vault>/<顶层目录>/attachments`，
 * 以默认配置为例就是 `01_文章分享/attachments`。这样媒体文件与笔记同在库里，
 * 备份/同步/.gitignore 都跟着库走，不再散落在插件工作区。
 *
 * 支持的写法：
 *   · 留空                → `<vault>/<top>/attachments`（推荐；`{top}` 取 store.topFolder）
 *   · `{top}`             → 收藏主目录名（store.topFolder）
 *   · `{vault}`           → 库根（settings.vaultRoot）
 *   · `{workspace}`       → 插件工作区根
 *   · 绝对路径            → 原样使用
 *   · 其它相对路径        → **相对库根**解析（库未配置时退回相对工作区）
 *
 * @param {object} settings - 已解析的设置值。
 * @param {string} workspace - 工作区根绝对路径。
 * @returns {string} 收件目录绝对路径。
 */
export function resolveInboxDir(settings, workspace) {
  const store = (settings && settings.store) || {};
  const topFolder = String(store.topFolder || '01_文章分享').replace(/^\/+|\/+$/g, '');
  const vaultRoot = String((settings && settings.vaultRoot) || '').trim();
  const raw = String((settings && settings.inboxDir) || '').trim();
  const withTop = (rest) => `{top}/${rest}`;

  // 留空 → 库内 `<top>/attachments`
  const template = raw || withTop('attachments');

  const unknown = template.match(/\{(?!top\}|vault\}|workspace\})[a-zA-Z]+\}/);
  if (unknown) {
    throw new Error(
      `媒体收件目录里的占位符不受支持：${template}（${unknown[0]}）。`
      + '支持 {top}（收藏主目录）/ {vault}（库根）/ {workspace}（工作区）；'
      + '也可以直接留空，默认用 <库根>/<顶层目录>/attachments。',
    );
  }

  const expanded = template
    .replace(/\{top\}/g, topFolder)
    .replace(/\{vault\}/g, vaultRoot)
    .replace(/\{workspace\}/g, workspace);

  if (path.isAbsolute(expanded)) return path.normalize(expanded);

  // 相对路径：优先相对库根（保留库内相对路径的原意），库未配置时退回工作区。
  return vaultRoot
    ? path.resolve(vaultRoot, expanded)
    : path.resolve(workspace, expanded);
}

/**
 * 解析 Python 解释器。
 *
 * 优先级：设置页显式配置 > PATH 里的 python3 > PATH 里的 python > 字面量 `python3`。
 *
 * @param {object} settings - 已解析的设置值。
 * @returns {string} 可执行路径或名字。
 */
export function resolvePython(settings) {
  const configured = String(((settings && settings.pipeline) || {}).pythonBin || '').trim();
  if (configured) return configured;
  return whichSync('python3') || whichSync('python') || 'python3';
}

/**
 * 由设置推导 `config/pipeline.json` 全文。
 * @param {object} settings - 已解析的设置值。
 * @returns {object} 完整配置对象。
 */
export function pipelineConfig(settings) {
  return {
    说明: '【wecom-obsidian 插件生成】由设置页物化，勿手改。',
    webp_to_png: true,
    convert: {
      staging_base: 'staging/converted',
      wechat_output_base: 'staging/converted/微信文章',
      xhs_output_base: 'staging/converted/小红书笔记',
      converters: {
        'mp.weixin.qq.com': 'scripts/convert/wechat_read_v3.py',
        'xhslink.cn|xiaohongshu.com': 'scripts/convert/xhs_convert.py',
        'm.toutiao.com|www.toutiao.com': 'scripts/convert/convert_toutiao.py',
        default: 'scripts/convert/convert_url.py',
      },
      converter_fallbacks: {
        'mp.weixin.qq.com': {
          script: 'scripts/convert/wechat_share_v3.py',
          when: '主转换器判定失败（无 js_content / captcha）时按同域兜底',
          handles: '微信「图片消息」与「文字消息」分享页',
          success_marker: 'md written: <…>.md',
          output_base: 'staging/converted/微信文章',
        },
      },
    },
    format: { out_base: 'staging/formatted', template: 'templates/文章模板.md' },
    logging: {
      runs_dir: 'logs/runs',
      state_dir: 'logs/state',
      processed_urls_file: 'logs/state/processed-urls.jsonl',
      errors_dir: 'logs/state/errors',
    },
    retry: { attempts: 3 },
    _pipeline: (settings && settings.pipeline) || {},
  };
}

/**
 * 由设置推导 `config/runtime.json` 全文。
 * @param {object} settings - 已解析的设置值。
 * @param {string} workspace - 工作区根绝对路径。
 * @returns {object} 完整配置对象。
 */
export function runtimeConfig(settings, workspace) {
  const markitdown = resolveMarkitdown(settings);
  const python = resolvePython(settings);
  return {
    说明: '【wecom-obsidian 插件生成】外部工具与运行参数。',
    workspace: { root: workspace },
    markitdown: {
      cli: markitdown,
      // 留空 = PATH 里没有；此时只有「其它任意网页」这一路会失败，
      // 微信/小红书/头条各有专用转换器，不依赖 markitdown。
      resolved_from: markitdown ? 'settings|PATH' : 'not-found',
      install_note: 'uv tool install "markitdown[all]"（或 pipx install markitdown）；也可在设置页显式填写绝对路径',
    },
    python: { bin: python },
    beautifulsoup4: {
      // 微信图文转换器需要 bs4；它自己会先看 /tmp/pylibs，再回落到 PYTHONPATH。
      // 插件把实际生效的目录写进配置，运维据此安装即可。
      dir: sitePackagesOf(settings),
      install: `python3 -m pip install --target "${sitePackagesOf(settings)}" beautifulsoup4`,
      note: '仅微信图文（mp.weixin.qq.com）需要；分享页/小红书/头条为纯标准库',
    },
    wecom: { managed_by: 'dsh-wecom-obsidian' },
    obsidian_vault: { note: '库内容不在此文件；写入规则见 config/obsidian.json' },
  };
}

/**
 * 确保工作区存在并把当前设置物化进 `config/`。
 *
 * 幂等：可反复调用（每次设置变更后调用一次）。已存在的**非 config** 文件不会
 * 被覆盖，所以用户对模板/脚本的手工调整不会被抹掉。
 *
 * @param {object} settings - 已解析的设置值。
 * @returns {object} 解析后的路径集合与配置。
 */
export function materialize(settings) {
  const workspace = workspaceRoot(settings);
  const vaultRoot = String((settings && settings.vaultRoot) || '').trim();

  // 1. 骨架落位：模板源 → 可写工作区（仅补齐缺失文件）
  copyTreeMissing(TEMPLATE_PIPELINE, workspace, new Set(['skills']));
  // 注意这里不含 `staging/inbox`：媒体收件目录已改为落在 Obsidian 库内
  // （见下方 resolveInboxDir），不再是工作区的一部分。
  for (const sub of ['staging/converted', 'staging/formatted', 'logs/runs', 'logs/state']) {
    fs.mkdirSync(path.join(workspace, sub), { recursive: true });
  }

  // 2. 配置物化
  const obsidian = obsidianConfig(settings, vaultRoot);
  const pipeline = pipelineConfig(settings);
  const runtime = runtimeConfig(settings, workspace);
  writeJsonAtomic(path.join(workspace, 'config', 'obsidian.json'), obsidian);
  writeJsonAtomic(path.join(workspace, 'config', 'pipeline.json'), pipeline);
  writeJsonAtomic(path.join(workspace, 'config', 'runtime.json'), runtime);

  // 3. 媒体收件目录 —— 默认 `<库根>/<顶层目录>/attachments`。
  //
  // 历史坑（都已修）：
  //   · 相对路径曾被当字符串 `path.join()` → 静默落到 DSH 进程的 cwd；
  //   · `{top}`。之类的占位符曾被当普通字符 → 产出名为 `{top}` 的字面目录。
  // 现在占位符显式解析、相对路径相对库根，并且**在这里就把目录建好**，
  // 这样「设置里填了什么」与「磁盘上有没有」是一致的（缺目录会让首条媒体失败）。
  const inbox = resolveInboxDir(settings, workspace);
  try {
    fs.mkdirSync(inbox, { recursive: true });
  } catch (error) {
    // 建不出来不致命：真正落媒体时会再报一次，这里只记录。
    console.warn(`[wecom-obsidian] 无法创建媒体收件目录 ${inbox}: ${String((error && error.message) || error)}`);
  }

  // 3b. Python 第三方包目录（微信图文转换器需要的 beautifulsoup4）。
  //     插件自己管一个目录并保证存在；安装脚本往这里装，运行时通过 PYTHONPATH
  //     暴露给脚本（脚本只会把 /tmp/pylibs 插进 sys.path，见 pipelineEnv 的注释）。
  const pipelineSettings = (settings && settings.pipeline) || {};
  const sitePackages = String(pipelineSettings.bs4Dir || '').trim() || path.join(dataRoot(), 'pylibs');
  try {
    fs.mkdirSync(sitePackages, { recursive: true });
  } catch { /* 建不出来也不致命，失败会在收藏时明确报错 */ }

  // 4. 交给脚本的 vault 根：额外剥掉「顶层/平台」这一段，让脚本自己按年/月拼。
  const layout = vaultLayout(settings, vaultRoot);

  return {
    workspace,
    vaultRoot,
    vaultEnvRoot: layout.root,
    layout,
    inbox,
    sitePackages,
    ledgerFile: path.join(workspace, 'logs', 'state', 'processed-urls.jsonl'),
    scriptsDir: path.join(workspace, 'scripts'),
    obsidian,
    pipeline,
    runtime,
  };
}

/**
 * 为子进程构造采集流水线所需的环境变量。
 *
 * 这些变量名是脚本**已经支持**的覆盖点，因此插件不需要改动任何 Python 代码。
 *
 * @param {object} paths - {@link materialize} 的返回值。
 * @param {object} settings - 已解析的设置值。
 * @returns {object} 追加到 process.env 的键值。
 */
export function pipelineEnv(paths, settings) {
  const env = {
    OBS_WS_ROOT: paths.workspace,
    OBS_LEDGER_FILE: paths.ledgerFile,
  };
  if (paths.vaultEnvRoot) env.OBS_VAULT_ROOT = paths.vaultEnvRoot;

  // markitdown：把 PATH 里解析到的绝对路径显式交给脚本，避开它源码里写死的默认值。
  const markitdown = resolveMarkitdown(settings);
  if (markitdown) env.MARKITDOWN = markitdown;

  // beautifulsoup4：微信图文转换器需要它。脚本只会把 /tmp/pylibs 插进 sys.path，
  // 所以在别处安装的 bs4 要通过 PYTHONPATH 暴露给它 —— 这样无需改脚本。
  if (paths.sitePackages) {
    env.PYTHONPATH = [paths.sitePackages, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}
