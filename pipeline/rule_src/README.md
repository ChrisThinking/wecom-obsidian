# rule_src/ — Obs 规则文件（M1–M3 模拟规则源）

> 定位：rule_src 是真实 Obsidian 规则文件在 **M1–M3** 的开发/测试模拟源（**不是第三套规则**，也不是最终生产源）。
> M1–M3 **禁止读取真实 Vault / 99_obsConfig**；M4 执行 **Rule Source Switch** 后切换到真实 Vault 内的 `99_obsConfig/`，rule_src 不再作为生产规则源。

## 文件（固定两文件结构）

| rule_src（M1–M3） | 真实位置（M4） | 职责 |
|---|---|---|
| `WebArticle.md` | `99_obsConfig/Templates/WebArticle.md` | 定义 **WebArticle 文件内部结构**：Frontmatter、字段、类型、默认值、Markdown 基础结构 |
| `webArticle同步配置规范.md` | `99_obsConfig/webArticle同步配置规范.md` | 定义 **WebArticle 资料管理规则**：存放位置、目录/年份组织、命名与清洗、资产包、assets、source_page、字段资料语义、WebArticle 与 Knowledge 关系 |

两者职责严格分开：`WebArticle.md` 管"文件内部长什么样"，`webArticle同步配置规范.md` 管"文件在知识库中如何组织保存"；互不重复。

## 边界

- 只承载 **Obs 资料管理业务规则**。
- **不包含** DSH 执行机制：Agent/Job/Skill/Script/Workflow、URL canonical/url_key/去重、Verify、冲突处理、retry/rollback、Ledger/日志/状态机、原子提交等（均属 DSH 侧，见 `docs/规则架构与DSH配置定位.md` 与 `docs/M1 WebArticle 业务配置与规则源重新定稿方案.md`）。
- 本目录文件正文由用户维护；DSH 相关文档不得改写它作为执行配置。
