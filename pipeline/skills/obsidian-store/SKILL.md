---
name: obsidian-store
description: STORE 技能：把 Note Package 原子入库为 Stored Asset（verify/去重/01_文章分享 布局/ledger/清理；-2/-3 为 DSH 冲突处理机制）。
---

# Skill: obsidian-store（STORE — Note Package → Stored Asset）

> 定位：把 Note Package **作为资产原子入库**并记账；是 DSH 执行层技能。
> 内部顺序：VERIFY → DEDUP → TARGET RESOLUTION(冲突后缀) → ATOMIC COMMIT(.part+rename) → LEDGER(done) → CLEANUP。
> **不修改正文内容**；`path` 快照与最终位置一致（创建时写一次，含冲突后缀场景）。
> 实现：`scripts/verify/verify_note.py` + `scripts/manage/store.py`；共享 `scripts/wf_common.py`。

## 输入 → 输出契约
```
Note Package（formatted/<platform>/<name>/）
  → Stored Asset：<vault>/01_文章分享/<created年>/<月份>/<name>/
      <name>.md + assets/ + source_page.html
```
- vault 根解析：`OBS_VAULT_ROOT` > `config/obsidian.json vault_root(已填真值)` > `vault_test_root(tests/tmp_vault)`（M4 前一律测试库）。
- 年份依据 frontmatter `created`（M1-B B6）；同名冲突 `-2/-3` 属 **DSH 冲突处理机制**（非 Obs 规则——Obs 只规定"标准文件名长什么样"，同名怎么办由 DSH 决定）；名称保护，内容去重靠 url_key ledger。
- ledger：`logs/state/processed-urls.jsonl`（received→done/error；done 仅在完整成功后写）。

## 步骤（`python3 scripts/manage/store.py <note_pkg> [--run-id <id>]`）
1. 读 frontmatter：`url`（去重键源）、`platform`、`created`。
2. VERIFY：调用 verify_note；FAIL → 记 ledger error、整包保留、退出 2。
3. DEDUP：`ledger_last(canonicalize(url))` 为 done → 清理冗余 Note Package、打印 `STORE_SKIP_DUPLICATE`、退出 3。
4. TARGET：`vault/01_文章分享/<created年>/<月份>/<name>`；存在则递增 `-2/-3`。
5. ATOMIC：整包 `copytree → .part → os.replace(final)`；若冲突后缀，改 md 文件名并**修正 frontmatter `path` 一行**（创建时快照）。
6. LEDGER：记 done（url_key/vault_path/时间戳）。
7. CLEANUP：删除该 Note Package；编排层再删对应 converted。

## 判定 / 退出
- 0 = 已入库；3 = 重复跳过；2 = 失败（整包保留可重试，不留半成品）。
- 失败时 ledger 记 error；不因后续失败重跑前面阶段（D12）。

## 自检清单
```bash
python3 tests/m0_scenarios.py     # S1 原子+记账 / S2 去重 / S3 失败可重试
OBS_VAULT_ROOT="$PWD/tests/tmp_vault" python3 scripts/manage/store.py <formatted包目录>
# 布局检查：<vault>/01_文章分享/<年份>/<月份>/<name>/{<name>.md, assets/, source_page.html}
```

## 边界 / 引用
- 不做：修改正文/重新格式化/AI；重名策略细节、retry、日志等属 DSH（不写入 Obs 规则）。
- 契约：`docs/工作流v1定义.md` §7/§8/§9；`config/obsidian.json store`；`docs/obsidian入库规范.md`。
