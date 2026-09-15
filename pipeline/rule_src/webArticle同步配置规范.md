# WebArticle 同步配置规范

> 版本：v1.2  
> 配置类型：WebArticle 资料管理配置  
> 适用对象：`WebArticle` 资料  
>
> **本文件定义的是 WebArticle 在 Obsidian 中“如何组织、命名和保存”的资料管理规则。**
>
> 本文件虽然作为 DSH 的读取来源，但**不定义任何 DSH 执行机制**。
>
> DSH 只负责将本文件定义的资料管理规则落实到文件；具体的执行流程、Agent、Job、Skill、Script、验证、冲突处理、去重、重试、回滚、日志、Ledger 等，不属于本文件。

---

# 1. 文件职责

WebArticle 的规则由两个文件共同提供：

```text
99_obsConfig/
├── Templates/
│   └── WebArticle.md
└── webArticle同步配置规范.md
```

两者职责严格分开：

| 文件 | 定义内容 |
|---|---|
| `Templates/WebArticle.md` | WebArticle 文件内部模板：Frontmatter、字段、Markdown 基础结构 |
| `webArticle同步配置规范.md` | WebArticle 在 Vault 中的资料组织方式：存放位置、目录结构、命名、资产包、附件组织等 |

因此：

```text
WebArticle.md
    ↓
文件内部是什么结构

webArticle同步配置规范.md
    ↓
文件在知识库中如何组织和保存
```

本文件不重复定义 `WebArticle.md` 已经定义的模板内容。

---

# 2. WebArticle 资料定义

WebArticle 是保存于 Knowledge Vault 中的外部网络资料。

其核心原则：

- 保留外部资料本身；
- 保留原始来源信息；
- 不因进入知识库而自动变成个人 Knowledge；
- 不在资料管理阶段增加个人观点、总结或评价；
- 目录负责物理组织，Metadata 负责描述和筛选。

---

# 3. 正式存储位置

## 3.1 正式目录

WebArticle 的正式存储根目录：

```text
/01_文章分享/
```

## 3.2 存储目录

正式目录按年份/月份组织：

```text
/01_文章分享/<年份>/<月份>
```

年份依据：

```text
created
```

即：

> WebArticle 进入 Knowledge Vault 的年份。

因此：

```text
published = 原文章发布时间
created   = 进入 Knowledge Vault 的时间
```

两者语义不能混用。

## 3.3 平台不作为物理目录

正式目录不按平台建立子目录。

不采用：

```text
/01_文章分享/微信公众号/
/01_文章分享/小红书/
/01_文章分享/网页/
```

平台信息由 WebArticle 模板中的：

```yaml
platform: ""
```

描述。

---

# 4. 单篇资料组织方式

每篇 WebArticle 使用一个独立的资料包目录。

标准结构：

```text
<name>/
├── <name>.md
├── assets/
└── source_page.html
```

其中：

- `<name>/`：单篇资料包目录；
- `<name>.md`：WebArticle 主文件；
- `assets/`：该 WebArticle 专属的本地资源；
- `source_page.html`：原始网页快照。

## 4.1 原子性

一篇 WebArticle 的 Markdown、图片及网页快照共同构成该资料的完整资产。

因此：

- 一个 WebArticle 对应一个资料包；
- 资料包内部资源只服务于当前 WebArticle；
- 不建立跨文章共享附件目录；
- 不建立全局图片库。

---

# 5. 文件命名

## 5.1 默认命名

WebArticle 主文件默认使用文章标题作为文件名：

```text
<标题>.md
```

资料包目录与主文件保持同名：

```text
<标题>/
└── <标题>.md
```

例如：

```text
工作记忆的核心机制/
└── 工作记忆的核心机制.md
```

## 5.2 不在文件名中加入业务属性

默认不将以下信息加入文件名：

```text
日期
平台
作者
标签
类型
```

这些信息通过 WebArticle Frontmatter 保存。

## 5.3 文件名清洗

文件名以文章标题为基础，在满足文件系统要求时进行最小化清洗：

- 非法字符转换为 `_`；
- 压缩连续空白；
- 去除首尾点和空格；
- 最大长度 120 字符。

清洗的目的只是使标题能够安全作为文件名使用。

不得借文件名清洗改变文章标题的业务含义。

> **说明：本文件只规定“标准文件名长什么样”。当目标位置已经存在同名文件时如何处理，属于 DSH 执行规则，不在本文件定义。**

---

# 6. Frontmatter

WebArticle 的 Frontmatter 结构由：

```text
99_obsConfig/Templates/WebArticle.md
```

唯一确定。

本文件不复制另一份 Frontmatter Schema。

DSH 写入 WebArticle 时，应使用模板规定的字段和结构。

当前模板的核心字段包括：

```yaml
title:
type: web_article
url:
author/ID:
platform:
published:
created:
path:
read:
tags:
```

具体字段定义、字段顺序、类型及空值约定，以：

```text
Templates/WebArticle.md
```

为准。

---

# 7. Metadata 的资料语义

本文件只定义 Metadata 在资料管理中的含义，不定义 Metadata 的自动提取算法。

| 字段 | 资料管理含义 |
|---|---|
| `title` | 网络内容标题 |
| `type` | 固定为 `web_article` |
| `url` | 原始内容 URL |
| `author/ID` | 发布账号名称或账号 ID |
| `platform` | 实际发布平台 |
| `published` | 原文章发布时间 |
| `created` | 进入 Knowledge Vault 的时间 |
| `path` | 创建时 Vault 相对路径快照 |
| `read` | 是否已阅读 |
| `tags` | 内容标签 |

---

# 8. 时间与路径语义

## 8.1 `published`

表示：

```text
原文章何时发布
```

格式由模板定义：

```text
YYYY-MM-DD
```

## 8.2 `created`

表示：

```text
何时进入 Knowledge Vault
```

格式由模板定义：

```text
YYYY-MM-DDTHH:mm:ss
```

`created` 一旦建立，不因后续移动或整理而改变。

## 8.3 `path`

`path` 表示：

```text
创建时 Vault 相对路径快照
```

它不是实时路径。

例如：

```text
20_Psychology/00_收件箱/文章
```

创建后移动到：

```text
01_文章分享/2026/06/文章
```

`path` 仍表示创建时的路径快照。

当前实际位置以文件实际路径为准。

---

# 9. 标签

`tags` 使用 YAML 数组：

```yaml
tags: []
```

当前规则：

- 不建立完整受控标签词表；
- 不因为平台而自动增加固定标签；
- 未知标签使用 `[]`；
- 标签属于内容描述信息，不作为物理目录组织依据。

---

# 10. 正文

WebArticle 正文用于保存外部网络资料本身。

允许必要的格式整理，例如：

- 网页内容转换为 Markdown；
- 保持合理的标题层级；
- 保持正文阅读结构；
- 保持图片等内容引用关系。

不因进入知识库而自动：

- 总结；
- 改写观点；
- 添加个人评论；
- 转换成个人 Knowledge。

---

# 11. 图片与附件

## 11.1 图片归属

WebArticle 图片属于当前文章资产。

统一存放：

```text
assets/
```

禁止：

```text
全局图片库
跨文章共享图片目录
```

## 11.2 图片文件命名

文章包内图片采用：

```text
image_01.ext
image_02.ext
image_03.ext
```

保持简单、稳定、与当前文章绑定的命名方式。

## 11.3 原始网页快照

原始网页快照：

```text
source_page.html
```

属于该 WebArticle 的资料资产，并随文章包保存。

---

# 12. Inbox 与正式资料

WebArticle 可以先进入收件箱：

```text
01_Knowledge/**/00_收件箱/
```

收件箱是：

```text
暂存位置
```

不是资料类型。

WebArticle 在收件箱中仍保持：

```yaml
type: web_article
```

正式存储位置为：

```text
/01_文章分享/<年份>/<月份>/
```

进入正式目录后仍然是：

```yaml
type: web_article
```

不会因为目录变化而自动变成 Knowledge。

---

# 13. WebArticle 与 Knowledge 的关系

两者是不同的资料类型：

```text
WebArticle
    ↓
阅读 / 理解 / 加工
    ↓
Knowledge
```

WebArticle 可以成为 Knowledge 的来源，但：

```text
WebArticle ≠ Knowledge
```

资料同步过程不负责把 WebArticle 自动转换为 Knowledge。

---

# 14. 本文件明确不定义的内容

以下内容**不属于 Obsidian WebArticle 资料管理配置**，因此不得写入本文件：

```text
Agent 行为
Job 流程
Skill 调用
Script 实现
URL canonical 算法
去重算法
Ledger
run_status
重试策略
异常恢复
Verify 流程
冲突处理
回滚策略
原子提交实现
日志格式
任务调度
权限控制
网络安全执行策略
```

其中尤其需要区分：

### 属于本文件

```text
资料放在哪里
资料目录如何组织
文件叫什么
资料包如何组织
图片放在哪里
网页快照是否属于资料包
Metadata 各字段代表什么
```

### 不属于本文件

```text
发现重复以后怎么办
同名文件怎么办
验证失败怎么办
下载失败以后重试几次
移动失败如何回滚
Job 如何记录状态
Agent 如何调用 Skill
Script 如何实现
```

这些属于自动化系统自身的执行规则。

---

# 15. 配置变更原则

本文件发生变化时，应判断变化属于：

```text
Obsidian WebArticle 资料管理规则
```

只有属于资料管理规则的内容才进入本文件。

例如可以修改：

```text
正式目录
年份目录规则
文件命名规则
资料包结构
图片目录名称
网页快照是否保存
Metadata 业务语义
```

不应在本文件中增加：

```text
重试次数
验证流程
冲突解决算法
回滚机制
Agent Prompt
Skill 编排
Job 调度
```

---

# 16. 最终定义

本文件只回答一个问题：

> **“WebArticle 作为一种资料，在 Obsidian 中应该如何被组织和保存？”**

因此最终职责边界固定为：

```text
Templates/WebArticle.md
        ↓
定义文件内部结构
        ↓
“文件长什么样”

webArticle同步配置规范.md
        ↓
定义资料组织规则
        ↓
“资料放哪里、叫什么、如何组成一个完整资料包”

DSH 自动化规则
        ↓
负责如何执行上述规则
        ↓
“系统怎么把它做出来”
```

**本文件不承担“系统怎么做”的定义，只承担“资料应该是什么样、放在哪里、如何组织”的定义。**
