# scripts/convert/ — 获取与转化阶段

把网页正文转为 **Markdown + 本地图片**，产出统一落点 `staging/converted/<来源>/…`（由 `config/pipeline.json` 的 `convert` 段控制，相对路径以工作区根为基准）。

**文章包 = 原子单位**：每篇文章输出为一个独立包目录（主 md + 随包 `images/` + 源文件），md 与附件必须整包一起处理；**不做跨文章共享附件/图片目录**。

| 文件 | 职责 |
|---|---|
| `wechat_read_v3.py` | 微信公众号**图文**文章抓取（需 bs4，见下方依赖）；产出 `<标题>.md` + `images/` + `source_page.html` + `读取说明.md` |
| `wechat_share_v3.py` | 微信公众号**分享页**抓取（图片消息 `item_show_type=8` / 文字消息 `=10`，仅标准库）；产出 `<标题>.md` + `images/` + `source_page.html` + `metadata.json` + `读取说明.md` |
| `xhs_convert.py` | 小红书笔记抓取（仅标准库）；支持 `--dry` 只解析；产出 `<标题>.md` + `images/` + `source_page.html` |
| `_common.py` | 共享：定位工作区根（向上找 `config/pipeline.json`，可用环境变量 `OBS_WS_ROOT` 覆盖）、读取 convert 默认输出路径 |
| `install-deps.sh` | 一键安装微信脚本依赖（beautifulsoup4 到 `/tmp/pylibs`） |
| `convert_url.py` | 【M1-A 已实现】通用网页 markitdown 封装：通用网页→Content Package（图片落盘+相对化+source_page） |
| `convert_toutiao.py` | 【M3+ 已实现】头条站点适配：手机 UA+短链跟随+`_$jsvmprt` 壳检测+DOM 正文/图片提取 |

## 用法

```bash
# 微信文章（不传目录 → 每次运行生成唯一文章包目录 staging/converted/微信文章/文章_时间戳_pid/）
python3 wechat_read_v3.py "<mp.weixin.qq.com 链接>"
python3 wechat_read_v3.py "<链接>" "文章包目录"    # 显式指定包目录（整包原子单位）

# 微信分享页：图片消息 / 文字消息（包名前缀 分享_；图文判定失败时的常驻兜底，见 pipeline.json converter_fallbacks）
python3 wechat_share_v3.py "<mp.weixin.qq.com 链接>" [输出包目录]

# 小红书（--dry 仅解析元数据，不下载）
python3 xhs_convert.py "<xhslink.cn 或 xiaohongshu.com 链接>" [输出目录] [--dry]

# 通用网页（markitdown 封装，M1-A；--dry 只解析标题不下载）
python3 convert_url.py "<任意网页URL>" [输出包目录] [--dry]
```

## 依赖安装

```bash
bash install-deps.sh     # 安装 beautifulsoup4 到 /tmp/pylibs（macOS/Linux 通用）
```

## 说明与边界（沿袭原 网页抓取工具 规范）

- **忠实原文**：正文文字逐段原样保留，不改写不删减；图片按出现顺序编号。
- **排除外围**：页头/页脚导航、二维码、评论、推荐等页面外围不入 md。
- **格式**：webp 图片默认经 macOS `sips` 转 png（`config/pipeline.json → webp_to_png` 可关）。
- **小红书标题（2026-09 修复）**：页面无独立 title 时以 desc 首行兜底（真实短链验证通过），不再回退「小红书笔记」。
- **小红书页面改版 + 登录墙（2026-09 修复）**：桌面 UA 请求笔记页现在一律被 302 到 `/login?redirectPath=…`（登录墙页面的 `__INITIAL_STATE__` 里**没有** `noteDetailMap`），移动端 UA 仍能直接拿到分享页。因此：
  - **取页**：移动端 UA 优先（`PAGE_UAS`），落地路径是 `/login` 即判失败并换下一个 UA，全败才报「登录墙」（同一 UA 反复重试无意义）；`link` 直接用跟随重定向后的落地 URL。
  - **解析**：兼容两代结构 —— 新分享页 `noteData.data.noteData`（图片 `url` / `infoList[].url`、作者 `user.nickName`）与旧桌面页 `note.noteDetailMap`（`urlDefault` / `user.nickname`）。
  - 真实短链验证：`xhslink.cn/o/1qG1J8J6lI8` → 10/10 图、`VERDICT PASS`、已入库；回归见 `pipeline/tests/test_xhs_page_variants.py`。
- **通用网页（convert_url.py）边界（M1-A 实测）**：依赖服务端渲染/静态 HTML（实测 docs.python.org ✅）；产物含 `metadata.json`（title/url，供 FORMAT）；站内相对装饰图（`../_static/…`）无法本地化，会在 convert 时清理。
- **头条（convert_toutiao.py，M3+）**：页面为 `_$jsvmprt` 动态反爬壳；桌面 UA 直抓无正文 → 用手机 UA + 短链跟随拿真实页（DOM 顺序提取段落/图片）；仍命中壳则给出明确"动态反爬，请浏览器打开/稍后重试"，不伪装成功。
- **验证码/风控**：微信脚本自动重试 + 桌面 UA；小红书对**桌面 UA** 一律给登录墙（改用移动端 UA，见上），页面改版需跟进。
- **微信分享页（wechat_share_v3.py，2026-09 起常驻）**：发表记录中「图片消息」(8) / 「文字消息」(10) 只返回 `pages/common_share.html`，**无 `id="js_content"`**，`wechat_read_v3.py` 必然判失败（`captcha/odd page`，非限流、重试无效）。本脚本按类型取正文：图片消息＝`picture_page_info_list[].cdn_url`（按序下载）+ `window.desc` 文本；文字消息＝`content_noencode` 全文（标题即整段文本）。
  文本处理顺序**必须**为：JS 反转义 → HTML 反转义 → 标签处理（`<br>`/`<a>`）→ 消残余实体 → 压空白；顺序颠倒会让被转义的标签「复活」成裸 HTML（历史 bug：正文残留 `&nbsp;`/`&amp;`/`<a …>`）。图片消息与文字消息共用 `rich_to_text()`。
  调度登记：`config/pipeline.json → convert.converter_fallbacks["mp.weixin.qq.com"]`；不改动 `wechat_read_v3.py`。
