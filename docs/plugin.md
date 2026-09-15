# dsh-wecom-obsidian — 插件详细文档

> 企业微信机器人「收藏网址 → Obsidian」一体化 DSH 插件。
> 装一次，配置页填几项，企微里发链接就能进库；**重跑一次安装脚本即可恢复插件本体**
> （Bot 凭证 / Vault 路径 / 账本不在插件包里，DSH_HOME 不变就还在，详见下方「安装」）。
>
> 本文是**实现与运维层面的详细说明**（设计取舍、故障复盘、依赖矩阵、配置迁移）。
> 面向使用者的快速上手与安装步骤见仓库根目录的 [`readme.md`](../readme.md)。

---

## 它是什么

把原本分散在四处的能力收进**一个可重装**的插件包：

| 能力 | 原实现位置 | 现在 |
|---|---|---|
| 企微长连接（收消息 / 回执 / 下载媒体） | `@local/dsh-wecom-aibot-host`（独立包 + profile 补丁行） | 本插件 Host 半边 |
| 收藏指令路由与独立收藏会话 | 同上（硬编码在桥接里） | `lib/session-router.js` |
| 采集流水线（convert / format / verify / store） | `workspaces/<旧工作区>/scripts` | `pipeline/`（随包分发） |
| 三个 Skill | 同上 `skills/` | `pipeline/skills/`（预设直接指向） |
| 收藏 Agent 预设 | `${DSH_HOME}/.agent-presets/obsidian-collector` | `bundle/agent/`，安装脚本写入 |
| 配置（凭证 / 库路径 / 规则） | `wecom-bots.json` + 0600 env 文件 + `config/obsidian.json` 三处手同步 | **设置页一处** |

**消息链路**：企微消息 → 长连接 → 判断是否收藏 → 收藏会话（`danger-full-access` + `approval=never`）
→ Agent 按三个 Skill 依次调脚本 → 笔记落到 `<Vault>/<顶层>/<年>/<月>/<标题>/`。

---

## 安装

```bash
bash install/install.sh
```

脚本幂等，做这些事：

1. 装插件自己的 Node 依赖（企微长连接 SDK；优先从本机已有副本**离线**复制）；
2. 把 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 软链进来（必须与宿主同一份）；
3. 在 Profile 的 `package.json` 里登记 link 依赖 + `dsh.profile.bundles`，并校验
   `profiles/<profile>/node_modules/<包名>` 真的可解析（否则非 0 退出，不假报成功）；
4. 安装收藏 Agent 预设到 `${DSH_HOME}/.agent-presets/wecom-obsidian-collector/`；
5. 建运行时数据目录 `${DSH_HOME}/wecom-obsidian/`；
6. 提示（可选）停用旧的 `@local/dsh-wecom-aibot-host` 行。

`DSH_HOME` 的解析顺序：显式 `$DSH_HOME` > 正在运行的 dsh 进程环境 > `~/.dsh`；
不是 `~/.dsh` 时请显式传入（`DSH_HOME=/path/to/dsh-home bash install/install.sh`）。
安装脚本**不碰** `${DSH_HOME}/settings.yaml` 与 `${DSH_HOME}/wecom-obsidian/`，
所以只要 DSH_HOME 不变，重跑不会丢凭证与账本；DSH_HOME 变了请自行备份迁移。

然后重启 DSH，打开 **设置 → 企微 Obsidian 收藏**。

> **卸载**：`bash install/uninstall.sh`（加 `--purge` 连运行时数据一起删）。

### 第一次配置

**机器人部分只需要三项**（新增与编辑都只有这三项）：

| 字段 | 说明 |
|---|---|
| 机器人名称 | 日志、健康状态与会话 id 派生用，可自由命名 |
| Bot ID | 企微智能机器人后台拿到 |
| Secret | 同上；**只写**字段，保存后不回传浏览器，留空即表示不修改 |

其余机器人参数**全部自动推断**，不需要你填：

| 参数 | 自动取值 |
|---|---|
| 对话 / 收藏会话 id | 按机器人名称派生**可读前缀** + 一次性随机 token：`wecom-<slug>-<token>` / `wecom-<slug>-<token>-collector`。展示编号可以复用（删中间一台后补位），但会话 id **永不复用** —— 路由按 sessionId `resume`，复用等于让新机器人继承被删机器人的上下文 |
| 收藏能力 / 媒体下载 | 全开 |
| 放行策略 | `open`（如需白名单，直接改设置文档里该机器人的 `policy`/`allowlist`） |
| 模型路由 | 跟随 DSH 部署默认（`agent-default-model`），改了默认值机器人会跟着走 |

> 保存时以**已保存的配置为基底**做合并：配置页只覆盖那三项，其余字段原样保留。
> 所以手改过 `settings.yaml` 的人（例如给某台机器人配白名单）不会被配置页悄悄重置。

#### 每张卡片的操作

| 操作 | 行为 |
|---|---|
| **启用 / 停用** | 勾选框，**立即写入并应用**（不用再点保存）。停用的机器人会断开长连接，健康文件记为 `disabled` |
| **保存应用** | 把这张卡片改动的三项写回宿主。只有存在未保存修改时才可点，改过会显示「有未保存修改」徽标 |
| **放弃修改** | 丢弃这张卡片的未落盘编辑，回到已保存的值 |
| **删除** | 立即写入并应用 |
| **+ 添加机器人** | 立即提交一条「新增」意图，Host 追加一台带默认值的新机器人，再填三项后点该卡片的「保存应用」 |

保存是**路径寻址**写入（`botOverrides/<索引>/<字段>`）：一次只覆盖你改过的键，
不会牵动别的机器人，也不会因为并发编辑而互相覆盖。
写回后 Host 立刻收到 `settings/changed`，只重连受影响的机器人。

**增删机器人不走浏览器侧写数组**：`bots` 是数组，DSH 的 path mutation 无法深入数组，
而且浏览器读数里**没有** `secret`（`role('secret')` 每次 Remote 读都被剥离）——
用脱敏值重写 `bots` 会抹掉其余机器人的凭证。所以配置页只往 `botOps[]` 追加
一条 `{op,index,nonce}` 意图，Host 拿**未脱敏**的原始段执行结构变更，再用
`replace()` 精确写回（`lib/bot-ops.js`）。详情见《故障档案》B4-1。

然后是全局的这几项（底部「保存路径规则」按钮）：

| 字段 | 说明 | 书写规则 |
|---|---|---|
| Obsidian 导入地址 | Vault 库根绝对路径 | 绝对路径，例如 `/path/to/YourVault` |
| 存储路径规则 | 库内目录结构，默认 `{top}/{YYYY}/{MM}/{name}`（年/月） | 见下节《存储路径规则》 |
| 顶层目录名 | 规则里 `{top}` 的取值 | **单层目录名**；未写 `{top}` 时本项不生效 |
| 资源目录名 | 每篇笔记随包的图片目录名 | **单层目录名**，默认 `assets` |
| 采集工作目录 | 脚本与中间产物（staging/logs/去重账本）所在目录 | 绝对路径；留空用 `${DSH_HOME}/wecom-obsidian/workspace` |

**已隐藏、由插件自动推断的字段**（仍保留在设置文档里，需要时可直接编辑 `settings.yaml`；
配置页保存时**不会**覆盖它们）：

| 字段 | 自动取值 | 为什么不放配置页 |
|---|---|---|
| 媒体收件目录 | `<工作区>/staging/inbox` | 它是工作区内的暂存区，与库目录结构无关；绝大多数人不需要改 |
| 对话工作目录 | 同「采集工作目录」 | 收藏 bot 的对话会话不需要单独的工作目录 |
| 对话 Agent 预设 | `cordis` | 见下方说明 —— **不是**收藏预设 |
| 采集会话工作目录 | 同「采集工作目录」 | 采集链必须与工作区根一致（脚本按相对路径调用），单独改会两边脱节 |

> **「对话 Agent 预设」为什么不填 `wecom-obsidian-collector`？**
> 收藏预设是**专职收藏**的：它只挂了收藏链需要的脚本类工具，没有通用对话能力。
> 而「对话会话」要回答的是普通问题（你刚测的「几点了」就走这条路径）。
> 所以对话用通用预设（`cordis`），收藏会话则由插件**硬编码**使用
> `wecom-obsidian-collector` —— 这个值不该由用户改，因此从配置页移除。

企微里发「收藏 <链接>」或直接发链接即可。

---

## 存储路径规则

`{top}` 顶层目录 · `{YYYY}` 年 · `{MM}` 月 · `{platform}` 平台 · `{name}` 笔记名。

| 想要的效果 | 填这个 | 实测落点 |
|---|---|---|
| 年/月（默认） | `{top}/{YYYY}/{MM}/{name}` | `01_文章分享/2026/09/标题` |
| 只按年 | `{top}/{YYYY}/{name}` | `01_文章分享/2026/标题` |
| 平台优先 | `{platform}/{YYYY}/{MM}/{name}` | `微信/2026/09/标题`（小红书、网页各自成顶层） |
| 顶层下再分平台 | `{top}/{platform}/{YYYY}/{name}` | `01_文章分享/微信/2026/标题` |

书写规则：

- 用 `/` 分层；多余的斜杠会被自动归一（`{top}//{YYYY}` 等同 `{top}/{YYYY}`）
- `.` / `..` 会被丢弃；**不能写绝对路径**（开头的 `/` 无效）
- `{MM}` 不在规则里 = 不按月分目录
- ⚠️ **`{platform}` 写在 `{top}` 之前时，顶层已经是平台目录，`{top}` 不参与拼接**。
  想两者都要就写 `{top}/{platform}/…`。设置页在检测到这种写法时会就地提示。

规则由 `store.folderPattern` **单点驱动**：FORMAT 写进 frontmatter 的 `path` 快照
与 STORE 的实际落点调用同一个解析器（`wf.resolve_rel_dir`），因此两者永远一致。

实际落点举例：`01_文章分享/2026/09/某篇文章/`，包内含
`某篇文章.md` + `assets/`（图片，名字由「资源目录名」决定）+ `source_page.html`（源页快照）。

**同名冲突**：`folder_pattern` 的最后一段就是 note 目录名。默认规则下第二篇同名文章
落在 `01_文章分享/2026/09/某篇文章-2/某篇文章-2.md`（目录与 md 同名，`-2/-3` 递增）；
frontmatter 的 `path` 快照同步写成 `01_文章分享/2026/09/某篇文章-2`。
配置页的「同名冲突自动加 -2/-3 后缀」关掉后，STORE 遇到冲突**直接失败并保留整包**
（退出码 2），由用户决定怎么处理 —— 该开关会物化成 `store.conflict_suffix` 供脚本判定。

**去重**：`ledger_last(url_key).status == done` **且**该记录指向的入库物仍然存在时才跳过；
若笔记本体已被删/被移走，STORE 会记一条 error 并**重新入库**（不会把这次的新包直接丢掉）。

---

## 目录结构（插件包）

```
wecom-obsidian/
├── package.json            双面声明：dsh.bundle.patch + dsh.client
├── bundle/
│   ├── cordis.patch.yml    插件包自带的 composition 补丁（唯一的行来源）
│   └── agent/              收藏 Agent 预设源
│       ├── agent.cordis.yml  含 @@PLUGIN_ROOT@@ 占位符，安装期替换
│       └── preset.yml        预设显示名与描述
├── lib/                    Host 半边
│   ├── index.js            装配：设置 namespace / shellEnv / 工作区物化 / 机器人起停
│   ├── settings-ns.js      设置 schema（唯一配置事实源）
│   ├── workspace.js        设置 → 流水线配置物化 + 路径解析
│   ├── wecom-client.js     一条 wss 长连接（重连/自愈/控制通道/媒体下载）
│   └── session-router.js   收藏 vs 对话路由、Agent 会话编排、回合等待
├── client/client.js        Client 半边：设置页「企微 Obsidian 收藏」配置节
├── pipeline/               采集流水线（随包分发，原脚本零改动）
│   ├── scripts/            convert / format / verify / manage
│   ├── skills/             acquire / obsidian-format / obsidian-store
│   ├── config/             模板（运行时会被物化产物覆盖）
│   ├── templates/          Obsidian WebArticle 模板
│   └── rule_src/           WebArticle 业务规则原文
└── install/
    ├── install.sh          一键安装 / 重装
    ├── uninstall.sh        卸载
    └── copy-deps.mjs       离线复制依赖闭包
```

## 运行时位置

| 路径 | 内容 |
|---|---|
| `${DSH_HOME}/wecom-obsidian/workspace/` | 工作区根（`OBS_WS_ROOT`）：脚本、templates、rule_src、staging、ledger。**脚本每次物化都与插件包同步**（新增/覆盖更新/清理已删模板文件），升级后重启即生效；`staging/`、`logs/` 与自建文件不会被碰 |
| `${DSH_HOME}/wecom-obsidian/health/<slug>.json` | 每个机器人在线状态（`state` / `lastHeartbeat` / `lastError`） |
| `${DSH_HOME}/wecom-obsidian/control/<slug>.cmd` | 单实例控制口：写入 `start` / `stop` / `restart` |
| `${DSH_HOME}/.agent-presets/wecom-obsidian-collector/` | 收藏 Agent 预设（安装脚本写入） |
| `${DSH_HOME}/settings.yaml` | 配置真值（0600，`wecom-obsidian` 段） |

---

## 故障复盘：启动失败与 UI 故障（可按错误串检索）

这一节是**排障索引**：左边是症状/错误串，右边是真实根因与改法。
所有条目都经过日志或实测核对，并区分「真的会打挂 DSH 启动」与「只是 UI 出错」。

### A. 会打挂 DSH 启动的三次（`plugin tree failed to load`）

检索命令：

```bash
grep -n "plugin tree failed to load" ~/Library/Logs/dsh/launchd-stderr.log
grep -o "failed to load: [^\"]*" ~/Library/Logs/dsh/launchd-stderr.log | sort | uniq -c
```

| # | 错误串（可 grep） | 真实原因 | 改法 |
|---|---|---|---|
| 1 | `settings namespace "wecom-obsidian" is already registered`<br>（发生在 `#ui-wecom-obsidian` 入口） | **compositions 行被插入两次**：插件包自带的 `bundle/cordis.patch.yml` 插入了一行，profile 的 `cordis.patch.yml` 里又手写插入了同一行。同一行被应用两次 → `apply()` 跑两次 → 第二次撞名 | composition 行**只由 bundle 提供**；`install.sh` 不再往 profile patch 写行，并会清理历史残留。另加进程级单例守卫 + 撞名时复用 scope（不再抛错） |
| 2 | `cannot get property "shellEnv" without inject` | `ctx.shellEnv` 被当成普通 `ctx.<service>` 访问，但它是**宿主 composition 的受限服务**，没写进 `inject` | `inject` 加 `'shellEnv'` |
| 3 | `cannot get property "env" without inject` | （开发期自伤）临时探针访问了 `ctx.env`。`env` 是 Cordis 的**保留属性**（环境对象），不是服务 | 移除探针。**不要再往 `apply()` 里塞临时探针** |

> 另有一类连带现象：`failed to load: failed to apply loader entry include (cordis:include): loader entries failed to apply`
> —— 那只是上面某个根因冒泡到 `include` 层的**外层报错**，不是独立原因。顺着它往下找第一条 `failed to load:` 即可。

### B. 只影响配置页显示、不会打挂启动的两次

| # | 症状 | 真实原因 | 改法 |
|---|---|---|---|
| 4 | 状态行显示 `读取异常：status=undefined`，且「企业微信机器人（0）」 | **`inject()` 返回形态错**。这个容器是 DSH 的特殊容器，**框架会转换它的内容**，不等于 `props.hooks` 原样可用。把 `wecomScope` / `wecomController` 塞进容器 → 组件拿不到 → 状态全是 `undefined` | 不再用该容器承载控件，改为返回普通注入对象、组件直接按 `props.wecomController` 取用；并让控制器**每个字段都有显式兜底**，契约对不上时也不至于变 `undefined` |
| 5 | 页面显示 0，状态无提示 | **客户端 Remote 返回的是信封 `{ok, value}`，不是裸值**。按裸值解析 → 每次读取都抛错 → 被静默吞掉 | 读取处同时接受信封与裸值；失败时把宿主给的错误**显示到页面上**，不再静默 |

### B2. 三条「配置项写了但不生效 / 会错位」的缺陷（不崩，但结果错）

这三条都属于**静默出错**：不报错、不崩溃，但写入的位置或对象是错的。比崩溃更难发现。

| # | 症状 | 真实原因 | 改法 |
|---|---|---|---|
| 6 | 删除中间一台机器人后，**后面机器人的覆盖（含密钥、白名单）套到了别的机器人身上** | 覆盖表 `botOverrides` 按**数组下标字符串**存键，而 `removeBot` 只重写了 `bots`、没有重排覆盖表的键 → 键整体前移错位 | 增删一律改成 Host 侧 `applyBotOp()` 统一处理 `bots` + `botOverrides`（重排 + 清陈旧覆盖）。⚠️ **这两个字段必须成对处理**；详见 B4-1 |
| 7 | 路径规则里写 `{platform}` 看起来生效、实际不分平台 | `store.py` 只读规则里有没有 `MM`，其余占位符**一律忽略** | 新增 `wf.resolve_rel_dir()` 由 `folder_pattern` 单点驱动；FORMAT 与 STORE 共用它，保证 `path` 快照与落点一致 |
| 8 | 设置页改「资源目录名」不生效 | `assets` 在 `format`/`verify`/`wf_common` 三处**写死** | 统一改读 `store.assets_dir`（`wf.assets_dir_name()`） |

### B3. 媒体收件目录的两个静默坑

| # | 症状 | 真实原因 | 改法 |
|---|---|---|---|
| 9 | 填相对路径 → 媒体文件落到 DSH 进程的 cwd，找不到 | 该项被直接当字符串 `path.join()`，不解析相对路径 | 相对路径一律**相对工作区**解析 |
| 10 | 填 `{top}/staging` → 生成一个名为 `{top}` 的字面目录 | 该项本来就不支持任何占位符，写了就被当普通字符 | 显式支持 `{workspace}`；**遇到不支持的占位符直接报错**并说明正确写法，而不是产出垃圾目录 |

> 收件目录是**工作区里的暂存区**，与 Obsidian 库的目录结构无关 ——
> `{top}` 属于库的规则，两者不要混用。该项现已从配置页移除（默认 `<工作区>/staging/inbox`）。

### B4. 复查发现并修复的一组缺陷（2026-09，含回归测试）

这一组都是「代码看起来对、但行为和承诺不一致」的类型，每条都补了可复现的回归测试。

| # | 症状 | 真实原因 | 改法 / 守护测试 |
|---|---|---|---|
| 11 | 入库落点变成 `顶层/年/月/标题/标题/标题.md` | `store.folder_pattern` 默认**已经含 `{name}`**，而 STORE 把解析结果当「父目录」又在下面追加了一次文章名 | `resolve_target()`：规则最后一段就是 note 目录；只有规则里**没有** `{name}` 时才补一段。`path` 快照也按最终叶子写 → `pipeline/tests/test_store.py`、`test_path_rules.py` |
| 12 | 增删机器人会抹掉**其余机器人**的 Secret | 浏览器读数是脱敏的（`secret` 被剥离），旧实现用脱敏值整体写回 `bots`/`botOverrides`；`bots/<i>` 深路径写入还会把数组换成对象被 schema 拒绝 | 配置页只提交 `botOps[]` 意图；Host 读**未脱敏**的 `user` 段执行 `applyBotOp()` 并 `replace()` 写回 → `tests/settings-service.test.mjs`（**真实 `SettingsProvider`**）、`tests/lifecycle.test.mjs` |
| 13 | 设置页四个开关选了没用：同名后缀 / 图片下载 / 收到回执 / 单篇转换超时 | `store.py` 不读 `conflictSuffix`；`mediaEnabled`/`replyAck` 没传给 `WecomBot`；`convertTimeoutSec` 没有任何消费者 | 分别落到 `store.conflict_suffix`、`WecomBot.mediaEnabled` / `replyAck`、`convert.timeout_sec` + `_common.run_guarded()` → `tests/wecom-media.test.mjs`、`pipeline/tests/test_convert_timeout.py`、`tests/unit.test.mjs` |
| 14 | 安装脚本：默认 `~/.dsh` 找错 DSH_HOME；`corepack pnpm` 被当命令名；依赖登记失败仍打印「安装完成」 | `PNPM="corepack pnpm"` 拼串后整体当命令；结尾横幅无条件打印 | 数组调用 `"${PNPM[@]}"`；DSH_HOME 解析顺序 = env > 运行中进程 > `~/.dsh`；结尾**校验** `profiles/<p>/node_modules/<name>` 可解析，否则非 0 退出 → `tests/install-script.test.mjs` |
| 15 | live reload（profile patch 层热更新）后插件静默不装载 | 进程级 `applied` 守卫在 dispose 时未复位，而模块实例仍在 loader 缓存里，第二次 `apply()` 直接短路 | dispose 清理里 `applied = false` → `tests/lifecycle.test.mjs` |
| 16 | 账本说 done 但笔记已被删 → 再次收藏被当重复，整包被丢弃；并发收藏可能双写 | DEDUP 只看账本最后一条 `done`，不校验 `vault_path` 是否存在；STORE 多步过程没有串行化 | `stored_asset_exists()` + 不满足时记 error 并重新入库；`url_lock()`（`flock`）按 `url_key` 串行 → `pipeline/tests/test_store.py` |

> 维护提示：`lib/bot-ops.js` 是**宿主侧**模块，客户端 bundle 不能 import 它；
> 客户端只保留一份 `defaultBot`/`slugOf` 镜像（`tests/unit.test.mjs` 有用例断言两者同形）。

### B5. 第二轮复查修复（2026-09，含回归测试）

这一轮里有三条 P1 都是**用户可感知的错误结果**（跑旧脚本、上下文串用、笔记被覆盖），
共同点是「单看代码很合理，只有把两次操作的时序叠起来才暴露」。

| # | 症状 | 真实原因 | 改法 / 守护测试 |
|---|---|---|---|
| 17 | 升级插件并重启后，**仍在跑旧脚本**（改了代码但库里行为没变） | `materialize` 只「补齐缺失文件」，工作区里已存在的 `scripts/*.py` 永不覆盖 —— 而工作区那份才是脚本实际执行的位置 | `syncTemplateTree()`：模板树每次物化都**新增 + 覆盖更新 + 按清单清理已删文件**；`config/`（插件生成）与 `skills/`（唯一副本在包里）跳过；`staging/`、`logs/`、自建文件不动 → `tests/workspace-sync.test.mjs` |
| 18 | 三台机器人删中间一台再新增 → 出现两台「机器人3」，`sessionId` 相同（**共用一段会话上下文**） | 新增序号用 `bots.length + 1`，而删除后长度与既有编号已经错位 | `nextBotIndex()`：取「最小空闲序号」，同时避开已占用的 label / sessionId / collectorSessionId → `tests/unit.test.mjs`、`tests/settings-service.test.mjs` |
| 19 | 同标题文章互相覆盖：A 还没入库，B 的 FORMAT 把 A 的暂存包 `rmtree` 掉，最后 A 的任务存进的是 B | FORMAT 固定写 `staging/formatted/<platform>/<name>` 并在写入前删除同名目录 | 每次 FORMAT 独占一层运行目录 `<platform>/<run_id>/<name>`（叶子仍是文章名，STORE 仍按包目录名命名）；目标已存在时**拒绝覆盖**并 `FORMAT_FAIL` → `pipeline/tests/test_format_staging.py` |
| 20 | 两条消息并发时，A 的最终回复被发进 B 的气泡（流 ID 串用） | `handleInbound` 在 `await ackStream()` 之后回读实例上的 `this.lastStreamId`，而它已被并发的另一条消息覆盖 | 直接用 `ackStream()` 的**返回值**；实例字段只留作兜底 → `tests/wecom-media.test.mjs` |
| 21 | 图片下载失败仍全链报成功，入库笔记缺图 | 转换器在失败分支只打日志、**不把引用写回 Markdown**（日志却写着「保留原 URL」） | 头条/小红书/微信分享页失败时写入外部图片引用，`verify_note.py` 的「外部 http(s) 图片链接」随即判 FAIL、STORE 拒收整包 → `pipeline/tests/test_convert_media_failures.py`（含 `render_body`/`download_images` 可测化重构） |
| 22 | `LC_ALL=C.UTF-8 bash install/verify.sh` 报 `PATCH…: unbound variable` | macOS 自带 bash 3.2 在 UTF-8 locale 下把紧跟 `$VAR` 的多字节字符当成变量名的一部分（`$PATCH（存在）`）；`set -u` 直接判定未定义 | 全部 shell 脚本里的 `$VAR` 改为 `${VAR}`（15 处）；并加静态扫描 + C.UTF-8 下真实跑脚本的行为测试 → `tests/shell-scripts.test.mjs` |
| 23 | 发布包缺少 `docs/plugin.md` | `package.json.files` 没写 `docs/**` | 补上，并用 `npm pack --dry-run --json` 断言真实打包列表包含 docs 与各入口 → `tests/package-files.test.mjs` |
| 24 | 全新安装时 `pnpm add` / `pnpm install` 全部失败（`ERR_PNPM_UNEXPECTED_STORE`） | Profile 里**已有** node_modules 时，pnpm 拒绝换 store；而脚本从普通终端跑时 pnpm 会按「项目所在卷」另选一个 store，与既有 node_modules 记录的 store 不一致 | install.sh 从 `profiles/<p>/node_modules/.modules.yaml`（内容是 JSON）读出既有 `storeDir`，显式 `--store-dir` 复用 → `tests/install-script.test.mjs` |
| 25 | 明明旧桥接已停用，安装脚本仍告警「检测到旧的企微桥接插件行」 | `grep -q "$LEGACY_MARK"` 把**注释里**的历史提及也当成启用中 | 只看未注释行（`grep -v '^[[:space:]]*#'`）→ `tests/install-script.test.mjs`（注释/启用两种用例） |
| 26 | 头条转换器打印 `CONVERT_URL_OK` 后立刻 `NameError: n_img is not defined` | 把渲染循环抽成 `render_body()` 后，`main()` 仍引用随循环一起移走的 `n_img` / `fails`；成功标记在崩溃**之前**打印，所以现象是「看着成功、实际非 0 退出」 | `render_body()` 返回具名 dict；新增**完整入口**测试（桩掉网络跑 `main()`）+ 覆盖全部 pipeline 脚本的「未定义名字」静态扫描（两种守护都自证能抓到该回归）→ `pipeline/tests/test_convert_entrypoints.py`、`pipeline/tests/test_undefined_names.py` |
| 27 | 删除机器人后再新增，新机器人**继承被删机器人的历史会话** | `nextBotIndex()` 复用空闲编号，`sessionId` 也随之复用（`wecom-2`）；路由 `ensureAgentFor` 会 `resume` 同名会话 → 换成另一家企微账号时开场就带着旧上下文 | 展示编号与会话身份分开：编号仍取最小空闲（`机器人2`），`sessionId` 改为 `wecom-<slug>-<随机token>`，一次一换；客户端镜像同步 → `tests/unit.test.mjs`、`tests/settings-service.test.mjs` |

### C. 一条不成立、但已保留的写法（诚实记录）

`inject` 里额外写了 `'remote.settings'`（当前值：`['slots','settingsScope','remote','remote.settings']`）。

**它并不是启动失败的原因**，实测依据：

- Cordis 的 Guard 只在 `ctx.<prop>` 这一层检查 `prop in fiber.inject`（见 `cordis/lib/index.js` 的 `ReflectService.handler.get`），**不会递归检查嵌套的 `.settings`**。
- 用真实 Guard 语义实测：`inject = ['slots','settingsScope','remote']`（**不含** `remote.settings`）时 `apply()` 正常返回、`ctx.remote.settings` 照常可用。
- 历史 stderr 里从未出现过 `cannot get property "settings"` 或 `"remote.settings"` 相关错误串。
- 当前进程里 `settings.section` 的 `wecom-obsidian` 条目标记为 `active: true`，说明这个写法**没有**让插件卡在等待激活。

保留它的理由只是**显式声明更清晰**，且对宿主无副作用。写在这里是为了避免以后有人把它当成「必须这么写才能启动」而误传 —— 它不是必需的，但也**不必删**。

> 顺带记一条自查手段：客户端插件是否真的激活，可以直接读 Slot 占用表确认：
> `Slots.listSubTree(root: "settings.section")` → `occupants` 里应有 `id: wecom-obsidian` 且 `active: true`。
> 如果它**不在** occupants 里，说明插件卡在等待依赖，而不是渲染问题。

### 排查这类问题的通用顺序

```bash
# 1) 先确认「是启动失败还是 UI 出错」——看 stderr 有没有 plugin tree failed to load
grep -c "plugin tree failed to load" ~/Library/Logs/dsh/launchd-stderr.log

# 2) 启动失败：取第一条失败行，它才会指名道姓
grep -o "failed to load: [^\"]*" ~/Library/Logs/dsh/launchd-stderr.log | head -1

# 3) 配置页显示 0：先看页面上那行状态（它会打印 scope/信封/错误原文）
#    再去 boot 图确认客户端 bundle 在不在：
curl -s "http://127.0.0.1:3080/?token=<token>" | grep -o "dsh-wecom-obsidian/client.js[^\"]*"
```

---

## 设计要点（为什么这么做）

**配置只有一份。** 原实现有三处需要手工同步：能力矩阵 `wecom-bots.json`、0600 的
`wecom-bot.env`、工作区的 `config/obsidian.json`。本插件把三者收敛成设置 namespace，
`config/*.json` 降级为**可随时重建的派生物**（每次设置变更即重新物化）。
要改规则就改设置页，手改 `config/obsidian.json` 会在下次物化时被覆盖。

**Python 脚本零改动。** 流水线脚本本来就读 `OBS_WS_ROOT` / `OBS_VAULT_ROOT` /
`OBS_LEDGER_FILE` 三个环境变量。插件不去碰脚本，只负责把工作区准备好、把环境指对
（`lib/workspace.js`）。「年/月」这条规则也是靠把 `OBS_VAULT_ROOT` 指到 Vault 根、
让脚本自己拼年月实现的 —— 所以不需要改代码就能换布局。

**Secret 只写。** schema 里 `secret` 字段声明 `role('secret')`，设置服务在跨 Remote
边界时会把它整段剥离，只回一个 `{path, set}` 槽位。设置页因此按「只写」渲染：
已设置就显示占位提示，留空表示不修改。任何读数都不会把密钥带回浏览器。

**收藏会话单独提权。** 采集链要写真实 Vault，而企微渠道无人能应答审批弹窗。插件只把
**收藏会话**提到 `danger-full-access` / `approval=never`，对话会话保持普通权限。同时
用 `prepend` 注册 `user-questions/request` 应答者，避免 `ask_user_question` 永久挂起。

**长连接永不放弃。** SDK 默认只重连 10 次、认证失败 5 次，一次网络抖动或 Secret 写错
就会让通道**静默离线**。插件设 `maxReconnectAttempts: -1` / `maxAuthFailureAttempts: -1`，
再叠加「无事件 180s 强制重连」的自愈定时器。被别的连接顶下线（`kicked`）时 SDK 会
放弃重连，自愈定时器负责拉回来。

**一个机器人两条会话线。** 聊天与收藏用不同 sessionId + 不同 cwd + 不同 preset，
互不污染上下文；同一会话内消息串行执行。

### 实现细节清单（按踩坑顺序）

> 启动失败与 UI 故障的**检索式复盘**在上一节《故障复盘》；这里只列成实现约束。

1. **composition 行只能有一个来源。** 插件包自带 `bundle/cordis.patch.yml`，若再往
   profile 的 `cordis.patch.yml` 里 insert 一行，同一行会被叠加两次 → `apply` 跑两遍
   → 第二次撞 `settings namespace "wecom-obsidian" is already registered` → **DSH 起不来**。
   `lib/index.js` 里有进程级单例守卫兜底，但正确做法是**不要在 profile patch 里加行**。
2. **`shellEnv` 贡献者的 `resolve` 是贡献者级的。** 契约是
   `{ name, variables: { KEY: { description } }, resolve(execution) => { KEY: string } }`；
   写成每个变量各带 `resolve` 会让 `collect()` 在**每次 shell 调用**时抛
   `contributor.resolve is not a function`，把整个 bash 工具打挂。

3. **设置节的 `inject` 返回对象里不要自己套一层容器。**
   直接返回注入对象即可（组件按 `props.wecomController` 取用）。
   早期把控件塞进特殊的 `hooks` 容器，结果框架转换了它、组件拿不到 ——
   表现是状态行 `status=undefined` + 「企业微信机器人（0）」。
   **页面显示 0 而 Host 正常时，先查注入形态，再查下面第 5 条。**

4. **不要用 `useSyncExternalStore` 直连设置域的 store。**
   两个原因：`getSnapshot` 必须引用稳定（同一次读取连续调用要返回同一个值），
   而 describe 镜像每次 fold 都换新对象，派生值稍不注意就是无限重渲染；
   更糟的是**一旦抛错，整个设置节会被替换成错误边界，页面不会有任何提示** ——
   这正是「静默显示 0」的第二种成因。
   现在的做法：插件在 `apply` 时建立自己的**订阅控制器**
   （`makeController` → `useController`），把 scope + describe 合并成一个普通
   状态对象，只走 `useState`/`useEffect`。少一层契约，少一个静默失败点。

5. **配置读取状态必须显示出来。**
   读不到值时页面会明确写出「宿主已保存 N 条 · 本页显示 M 条」和读取状态行
   （`mode` / `revision` / 错误）。**排查时先看这一行**：它把「真没配」与
   「读不到」区分开，不用再靠猜。

6. **客户端 `decode` 直通，避免第二遍 schema 校验。**
   默认解码器会在浏览器把宿主的 schema 信封 `rehydrate()` 后再 `validate()`
   一遍；任一步出错就**静默丢弃整段配置**。形状与默认值本就在宿主侧由同一份
   schema 校验过，浏览器只负责渲染，所以这里显式传
   `decode: (section) => section` 跳过，去掉一个静默失败点。

7. **机器人配置里 `provider` / `model` 必须有值，不能留空。**
   它们不只是路由偏好：系统提示词里的 `{{provider}}` / `{{model}}` 就取自
   `agent.options`（见 `dsh-agent-loop` 的 `systemPrompt.variable` 注册），
   模板变量解析到 `undefined` 会让**整个提示词组装硬失败**：

   ```
   prompt variable "{{model}}" has no value for this assembly
   ```

   症状是「**每条消息都回一句『没有生成可回复的内容』**」——因为回合以 error 结束、
   没有任何 assistant 文本。所以 `buildConfig` 现在保证这两个字段永远有值：
   机器人自己的设置 > 部署默认（`agent-default-model`）> 内置兜底。

   排查同类问题的入口：日志里 `router.turn.error` 的 `detail.message`
   （把 detail 打出来是刻意的，否则只能看到一句「无法生成内容」）。

---

## 干净 DSH 上的安装依赖

装进一台**全新**的 DSH 时，除了 DSH 本身，还需要下面这些东西。
安装脚本会逐项检查并尽量自动装好；`install.sh` 开头会打印一份预检结果。

### 必需

| 依赖 | 用途 | 脚本是否自动处理 |
|---|---|---|
| **DSH 本体 + 一个 Profile** | 插件以 Profile bundle 形式装载 | 需要你先有；脚本只检查 `$DSH_HOME/profiles/<profile>` 存在 |
| **Node 18+** | 插件自身、企微长连接 | 检查版本，过低只警告 |
| **npm 或 pnpm** | 装/链依赖 | 检查；两者都没有会告警并让你手工加依赖 |
| **`@deepseek-ai/cordis`** | Cordis `Service` 基类（**必须与宿主同一份**，否则类身份不一致） | 由 Profile 的 `link:` 依赖解析；脚本会软链兜底 |
| **`@deepseek-ai/schemastery`** | 设置 schema 定义（同上，必须同一份） | 同上 |
| **`@wecom/aibot-node-sdk`** | 企微长连接 SDK | 优先离线复制本机副本；没有则 `npm install` |
| **Python 3.8+** | 采集流水线全部转换器 | 检查；缺失则收藏链路不可用（对话不受影响） |
| **`beautifulsoup4`** | **微信图文**转换器（`mp.weixin.qq.com`） | 自动 `pip install --target $DATA_DIR/pylibs` |

### 按需

| 依赖 | 只在什么时候需要 |
|---|---|
| **`markitdown` CLI** | 只服务「**其它任意网页**」（回退转换器 `convert_url.py`）。微信 / 小红书 / 头条各有专用转换器，**不需要它** |
| **`git`** | 不需要（脚本不调用 git） |

### 不需要

- **DSH 的 MCP markitdown 桥接**（`mcp__markitdown__convert_to_markdown`）—— 那是给 agent 直接用的工具；
  采集链走的是**命令行** `markitdown`，两者互不依赖。装了 MCP 桥接也不会被本插件用到。

### 依赖矩阵（按来源分路）

| 收藏来源 | 转换器 | 额外依赖 |
|---|---|---|
| `mp.weixin.qq.com` 图文 | `wechat_read_v3.py` | **beautifulsoup4** |
| `mp.weixin.qq.com` 分享页（图片/文字消息） | `wechat_share_v3.py` | 无（纯标准库） |
| `xiaohongshu.com` / `xhslink.cn` | `xhs_convert.py` | 无（纯标准库） |
| `toutiao.com` | `convert_toutiao.py` | 无（纯标准库） |
| 其它任意网址 | `convert_url.py` | **markitdown CLI** |

> 换句话说：**如果你只用微信收藏，只缺 `beautifulsoup4` 就装它；`markitdown` 可以完全不装。**

### 依赖是怎么被找到的（无需改脚本）

| 依赖 | 发现顺序 |
|---|---|
| `markitdown` | 设置页显式路径 > `PATH` 里的 `markitdown`；插件把解析到的**绝对路径**写进 `config/runtime.json`，避开脚本源码里写死的默认值 |
| Python | 设置页显式路径 > `PATH` 里的 `python3` > `python` |
| `beautifulsoup4` | 解释器自带 > `$DATA_DIR/pylibs`（插件通过 `PYTHONPATH` 暴露；脚本源码只会看 `/tmp/pylibs`，所以这一步是必需的） |

安装后可直接核对：

```bash
cat "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/workspace/config/runtime.json"
# markitdown.cli / python.bin / beautifulsoup4.dir / beautifulsoup4.install
```

---

## 排障

```bash
# 1) 插件有没有加载（应有 applied 一行）
grep "\[wecom-obsidian\]" ~/Library/Logs/dsh/launchd-stdout.log | tail

# 2) 机器人是否在线
cat "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/health/"*.json

# 3) 单独停/启一个机器人（slug 见 health 文件名）
echo stop  > "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/control/<slug>.cmd"
echo start > "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/control/<slug>.cmd"

# 4) 配置有没有物化成功
cat "${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/workspace/config/obsidian.json"

# 5) 手动复现一条收藏链（不开机器人）
W="${DSH_HOME:-$HOME/.dsh}/wecom-obsidian/workspace"
OBS_WS_ROOT="$W" OBS_VAULT_ROOT="<你的Vault>" \
  python3 "$W/scripts/convert/convert_url.py" "<URL>"
```

| 现象 | 先查 |
|---|---|
| DSH 起不来，日志有 `already registered` | profile patch 里是否残留本插件的 insert 行（应只由 bundle 提供） |
| 每次 bash 都报 `contributor.resolve is not a function` | `lib/index.js` 里 shellEnv 贡献者形状 |
| 机器人一直 `state=connecting` | Bot ID / Secret 是否正确；企微后台是否允许长连接 |
| 机器人在线但收藏没反应 | `collectEnabled` 是否开着；消息是否含 URL |
| 笔记没落进 Vault | 设置页「Obsidian 导入地址」是否填了绝对路径；看 health 里的 `lastError` |
| 设置页看不到配置节 | 浏览器硬刷新；确认 boot 图里有 `dsh-wecom-obsidian` |

---

## 与旧实现的迁移

旧桥接 `@local/dsh-wecom-aibot-host` 与新插件会**争抢同一条 wss**（企微服务端只允许
一个连接，后连的会把先连的顶下线），必须二选一。安装脚本会检测并提示；确认新插件可用后：

```bash
WECOM_OBSIDIAN_DISABLE_LEGACY=1 bash install/install.sh   # 由脚本注释掉旧行
```

旧包与旧依赖**保留不动**，需要回滚时把 profile patch 的注释还原、并把
`dsh-wecom-obsidian` 从 `dsh.profile.bundles` 移除即可。

### 配置迁移助手

旧实现把配置分散在三处（0600 的 `wecom-bot.env`、能力矩阵 `wecom-bots.json`、
工作区 `config/obsidian.json`）。迁移助手把这三处合并成一份**迁移计划**：

```bash
bash install/migrate-legacy-config.sh --dry-run   # 只打印将要迁移的内容（密钥打码）
bash install/migrate-legacy-config.sh             # 生成计划文件（0600）
```

它**不会**直接写设置文档 —— 设置文档归 DSH 的设置服务管（schema 校验 + revision
栅栏）。拿到计划后有两种落地方式：

- **设置页手工填**（最直观）；
- **让插件自己执行迁移**（密钥不出进程）：在 DSH 会话里让 agent 读取
  `${DSH_HOME}/wecom-obsidian/migration-plan.json` 并合并写入。

> 注意：设置文档是 `settings.yaml`，由 provider 的文件 watcher 热加载 ——
> 无论用哪种方式写入，插件都会收到 `settings.changed` 并**自动重连机器人、
> 重建工作区**，不需要重启 DSH。
>
> 计划文件含明文密钥（0600）。写入完成后请删除：
> `rm -f ${DSH_HOME}/wecom-obsidian/migration-plan.json`。

迁移对照（一次实际迁移的结果；机器人名以 A/B/C 指代）：

| 配置项 | 旧位置 | 新位置 | 结果 |
|---|---|---|---|
| 机器人A ID/Secret | `wecom-bot.env` `WECOM_BOT_*` | `bots[0]` | ✅ 已迁移 |
| 机器人B ID/Secret | `wecom-bot.env` `WECOM_BOT2_*` | `bots[1]` | ✅ 已迁移 |
| 机器人C 凭证 | `WECOM_BOT3_*`（未填） | `bots[2]` `enabled=false` | ○ 未填凭证，未启用 |
| 对话/收藏会话 id | `wecom-bots.json` | 同值 | ✅ 保留（会话连续） |
| Vault 根 | `config/obsidian.json` | `vaultRoot` | ✅ |
| 存储路径规则 | `{top}/{YYYY}/{MM}/{name}` | 同值 | ✅ 年/月 |
| 顶层目录 / assets | `01_文章分享` / `assets` | 同值 | ✅ |
| markitdown CLI | `config/runtime.json` | `pipeline.markitdownCli` | ✅ |
| 机器人C 白名单 | `wecom-bots.json` `policy: allowlist` | `policy` + `allowlist` | ✅ 已支持并接线 |
| 采集工作目录 | `workspaces/<旧工作区>` | `${DSH_HOME}/wecom-obsidian/workspace` | 🔁 改为插件数据目录 |

白名单闸门是**句首锚定**的（`isAllowlisted`）：只有以白名单条目开头的消息才进
agent，其余固定话术直回、不产生任何会话与模型调用。

