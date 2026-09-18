# wecom-obsidian

> **An open-source, agent-powered bridge that turns links shared in WeCom into structured, local-first knowledge in Obsidian.**

**WeCom → AI Agent → Obsidian**

企业微信机器人「收藏网址 → Obsidian」一体化 DSH 插件。  
在企微中发送一个链接，系统自动完成内容采集、清洗、图片本地化、结构化处理，并归档到你的 Obsidian Vault。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-5b8def)](https://github.com/deepseek-ai/deepseek-harness)

---

## Why this project

Knowledge shared in messaging platforms is easy to lose.

**wecom-obsidian** connects WeCom, AI agents, web content extraction, and Obsidian into a single automated pipeline:

```text
WeCom message
      ↓
   AI Agent
      ↓
Content extraction
      ↓
Normalization
      ↓
Verification
      ↓
 Local assets
      ↓
Obsidian Vault
```

The project is built around three principles:

- **Local-first** — notes and assets remain in your own Obsidian Vault.
- **Agent-powered** — collection and processing are orchestrated through a dedicated AI agent workflow.
- **Open and extensible** — the pipeline, storage rules, and integrations are open source and designed to be extended.

The current implementation supports content collection from WeChat articles, Xiaohongshu, Toutiao, and general web pages, with local image storage, deduplication, configurable archive rules, and multiple WeCom bots.

---

## 它解决什么问题

企业微信里看到一篇好文章，想存进 Obsidian —— 通常要经过：复制链接 → 切换 App →
打开插件 → 粘贴 → 等抓取 → 手动整理格式 → 手动归类目录。

这个插件把它压成**一步**：在企微里给机器人发那条链接。

```
企微消息  →  长连接  →  收藏会话（专职 Agent）  →  采集流水线  →  Obsidian 库
             wss        acquire/format/store      convert/format/verify/store   年/月/标题/
```

| 能力 | 说明 |
|---|---|
| **收藏网页** | 微信图文、微信分享页（图片/文字消息）、小红书、头条、其它任意网页 |
| **图片本地化** | 随包落到笔记的资产目录，不依赖外链 |
| **Obsidian 原生格式** | frontmatter + `# 标题` + `assets/` + 源页快照，字段序对齐 WebArticle 模板 |
| **按年月归档** | 默认 `顶层/年/月/标题`，路径规则可配 |
| **自动去重** | 同一 URL 只入库一次，重复收藏直接回「已收藏过」并给出原路径 |
| **多机器人并存** | 一个插件挂多个企微账号，各自独立长连接与会话 |
| **图形化配置** | 全部配置在 DSH 设置页完成，改完即时生效，无需改文件、无需重启 |
| **可重装 / 可升级** | 重跑安装脚本即恢复插件本体（依赖 / Profile 登记 / 预设 / 运行时目录），工作区脚本自动同步到新版；Bot 凭证与 Vault 路径在 `${DSH_HOME}/settings.yaml`、账本在数据目录里 —— DSH_HOME 不变就还在（安装脚本**不碰**它们），DSH_HOME 变了需自行备份迁移 |

---

## 快速开始

### 前置条件

| 依赖 | 用途 | 是否必需 |
|---|---|---|
| **DSH** + 一个 Profile（默认 `web`） | 插件以 Profile Bundle 形式装载 | 必需 |
| **Node.js ≥ 18** | 插件本体、企微长连接 | 必需 |
| **Python ≥ 3.8** | 采集流水线 | 必需（否则只能对话，不能收藏）|
| **`beautifulsoup4`** | 微信图文转换器 | 必需（安装脚本会自动装）|
| **`markitdown` CLI** | **仅**「其它任意网页」用 | 可选 |

> 微信 / 小红书 / 头条各有专用转换器，走纯标准库，**不需要 markitdown**。

### 安装

```bash
git clone https://github.com/ChrisThinking/wecom-obsidian.git
cd wecom-obsidian
bash install/install.sh
```

脚本是幂等的，会做这些事：

1. 装插件自身的 Node 依赖（企微长连接 SDK；优先离线复制，否则 `npm install`）；
2. 把宿主的 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 链进来（必须与宿主同一实例）；
3. 在 Profile 里登记 link 依赖 + `dsh.profile.bundles`，并**校验** Profile 的
   `node_modules` 里真的能解析到本包（校验不过就以非 0 退出，不会假报「安装完成」）；
4. 安装收藏专用 Agent 预设到 `${DSH_HOME}/.agent-presets/`；
5. 建运行时数据目录，并按需自动安装 `beautifulsoup4`；
6. 打印一份**依赖预检**结果。

> **升级**：拉取新代码后重跑一次安装脚本并重启 DSH 即可。插件包里的 `pipeline/` 是脚本的
> 唯一事实源，运行时工作区里的 `scripts/` 会在每次物化时**自动同步到新版**（不会再出现
> 「升级了却还在跑旧脚本」）；`staging/`、`logs/` 和你在工作区里自建的文件不受影响。
>
> **DSH_HOME 怎么定**：显式 `DSH_HOME` 环境变量 > 正在运行的 dsh 进程的环境 > `~/.dsh`。
> 如果你的 DSH_HOME 不是 `~/.dsh`（例如指向某个工作区目录），请显式传入：
> `DSH_HOME=/path/to/dsh-home bash install/install.sh`。
> 脚本只写这个 DSH_HOME 下的 Profile / preset / 数据目录，不会创建第二份配置。

然后重启 DSH 使 composition 生效：

```bash
launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh.web   # macOS launchd
# 或直接重启你启动 dsh 的那个进程
```

<details>
<summary>另一种安装方式：让 DSH 直接从 GitHub 装（不手动 clone）</summary>

```bash
dsh plugin --profile web add github:ChrisThinking/wecom-obsidian
```

`dsh plugin` 是 pnpm 的转发器；它会把仓库装进 Profile 的 `node_modules`，并因为本包声明了
`dsh.bundle` 而自动加入 `dsh.profile.bundles`。

装完后仍需生成收藏预设（预设要落到 `.agent-presets/`）：先用 node 找出刚装好的插件目录，
再用它跑一次 `install.sh`（脚本幂等，已有的依赖会跳过）。**DSH_HOME 必须与 DSH 实际使用的一致**：

```bash
DSH_HOME=/path/to/dsh-home          # 不是 ~/.dsh 时必须显式指定
PLUGIN_DIR="$(dirname "$(node -e "console.log(require.resolve('dsh-wecom-obsidian/package.json',{paths:['$DSH_HOME/profiles/web']}))")")"
DSH_HOME="$DSH_HOME" bash "$PLUGIN_DIR/install/install.sh"
```

> `dsh plugin list` 的输出格式随版本变化，**不要**指望用它拼出插件路径；
> 上面的 `require.resolve(...)` 直接问 Node 要真实路径，稳定得多。
> 最省事的做法仍然是 clone 一份仓库，然后 `bash install/install.sh`。
</details>

### 方式三：让 AI 自动安装（复制提示词给 Harness / Codex）

不想自己敲命令：把下面整段**提示词**复制给你的 AI 编码助手（DSH Harness、Codex、Claude Code 等），
它会自己完成前置检查、clone、安装、重启与自检，并在需要用 Bot 凭证时来问你。

提示词里**不含任何凭证**，Secret 始终只由你在 DSH 设置页填写。

````text
你在这台机器上替我安装 DSH 插件「wecom-obsidian」（在企微里发链接 → 自动采集、清洗、按年月归档进 Obsidian）。
请按下面步骤执行；每步先说你要跑什么再跑，需要我提供信息时停下来问我，不要猜、不要臆造。

1) 前置检查（缺任何一项就停下告诉我，不要硬装）
   - node -v ≥ 18、python3 -V ≥ 3.8（采集流水线必需，缺了只能对话不能收藏）、npm、git 均可用
   - 确认 DSH 已安装，并确定 DSH_HOME：优先取环境变量 $DSH_HOME；没有就读正在运行的
     dsh 进程的环境；再没有才是 ~/.dsh。把最终认定值和判断依据告诉我。

2) 安装（幂等，可反复执行）
   git clone https://github.com/ChrisThinking/wecom-obsidian.git
   cd wecom-obsidian
   DSH_HOME=<第 1 步认定值> bash install/install.sh     # 认定值就是 ~/.dsh 时可省略前缀
   脚本会：装企微长连接 Node 依赖 → 把宿主的 cordis/schemastery 链进来 → 在 Profile
   （默认 web，可用 DSH_PROFILE 覆盖）登记 bundle → 安装收藏 Agent 预设 → 建运行时目录 →
   按需装 beautifulsoup4 → 打印依赖预检。
   退出码非 0 就是**没装成**：把最后 20 行输出贴给我，不要继续下一步。

3) 重启 DSH 让 composition 生效（**这一步先问我**）
   macOS launchd：launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh.web
   其它启动方式：重启你启动 dsh 的那个进程。

4) 自检并把结果告诉我
   - DSH 日志里应出现一行 [wecom-obsidian] applied
   - ${DSH_HOME}/wecom-obsidian/health/*.json 是每个机器人的在线状态
   - 打开 DSH「设置 → 企微 Obsidian 收藏」，确认配置节正常渲染

5) 需要我提供（不要臆造、不要回显、不要写进任何文件或日志）
   - 机器人名称 / Bot ID / Secret（企微智能机器人后台获取）
   - Obsidian Vault 库根的绝对路径
   收齐后由我在设置页填入。

约束：
- 不要修改仓库源码；不要 git commit / push、不要建分支或 PR。
- 不要为了绕过审批而切到 danger-full-access、approval=never 之类的提权配置；需要授权就问我。
- 安装脚本只应写 ${DSH_HOME} 下的 Profile / preset / 数据目录，其它位置不要动。
- 凭证只存在于 ${DSH_HOME}/settings.yaml：不要打印、不要提交、不要贴进 issue 或日志。

参考：仓库 README.md（快速开始 / 配置 / 排障）与 docs/plugin.md。
````

<details>
<summary>English prompt (paste into Codex / Claude Code / any coding agent)</summary>

````text
Install the DSH plugin "wecom-obsidian" on this machine: it turns links shared in WeCom
into structured, local-first notes in an Obsidian vault.

Follow these steps, and say what you are about to run before running it.

1) Preconditions — stop and report if anything is missing; do not force the install:
   - node >= 18, python3 >= 3.8 (required by the collection pipeline), npm, git
   - DSH installed. Resolve DSH_HOME in this order: the $DSH_HOME environment variable,
     then the environment of the running dsh process, then ~/.dsh. Tell me which one you
     concluded, and why.

2) Install (idempotent, safe to re-run):
   git clone https://github.com/ChrisThinking/wecom-obsidian.git
   cd wecom-obsidian
   DSH_HOME=<resolved in step 1> bash install/install.sh     # omit the prefix if it is ~/.dsh
   The script installs the plugin's Node dependencies, links the host's cordis/schemastery,
   registers the bundle in the DSH profile (default: web, override with DSH_PROFILE),
   installs the collector agent preset, creates the runtime directories, installs
   beautifulsoup4 when needed, and prints a dependency pre-check.
   A non-zero exit means it did NOT install: paste the last 20 lines to me and stop.

3) Restart DSH so the new composition takes effect (ask me first):
   macOS launchd: launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh.web
   otherwise: restart whichever process runs dsh.

4) Verify and report:
   - the DSH log should contain a line "[wecom-obsidian] applied"
   - ${DSH_HOME}/wecom-obsidian/health/*.json holds the per-bot online state
   - DSH Settings -> "企微 Obsidian 收藏" should render the configuration section

5) Ask me for the values you must not invent, echo, or write to any file or log:
   - bot name, Bot ID, Secret (from the WeCom bot console)
   - the absolute path of my Obsidian vault root
   I will enter them on the settings page myself.

Constraints:
- Do not modify the repository source; do not commit, push, branch, or open a PR.
- Do not escalate permissions (danger-full-access, approval=never, ...) just to bypass an
  approval prompt; ask me instead.
- The installer should only write under ${DSH_HOME}; do not touch anything else.
- Credentials live only in ${DSH_HOME}/settings.yaml: never print, commit, or paste them.

Reference: README.md (Quick start / Configuration / Troubleshooting) and docs/plugin.md.
````

</details>

### 配置

打开 DSH 设置 → **企微 Obsidian 收藏**。

**机器人部分只需要三项**：

| 字段 | 说明 |
|---|---|
| 机器人名称 | 用于日志、健康状态与会话 id 派生 |
| Bot ID | 企微智能机器人后台获取 |
| Secret | 同上。**只写字段**：保存后不回传浏览器，留空表示不修改 |

其余参数全部自动推断（会话 id、能力开关、模型路由），无需填写。

**全局部分**：

| 字段 | 说明 |
|---|---|
| Obsidian 导入地址 | Vault 库根绝对路径 |
| 存储路径规则 | 默认 `{top}/{YYYY}/{MM}/{name}`（年/月）|
| 顶层目录名 | 规则里 `{top}` 的取值 |
| 资源目录名 | 随包图片目录名，默认 `assets` |
| 采集工作目录 | 脚本与中间产物所在处，留空用插件数据目录 |

每张机器人卡片有**启用/停用 · 保存应用 · 放弃修改 · 删除**，改完即刻生效。

### 使用

在企微里给机器人发：

```
收藏 https://mp.weixin.qq.com/s/xxxx
```

或者直接发链接。机器人会回执、抓取、入库，并告诉你落到哪个路径。

---

## 存储路径规则

支持 5 个占位符：`{top}` 顶层目录 · `{YYYY}` 年 · `{MM}` 月 · `{platform}` 平台 · `{name}` 笔记名。

| 想要的效果 | 填这个 | 实际落点 |
|---|---|---|
| 年/月（默认） | `{top}/{YYYY}/{MM}/{name}` | `01_文章分享/2026/09/标题` |
| 只按年 | `{top}/{YYYY}/{name}` | `01_文章分享/2026/标题` |
| 平台优先 | `{platform}/{YYYY}/{MM}/{name}` | `微信/2026/09/标题` |
| 顶层下再分平台 | `{top}/{platform}/{YYYY}/{name}` | `01_文章分享/微信/2026/标题` |

> ⚠️ `{platform}` 写在 `{top}` **之前**时，顶层就是平台目录，`{top}` 不参与拼接。
> 设置页检测到这种写法会就地提示。

每篇笔记是一个**原子资产包**：

```
<规则解析出的目录>/<标题>/
├── <标题>.md          # frontmatter + 正文
├── assets/            # 本地化后的图片（名字由「资源目录名」决定）
└── source_page.html   # 源页快照
```

---

## 架构

```
┌─ Host 半边（lib/）─────────────────────────────────────────────┐
│  index.js          装配：设置 namespace / shellEnv / 工作区物化   │
│  settings-ns.js    设置 schema（唯一配置事实源）                  │
│  workspace.js      设置 → 流水线配置物化 + 路径解析                │
│  wecom-client.js   一条 wss 长连接（重连/自愈/控制通道/媒体下载）    │
│  session-router.js 收藏 vs 对话路由、Agent 会话编排、回合等待       │
├─ Client 半边（client/）─────────────────────────────────────────┤
│  client.js         DSH 设置页「企微 Obsidian 收藏」配置节          │
├─ 采集流水线（pipeline/）────────────────────────────────────────┤
│  scripts/convert   URL → Content Package（微信/小红书/头条/通用）  │
│  scripts/format    → Note Package（frontmatter + 资产收敛）       │
│  scripts/verify    确定性校验（内置在 store 前）                    │
│  scripts/manage    → Stored Asset（原子入库 + ledger 去重）        │
│  skills/           acquire / obsidian-format / obsidian-store     │
├─ 收藏 Agent 预设（bundle/agent/）───────────────────────────────┤
│  安装到 ${DSH_HOME}/.agent-presets/wecom-obsidian-collector/      │
└────────────────────────────────────────────────────────────────┘
```

**两条会话线刻意分开**：

| 会话 | 预设 | 权限 | 用途 |
|---|---|---|---|
| 对话会话 | `cordis`（通用） | 普通 | 普通问答 |
| 收藏会话 | `wecom-obsidian-collector` | `danger-full-access` + `approval=never` | 采集链（要写真实 Vault）|

提权只落在收藏会话：企微渠道无人能应答审批弹窗，而采集链必须能写库。

收藏会话还通过 `prepend` 注册 `user-questions/request` 应答者，避免 `ask_user_question`
在无人应答时永久挂起。

---

## 运行时位置

| 路径 | 内容 |
|---|---|
| `${DSH_HOME}/wecom-obsidian/workspace/` | 工作区根：脚本、staging、去重账本 |
| `${DSH_HOME}/wecom-obsidian/health/<slug>.json` | 每个机器人在线状态 |
| `${DSH_HOME}/wecom-obsidian/control/<slug>.cmd` | 单实例控制口（写 `start`/`stop`/`restart`）|
| `${DSH_HOME}/.agent-presets/wecom-obsidian-collector/` | 收藏 Agent 预设 |
| `${DSH_HOME}/settings.yaml` | 配置真值（0600 的 `wecom-obsidian` 段）|

---

## 排障

```bash
# 1) 插件是否加载（应有一行 applied）
grep "\[wecom-obsidian\]" ~/Library/Logs/dsh/launchd-stdout.log | tail

# 2) 机器人是否在线
cat "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/health/"*.json

# 3) 单独停/启一个机器人（slug 见 health 文件名）
echo stop  > "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/control/<slug>.cmd"
echo start > "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/control/<slug>.cmd"

# 4) 配置是否正确物化
cat "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/workspace/config/obsidian.json"
```

| 现象 | 先查 |
|---|---|
| 机器人一直 `connecting` | Bot ID / Secret 是否正确；企微后台是否允许长连接 |
| 机器人在线但收藏没反应 | 消息是否含 URL；该机器人的收藏能力是否开启 |
| 每条消息都回「无法生成可回复的内容」 | 日志里 `router.turn.error` 的 `detail.message` |
| 笔记没落进 Vault | 「Obsidian 导入地址」是否为绝对路径；看 health 里的 `lastError` |
| 设置页显示 0 个机器人 | 页面状态行会显示读到的值/错误；再硬刷新一次 |

更细的**故障复盘**（按错误串检索、含真实原因与改法）见 [`docs/plugin.md`](./docs/plugin.md)。

---

## 卸载

```bash
bash install/uninstall.sh          # 卸载插件，保留运行时数据
bash install/uninstall.sh --purge  # 连运行时数据一起删
```

---

## 开发

```bash
npm run check              # 全部测试（JS 单测/设置服务回归 + Python 流水线回归）
bash install/install.sh    # 重装到本机 Profile（非 ~/.dsh 时先 export DSH_HOME=…）
```

仓库根就是 npm 包根（`package.json` 在根），因此：

- `dsh.bundle.patch` → `bundle/cordis.patch.yml`（composition 行的**唯一**来源）
- `dsh.client` → `exports["./client"]` → `client/client.js`（浏览器 bundle）
- 客户端 bundle 是**手写的 ModuleLoader 格式**，没有构建步骤 —— clone 即可用

> 改代码后请同步更新 `docs/plugin.md` 里对应的说明，并按 `agent.md` 的约定提交 commit。

---

## Project status

**wecom-obsidian** is an early-stage open-source project under active development.

The current implementation is already used in a real-world workflow, while the installation process, tests, documentation, integrations, and contributor experience continue to evolve.

Contributions, bug reports, integration ideas, and documentation improvements are welcome.

---

## Roadmap

Current development priorities include:

- [ ] Expand automated test coverage
- [ ] Add CI validation for pull requests
- [ ] Improve failure recovery and observability
- [ ] Expand supported content sources and compatibility
- [ ] Add automated dependency and security checks

---

## Contributing

Contributions are welcome.

If you find a bug or have an integration idea, please open an issue.

For code changes, please open a pull request with a short description of the problem, the proposed change, and how the change was tested.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

For security-sensitive issues, please see [SECURITY.md](SECURITY.md).

---

## License

[MIT](./LICENSE)
