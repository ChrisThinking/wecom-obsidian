---
name: acquire
description: ACQUIRE 技能：把 URL/输入获取为 Content Package（微信图文 + 微信「图片消息/文字消息」分享页 + 小红书 + 通用 convert_url，含图片与 source_page）；不承担最终去重判定。
---

# Skill: acquire（ACQUIRE — 获取网页内容 → Content Package）

> 定位：把「URL/输入」转换为 **Content Package**（磁盘对象）。属于 DSH 执行层技能；**不决定 Obsidian 最终格式**（Obs 定稿见 `rule_src/`，执行边界见 `docs/M1 WebArticle 业务配置与规则源重新定稿方案.md`）。
> 实现层：`scripts/convert/`（微信图文 / 微信分享页 / 小红书 / 通用 convert_url；`_common`/`wf_common` 共享）。

## 输入 → 输出契约
```
URL（原始值保留为 source_url）
  → staging/converted/<平台标签|来源>/<唯一包目录>/
      主md（<标题>.md） + images/ + source_page.html（通用与微信分享页另有 metadata.json）
```
- 平台标签（staging 内部目录语，非最终库目录）：微信 / 小红书 / 网页。
- 单位：单篇 = 一个包；禁止跨文章共享附件。

## 步骤
1. **URL 归一（生成 canonical/url_key，仅用于记账与后续判定；不改 source_url）**：`wf.resolve_redirect(url)` → `wf.canonicalize_url(...)` → url_key。
   > **acquire 不承担最终 DEDUP 判定**：最终判定唯一在 obsidian-store（STORE 的 DEDUP 步骤）。编排层可基于 ledger 做"前置跳过"（优化），但不改变 acquire 职责。
2. **域名分发**（主表 `config/pipeline.json → convert.converters`；同域兜底表 `→ convert.converter_fallbacks`）：
   - `mp.weixin.qq.com` → `python3 scripts/convert/wechat_read_v3.py <URL>`（**图文正文页**，页面含 `id="js_content"`）
   - `mp.weixin.qq.com` **兜底**（同域，主转换器判定失败时才用）→ `python3 scripts/convert/wechat_share_v3.py <URL>`（**图片消息 / 文字消息**分享页，见下「常驻能力」）
   - `xiaohongshu.com | xhslink.cn` → `python3 scripts/convert/xhs_convert.py <URL>`
   - `m.toutiao.com | www.toutiao.com` → `python3 scripts/convert/convert_toutiao.py <URL>`（手机 UA+壳检测；建议分享短链）
   - 其它 → `python3 scripts/convert/convert_url.py <URL>`（markitdown 封装；**JS 渲染站点为已知限制**，如头条）
3. **检查成功标记**：微信（图文与分享页）/小红书 stdout `md written: <…>md`；通用 `CONVERT_URL_OK <pkg_dir>`；无则失败。
4. **产物核验**：主 md 非空；`source_page.html` 存在；通用与微信分享页含 `metadata.json`（title/url/platform/published）。

## 已知方案：小红书标题兜底（2026-09 修复）
- 现象：多数小红书笔记页面 JSON **无独立 title**（作者只写正文，卡片展示正文首行）→ 旧实现回退通用名「小红书笔记」，导致标题/资产名错误并触发人工确认。
- 方案：`scripts/convert/xhs_convert.py` 在 title 缺失时以 **desc 首行**为标题（去空行、trim）；仅 desc 也为空才回退通用名。已在真实短链验证（`xhslink.cn/o/5SvRaFZzj5p` → `Obsidian难上手？这10个ai插件直接开挂！🚀`）。
- Agent 执行：**不再因标题缺失向用户弹确认**；若仍异常按此自动处理并在 REPORT 标注标题来源（页面 title / desc 首行兜底 / 通用名回退）。

## 常驻能力：微信分享页「图片消息 / 文字消息」（2026-09 起）
发表记录里并非所有条目都是图文：一部分是**图片消息**（`item_show_type=8`）或**文字消息**（`item_show_type=10`）。微信对这两类只返回分享页（`pages/common_share.html`），页面内**没有 `id="js_content"` 正文 DOM**，因此 `wechat_read_v3.py` 的 article 判定必然失败（报 `captcha/odd page`）——这是**内容类型差异，不是限流，重试无效**。

| 类型 | `item_show_type` | 正文来源 |
|---|---|---|
| 图片消息 | `8` | `picture_page_info_list[].cdn_url`（按文档顺序下载全部图片）+ `window.desc` 文本 |
| 文字消息 | `10` | `content_noencode` 全文 |

- **调度（常驻，写进配置）**：`config/pipeline.json → convert.converter_fallbacks["mp.weixin.qq.com"]`。微信 URL **先** `wechat_read_v3.py`；判定失败**再**用 `wechat_share_v3.py`；两者都失败才记 ledger `error`，并在 REPORT 标注消息类型与失败阶段。
- **元数据**：标题 `msg_title`（→ `og:title` 兜底）、公众号 `window.name`/`nick_name`、发布时间 `window.ct`（Unix→北京时间）、`biz`；随包写 `metadata.json`。产物契约与图文一致：`md written: <…>.md`，可直接接 FORMAT/STORE。
- **命名**：文字消息的「标题」即整段文本（微信如此定义），按 `wf.sanitize_name` 归一（禁符→`_`、压空白、上限 120 字）；不要自造标题。
- **实现边界**：`scripts/convert/wechat_share_v3.py` 为独立脚本，**不改动 `wechat_read_v3.py` 核心逻辑**，两者各自演进。

### 分享页文本的编码处理（必守顺序；2026-09 修复）
分享页文本常叠加两层编码：JS 字符串转义（`\xNN`）+ HTML 转义（`&lt;a …`、`&amp;nbsp;`）。
顺序必须是：
1. **JS 反转义**（`\xNN`/`\uNNNN`/`\n` → 字符）
2. **HTML 反转义**（还原真实标记：`&lt;a` → `<a`）
3. **标签处理**（`<br>`→换行、`<a href>`→markdown 链接、小程序链接取文字、其余标签剥离）
4. **再消残余实体**（`&nbsp;` `&amp;` `&quot;` … → 字符）
5. **压空白**（`\xa0`→空格、合并连续空格/空行）

顺序颠倒（如先剥标签再反转义）会让被转义的标签在末次反转义时**「复活」成裸 HTML**，正文残留 `&nbsp;`、`&amp;`、`<a …>`。图片消息与文字消息**共用同一个函数**（`rich_to_text()`），禁止各写一套；标题另走 `clean_title()`。回归检查见下方自检清单。

## 判定 / 退出
- 成功：输出包目录 + 上述要素齐全。
- 失败：包保留可重试；编排层把该 url_key 记 ledger `error`；返回失败原因（含图片失败清单——失败图保留原 URL 由后续 Verify 拦截，不静默）。

## 自检清单
```bash
python3 scripts/convert/wechat_read_v3.py "<微信URL>"
python3 scripts/convert/wechat_share_v3.py "<微信URL>"   # 图片消息/文字消息分享页（图文判定失败时的常驻兜底）
python3 scripts/convert/xhs_convert.py "<小红书链接>" --dry
python3 scripts/convert/convert_url.py "https://docs.python.org/3/tutorial/introduction.html" --dry
# 分享页编码回归：正文不得残留 HTML 实体/裸标签（应输出「无」）
python3 - <<'PY'
import re,glob
for f in glob.glob('staging/converted/微信文章/分享_*/*.md'):
    b=open(f,encoding='utf-8').read().split('---',2)[-1]
    e=re.findall(r'&[a-zA-Z]+;|&#\d+;',b); t=[x for x in re.findall(r'<[a-zA-Z/][^>]{0,80}>',b) if not x.startswith('<http')]
    print(f, '实体:', e or '无', '裸标签:', t or '无')
PY
# 全链：OBS_VAULT_ROOT=… python3 tests/run_m0.py "<URL>"（含 format/verify/store）
```

## 边界 / 引用
- 不做：套模板、定库路径、**最终去重判定**（分别属 obsidian-format / obsidian-store 的 DEDUP）。
- 契约：`docs/工作流v1定义.md` §2/§4；`scripts/convert/README.md`；自动化约定归 DSH（`rule_src` 不含执行机制）。
