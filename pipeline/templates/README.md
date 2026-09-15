# templates/ — 说明

- `文章模板.md` = **DSH 本地运行模板**（derived/generated artifact），是 Obs WebArticle 模板解析/标准化后的本地副本。
- 定位与细则见 `docs/规则架构与DSH配置定位.md`：
  - 不是业务规则源；不是第二套人工维护模板；
  - **修改模板的正确入口 = 改 Obs 中的 WebArticle 模板 → Rule Update 重新生成**，禁止人工长期覆盖本文件；
  - Runtime（FORMAT/Skill）只读取本地模板副本，不在每个 URL 时回 Obs 读取。
- **当前（M0 过渡）状态**：本文件为人工维护占位，与 `config/obsidian.json` frontmatter、`scripts/format/format_note.py` 硬编码逻辑三者手工对齐（镜像）；`format_note.py` 暂未读取本文件（M1 模板加载落地后改读本地副本，消除镜像重复）。
- 注意：文件首行需保持 `---`（frontmatter 起始），解析器将按本地模板读取 frontmatter。
