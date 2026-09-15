# dsh-wecom-obsidian

> **企业微信机器人「收藏网址 → Obsidian」一体化 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件。**
> 企微里发一条链接，内容自动抓取、清洗、按 `年/月` 归档进你的 Obsidian 库。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-5b8def)](https://github.com/deepseek-ai/deepseek-harness)

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
| **可重装** | 重跑安装脚本即恢复插件本体（依赖 / Profile 登记 / 预设 / 运行时目录）；Bot 凭证与 Vault 路径在 `${DSH_HOME}/settings.yaml`、账本在数据目录里 —— DSH_HOME 不变就还在（安装脚本**不碰**它们），DSH_HOME 变了需自行备份迁移 |

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

## License

[MIT](./LICENSE)
