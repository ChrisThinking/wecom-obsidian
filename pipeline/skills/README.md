# skills/ — 三 Skill 索引（M2 固化）

| Skill | 目录 | 阶段 | 输入 → 输出 | 主要实现（scripts/） |
|---|---|---|---|---|
| **acquire** | `acquire/SKILL.md` | ACQUIRE | URL → Content Package | convert/（微信图文 / **微信分享页（图片消息·文字消息）** / 小红书 / convert_url） |
| **obsidian-format** | `obsidian-format/SKILL.md` | FORMAT | Content Package → Note Package（schema 驱动） | format/format_note.py |
| **obsidian-store** | `obsidian-store/SKILL.md` | STORE | Note Package → Stored Asset（verify/去重/原子/记账/清理） | verify/ + manage/store.py |

- 每个 SKILL.md 自含：定位与边界 / 契约 / 步骤 / 判定退出 / 自检清单。
- 共同依据：`docs/工作流v1定义.md`（契约）、`docs/M1 WebArticle 业务配置与规则源重新定稿方案.md` + `rule_src/`（Obs 业务规则）、`config/obsidian.json` + `templates/文章模板.md` + `logs/state/business-rules.json`（M1-C 生成的本地运行产物）、`docs/obsidian入库规范.md`。
- **装载（挂载到 DSH Agent）属 M3**：届时用 editing-cordis-compositions 确定如何以 preset 装载本目录三 SKILL.md（Agent=obsidian-collector 组合三者，不亲自执行）。
- 层关系：Agent(M3) → Skill(M2, 本目录) → Script（确定性执行层）。Skill 不重复维护规则；规则变更走 rule_src → rule_update 再生成。
