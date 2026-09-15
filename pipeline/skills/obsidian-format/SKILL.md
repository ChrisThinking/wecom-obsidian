---
name: obsidian-format
description: FORMAT 技能：把 Content Package 标准化为 Note Package（schema 驱动 frontmatter、assets 收敛、H1、纯标题命名）；不定最终库路径。
---

# Skill: obsidian-format（FORMAT — Content Package → Note Package）

> 定位：把 Content Package 标准化为 **Note Package**（磁盘对象）：frontmatter 按 **Obs schema** 生成、assets 收敛、H1、纯标题命名；**不负责**获取网页、不决定最终库路径与同名冲突（那属 obsidian-store/DSH 执行）。
> 依据：`config/obsidian.json → frontmatter.schema`（字段键序=Obs 模板）、`logs/state/business-rules.json`（template.body.h1 等）、`templates/文章模板.md`（完整骨架参照，不逐字填空）、`docs/obsidian入库规范.md`。

## 输入 → 输出契约
```
Content Package（converted/<平台>/<包>/）
  → Note Package：staging/formatted/<platform>/<name>/
      <name>.md（frontmatter 键序=schema） + assets/ + source_page.html
```
- name = 纯标题（清洗：禁符→_、压缩空白、去首尾点空格、上限 120）；与 md 同名。
- frontmatter 键：`title / type / url / author/ID / platform / published / created / path / read / tags`（无 status；tags: []）。

## 步骤（实现：`scripts/format/format_note.py`）
1. 读 schema（config）与正文规则（business-rules template.body.h1）。
2. 提取元数据：**包内 metadata.json 优先**（通用转换器必写）→ 回退转换器 md 的引用块（`> **原文链接/公众号/发布时间…**`）。
3. 组装：`title/url/platform/published`、`author`（→ 键 `author/ID`）、`created`=进入库时间、`path`=**依据 M1 规则（created 年 + 建议名）生成的 Note 元数据快照**（`01_文章分享/<created年>/<月份>/<name>`（月份随 store 规则））。
   > **path 是快照，不是最终位置的授权**：最终目标位置由 obsidian-store 决定（含冲突后缀；必要时 store 在提交前校正 path 一次）。
4. 输出：frontmatter 键序=schema；正文 = `# <标题>` + 正文（去掉来源信息块；无"原文链接"题注；无固定备注区）。
5. 附件：`images/ → assets/` 并改写 md 相对引用；复制 `source_page.html` 随包。

## 判定 / 退出
- 成功：`FORMAT_OK <out_pkg>`；随后 `verify` 应为 PASS（必填 title/type/url/created 齐；无外部 http 图片；无 schema 外字段 WARNING 可接受）。
- 失败：包保留可重试（输出 `FORMAT_FAIL` + 原因）。

## 自检清单
```bash
python3 scripts/format/format_note.py <converted包目录>
python3 scripts/verify/verify_note.py <formatted包目录>     # 期望 VERDICT PASS
# golden：产物 frontmatter 键序 == templates/文章模板.md 键序；无 '<%'；无 'status'；无单独 'author:' 键
```

## 边界 / 引用
- 不做：写库/去重/冲突（obsidian-store）；不逐字把模板文件当模板引擎填空（schema 驱动 + 模板参照）。
- 契约：`docs/工作流v1定义.md` §3/§4/§10.5；`config/obsidian.json frontmatter.schema`；`docs/M1_B_定稿规则集.md`（字段与结构定稿）。
