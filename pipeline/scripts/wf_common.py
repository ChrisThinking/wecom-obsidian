#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Workflow v1 共享工具（FORMAT/VERIFY/STORE 用）。

- 复用 scripts/convert/_common.py 的工作区定位与 pipeline 读取
- 补充：obsidian 配置读取、vault 根解析、URL 规范化(D2)、文件名清洗、
  frontmatter 简易解析、ledger(jsonl) 读写、包内主 md / 资源目录探测。
"""
import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import timezone, timedelta

CST = timezone(timedelta(hours=8))
TRACKING_KEYS = {'fbclid', 'gclid', 'msclkid', 'yclid', 'igshid'}
UA_HTTP = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')


def _common():
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'convert'))
    import _common  # noqa
    return _common


C = None  # lazy


def c():
    global C
    if C is None:
        C = _common()
    return C


def root():
    return c().workspace_root()


def load_pipeline():
    return c().load_pipeline()


def load_obsidian():
    try:
        with open(os.path.join(root(), 'config', 'obsidian.json'), encoding='utf-8') as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    return cfg if isinstance(cfg, dict) else {}


def vault_base():
    """vault 根解析：env OBS_VAULT_ROOT > obsidian.vault.vault_root(已填真值) > vault_test_root。"""
    env = os.environ.get('OBS_VAULT_ROOT')
    if env:
        return os.path.abspath(env)
    obs = load_obsidian().get('vault') or {}
    real = obs.get('vault_root') or ''
    if real and '待填' not in real and '【' not in real:
        return os.path.abspath(real)
    test = obs.get('vault_test_root') or 'tests/tmp_vault'
    return os.path.abspath(os.path.join(root(), test))


def platform_dir_of(meta):
    """由 frontmatter 的 url 推出平台目录名（供 `{platform}` 占位符使用）。

    `store.platform_map` 形如 `{"mp.weixin.qq.com": "微信",
    "xiaohongshu.com|xhslink.cn": "小红书", "default": "网页"}`：
    键支持 `|` 分隔多域名，`default` 兜底。
    """
    obs = load_obsidian().get('store') or {}
    raw = obs.get('platform_map') or {}
    table, default = {}, ''
    for key, value in raw.items():
        name = str(value)
        if key == 'default':
            default = name
            continue
        for host in str(key).split('|'):
            host = host.strip().lower()
            if host:
                table[host] = name
    try:
        host = (urllib.parse.urlparse(str(meta.get('url') or '')).hostname or '').lower()
    except Exception:
        host = ''
    if host.startswith('www.'):
        host = host[4:]
    if host in table:
        return table[host]
    for key, name in table.items():
        if host == key or host.endswith('.' + key):
            return name
    return default or str(meta.get('platform') or '网页')


def resolve_rel_dir(store_cfg, meta, name, created=''):
    """**唯一**的入库相对目录解析：由 `store.folder_pattern` 单点驱动。

    占位符（其余原样保留）：

      {top}       顶层目录名（store.top_folder）
      {YYYY}      年
      {MM}        月
      {platform}  平台目录名（按 platform_map 由 url 推出）
      {name}      笔记名（已清洗）

    FORMAT 生成 frontmatter 的 `path` 快照 与 STORE 的实际落点都必须调用本函数，
    否则规则一改就会「快照与落点不一致」。

    ⚠️ 历史缺陷：早期实现只在 pattern 里找 `MM` 决定「要不要按月」，其余占位符
    **被忽略** —— 设置页写 `{platform}/{YYYY}/{MM}/{name}` 看似生效，其实只是把
    `{top}` 换成了固定串，不同平台并不分目录。
    """
    cfg = store_cfg if isinstance(store_cfg, dict) else (load_obsidian().get('store') or {})
    pattern = str(cfg.get('folder_pattern') or '{top}/{YYYY}/{MM}/{name}')
    top = str(cfg.get('top_folder') or '01_文章分享')
    stamp = str(created or '')
    if re.match(r'\d{4}-\d{2}-', stamp):
        year, month = stamp[:4], stamp[5:7]
    elif re.match(r'\d{4}-', stamp):
        year, month = stamp[:4], now_cst().strftime('%m')
    else:
        now = now_cst()
        year, month = now.strftime('%Y'), now.strftime('%m')
    text = (pattern
            .replace('{top}', top)
            .replace('{platform}', platform_dir_of(meta))
            .replace('{YYYY}', year)
            .replace('{MM}', month)
            .replace('{name}', str(name)))
    parts = [seg for seg in text.split('/') if seg not in ('', '.', '..')]
    return '/'.join(parts)


def conflict_suffix(store_cfg=None):
    """同名冲突时是否加 `-2/-3` 后缀。

    由设置页「同名冲突自动加 -2/-3 后缀」物化进 `store.conflict_suffix`；缺省为
    True（与历史行为、文档一致）。为 False 时 STORE 遇到冲突直接失败并保留整包，
    让用户自己决定怎么处理 —— 这是设置页承诺过的行为，必须真的生效。
    """
    cfg = store_cfg if isinstance(store_cfg, dict) else (load_obsidian().get('store') or {})
    return cfg.get('conflict_suffix', True) is not False


def now_cst():
    return datetime.datetime.now(tz=CST)


def canonicalize_url(url):
    """URL 去重键（D2/P3）：去 fragment；scheme/host 规范化；去 tracking 参数；保留业务参数。

    域名特例（v1，仅 XHS）：
      xiaohongshu.com 的 explore/<id> 与 discovery/item/<id> 是同一笔记，
      统一归一为 xiaohongshu.com/note/<id>，使短链解析后与长链同 key。
    """
    try:
        p = urllib.parse.urlparse(url.strip())
    except Exception:
        return url.strip()
    scheme = p.scheme.lower() or 'http'
    host = (p.hostname or '').lower()
    if host.startswith('www.'):
        host = host[4:]
    path = p.path
    if host.endswith('xiaohongshu.com'):
        m = re.match(r'^/(?:explore|discovery/item)/([0-9a-zA-Z]+)', path)
        if m:
            return 'https://xiaohongshu.com/note/%s' % m.group(1)
    kept = []
    for k, v in urllib.parse.parse_qsl(p.query, keep_blank_values=True):
        if k.lower().startswith('utm_') or k.lower() in TRACKING_KEYS:
            continue
        kept.append((k, v))
    kept.sort(key=lambda kv: kv[0])
    query = urllib.parse.urlencode(kept) if kept else ''
    netloc = host
    if p.port:
        netloc = '%s:%s' % (host, p.port)
    return urllib.parse.urlunparse((scheme, netloc, path, '', query, ''))


def resolve_redirect(url, timeout=25):
    """跟随重定向拿到最终落地 URL（如 xhslink 短链 → xiaohongshu.com 页面）。

    仅用于 INPUT 阶段生成 url_key（不改动 source_url 原始值）；失败时原样返回。
    """
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA_HTTP, 'Accept': '*/*'})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read(1024)  # 触发整条重定向链并拿到最终 URL
            return resp.geturl()
    except Exception:
        return url


def sanitize_name(s, cap=120):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', '_', s or '').strip()
    s = re.sub(r'\s+', ' ', s).strip(' _.')
    return (s[:cap] or '未命名')


def parse_frontmatter(path):
    """极简 frontmatter 解析：--- 首尾包裹，key: value（值去引号）。"""
    try:
        with open(path, encoding='utf-8') as f:
            lines = f.read().splitlines()
    except Exception:
        return {}
    if not lines or lines[0].strip() != '---':
        return {}
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == '---':
            end = i
            break
    if end is None:
        return {}
    meta = {}
    for ln in lines[1:end]:
        if not ln.strip() or ln.lstrip().startswith('#'):
            continue
        if ':' in ln:
            k, _, v = ln.partition(':')
            meta[k.strip()] = v.strip().strip('"\'')
    return meta


def ledger_path():
    env = os.environ.get('OBS_LEDGER_FILE')
    if env:
        p = os.path.abspath(env)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return p
    pipe = load_pipeline().get('logging') or {}
    rel = pipe.get('processed_urls_file') or os.path.join('logs', 'state', 'processed-urls.jsonl')
    p = os.path.abspath(rel) if os.path.isabs(rel) else os.path.join(root(), rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


def ledger_last(url_key):
    """按 url_key 取最后一条记录（倒序扫描）。"""
    p = ledger_path()
    if not os.path.isfile(p):
        return None
    with open(p, encoding='utf-8') as f:
        for line in reversed(f.read().splitlines()):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get('url_key') == url_key:
                return rec
    return None


def ledger_append(rec):
    p = ledger_path()
    with open(p, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def find_main_md(pkg):
    """包内主 md：排除 读取说明.md / README*；多候选取体积最大。"""
    cands = []
    for name in os.listdir(pkg):
        if not name.lower().endswith('.md'):
            continue
        if name == '读取说明.md' or name.lower().startswith('readme'):
            continue
        cands.append(os.path.join(pkg, name))
    if not cands:
        return None
    cands.sort(key=lambda p: os.path.getsize(p))
    return cands[-1]


def assets_dir_name(store_cfg=None):
    """资产目录名：由 `store.assets_dir` 配置，默认 `assets`。

    早期实现把 `assets` 写死在三个脚本里（format/verify/wf_common），于是
    设置页改「资源目录名」根本不生效 —— 现在统一从这里取。
    """
    cfg = store_cfg if isinstance(store_cfg, dict) else (load_obsidian().get('store') or {})
    name = str(cfg.get('assets_dir') or 'assets').strip().strip('/')
    return name or 'assets'


def find_asset_dir(pkg):
    """探测 Content Package 里的资源目录。

    转换器产出的目录名可能是 `assets` 或 `images`（历史遗留），所以两者都探；
    但返回的只是**来源**目录，FORMAT 会把它改写成配置的资产目录名。
    """
    for name in ('assets', 'images'):
        d = os.path.join(pkg, name)
        if os.path.isdir(d):
            return d
    return None


def log(msg):
    print('[wf]', msg, flush=True)
