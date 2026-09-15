#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rule Parser v1（M1-C）—— 把 Obs 两个规则文件解析为结构化 Obs Business Rules。

输入（M1–M3）：
    rule_src/WebArticle.md             （= 文件内部模板；真实 M4: 99_obsConfig/Templates/WebArticle.md）
    rule_src/webArticle同步配置规范.md  （= 资料管理规则；真实 M4: 99_obsConfig/webArticle同步配置规范.md）

输出：结构化 dict（Obs Business Rules），键范围：
    source_files / template{fields,body,h1} /
    business{storage top_dir,year_rule,platform_dir,filename_rule,filename_no_extra,
             filename_cleaning,package_files,article_package,assets_dir,source_page_in_package,
             semantics, tags_policy} / warnings

原则：只解析 Obs 资料管理业务规则；不解析/不产出执行机制（去重/冲突/Verify/retry/Ledger 等）。
      无法确定的 prose 进入 warnings，不臆造。
环境：OBS_RULES_DIR 可覆盖（测试 fixture 用）。
"""
import json
import os
import re

RULE_FILES = ('WebArticle.md', 'webArticle同步配置规范.md')


# 真实规则源（Obsidian 库内的 99_obsConfig）。**不写死路径**：
# 优先用 OBS_REAL_RULES 指定，其次尝试从 vault 根推导，最后回退内置 rule_src 快照。
REAL_RULES_ENV = 'OBS_REAL_RULES'
REAL_RULES_SUBDIR = '99_obsConfig'


def _candidate_vault_roots():
    """可能的 Vault 根：环境变量优先，其次 config/obsidian.json 的 vault_root。"""
    roots = []
    env = os.environ.get('OBS_VAULT_ROOT')
    if env:
        roots.append(os.path.abspath(env))
    try:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(base, 'config', 'obsidian.json'), encoding='utf-8') as f:
            vr = (json.load(f).get('vault') or {}).get('vault_root') or ''
        if vr and '待填' not in vr:
            roots.append(os.path.abspath(vr))
    except Exception:
        pass
    return roots


def rules_dir():
    """默认规则源：M4 起为真实 99_obsConfig（可回退 rule_src 快照）；OBS_RULES_DIR 显式覆盖。"""
    env = os.environ.get('OBS_RULES_DIR')
    if env:
        return env
    # 显式指定的真实规则源
    explicit = os.environ.get(REAL_RULES_ENV)
    if explicit and os.path.isdir(explicit):
        return explicit
    # 由 vault 根推导：<vault>/99_obsConfig（vault 根取自 OBS_VAULT_ROOT 或 config）
    for vault in _candidate_vault_roots():
        cand = os.path.join(vault, REAL_RULES_SUBDIR)
        if os.path.isdir(cand):
            return cand
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'rule_src')


def _resolve(dirpath, name):
    """真实 99_obsConfig 形态兼容：根目录或 Templates/ 下的模板、带 _v1.x 后缀的规范。"""
    direct = os.path.join(dirpath, name)
    if os.path.isfile(direct):
        return direct
    tpl = os.path.join(dirpath, 'Templates', name)
    if os.path.isfile(tpl):
        return tpl
    if name.startswith('webArticle同步配置规范'):
        try:
            hits = sorted(f for f in os.listdir(dirpath)
                          if f.startswith('webArticle同步配置规范') and f.endswith('.md'))
            if hits:
                return os.path.join(dirpath, hits[-1])
        except Exception:
            pass
    raise FileNotFoundError('规则文件缺失: %s under %s' % (name, dirpath))


def rule_paths():
    d = rules_dir()
    return {n: _resolve(d, n) for n in RULE_FILES}


def load_rule(name):
    with open(rule_paths()[name], encoding='utf-8') as f:
        return f.read()


# ---------- WebArticle.md（模板 / 文件内部结构） ----------

def split_frontmatter(text):
    lines = text.splitlines()
    if not lines or lines[0].strip() != '---':
        return [], lines
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == '---'), None)
    if end is None:
        return [], lines
    return lines[1:end], lines[end + 1:]


def _kind_of(name, val):
    if val == 'web_article':
        return 'const', val
    if val.startswith('<%'):
        if 'tp.date.now' in val or 'T' in val and re.search(r'\d{4}-\d{2}-\d{2}T', val):
            return 'datetime', None
        return 'string', None  # 运行期由 DSH 填充（title/path 等）
    low = val.strip().lower()
    if low in ('true', 'false'):
        return 'bool', low == 'true'
    if val.strip() == '[]':
        return 'array', []
    if val.strip() == '':
        return 'string', ''
    return 'string', val.strip()


def parse_template(text):
    fm, body = split_frontmatter(text)
    warnings = []
    if not fm:
        warnings.append('WebArticle.md 无有效 frontmatter（缺失 --- 包裹）')
    fields = []
    seen = set()
    for ln in fm:
        s = ln.strip()
        if not s or ':' not in s:
            continue
        name, _, raw = s.partition(':')
        name = name.strip()
        if not name or name in seen:
            continue
        seen.add(name)
        val = raw.strip()
        kind, default = _kind_of(name, val)
        fields.append({'name': name, 'type': kind,
                       'default': default, 'runtime': val.startswith('<%'),
                       'source_raw': val})
    first_nonempty = next((b for b in body if b.strip()), '')
    h1 = first_nonempty.strip().startswith('# ')
    body_lines = [b for b in body if b.strip()][:6]
    return {'fields': fields, 'body': {'h1': h1, 'lines_sample': body_lines}}, warnings


# ---------- webArticle同步配置规范.md（资料管理规则） ----------

def _section(text, title):
    """按标题切段：定位含 title 的标题行，收集其后内容，直到遇到同级或更高级标题（子标题继续包含）。"""
    lines = text.splitlines()
    start = None
    level = 0
    for i, ln in enumerate(lines):
        m = re.match(r'^(#{1,3})\s+(.*)$', ln)
        if m and title in m.group(2):
            start = i
            level = len(m.group(1))
            break
    if start is None:
        return ''
    out = []
    for ln in lines[start + 1:]:
        m = re.match(r'^(#{1,3})\s+', ln)
        if m and len(m.group(1)) <= level:
            break
        out.append(ln)
    return '\n'.join(out)


def parse_business(text):
    storage = _section(text, '正式存储位置')
    naming = _section(text, '文件命名')
    package = _section(text, '单篇资料组织方式')
    images = _section(text, '图片与附件')
    timepath = _section(text, '时间与路径语义')
    tags_sec = _section(text, '标签')
    know_sec = _section(text, 'WebArticle 与 Knowledge')
    front = _section(text, 'Frontmatter')

    def has(sec, *words):
        return all(w in sec for w in words)

    m_top = re.search(r'/(\d+_文章分享)', text)
    top_dir = m_top.group(1) if m_top else ''
    m_year = re.search(r'年份依据[:：]?\s*\n```text\s*\n(created|published)\s*\n```', storage)
    year_rule = m_year.group(1) if m_year else ('created' if '年份依据' in storage else '')
    month_rule = 'created' if '月份' in storage else None  # 月份与 created 同源（进入库时间）
    platform_dir = not ('不按平台建立子目录' in storage or '不按平台建立物理目录' in text)
    if 'platform' not in text:
        platform_dir = None  # 无法确认时不臆造
    filename_rule = 'title' if has(naming, '默认使用文章标题') else ''
    filename_no_extra = bool(re.search(r'不在文件名中加入业务属性', naming))
    m_len = re.search(r'(\d{2,3})\s*字符', naming)
    cleaning = {
        'max_len': int(m_len.group(1)) if m_len else None,
        'forbidden_to_underscore': '非法字符' in naming and '_' in naming,
        'collapse_space': '压缩连续空白' in naming,
        'trim_edges': '首尾点和空格' in naming,
    }
    pkg_files = [f for f in ('<name>.md', 'assets/', 'source_page.html') if f in package] or \
                [f for f in ('assets/', 'source_page.html') if f in package]
    article_package = has(package, '资产包') or has(package, '原子')
    assets_dir = 'assets' if 'assets/' in text else ''
    source_page_in_package = bool(re.search(r'source_page\.html', package)) and \
        (bool(re.search(r'原始网页快照|快照', images)) or '原始网页快照' in text)

    semantics = {}
    if has(timepath, 'created', 'Knowledge Vault'):
        semantics['created'] = '进入 Knowledge Vault 的时间'
    if re.search(r'path', timepath) and '快照' in timepath:
        semantics['path'] = '创建时路径快照（非实时）'
    if 'published' in timepath and '原文章' in timepath:
        semantics['published'] = '原文章发布时间'
    if 'platform' in front or 'platform' in text:
        semantics['platform'] = '实际发布平台（不建受控词表）'
    if know_sec:
        semantics['webarticle_vs_knowledge'] = 'WebArticle ≠ Knowledge（进入 Vault 不自动变成 Knowledge）'
    if tags_sec and '[]' in tags_sec:
        semantics['tags'] = 'tags: []，暂不建立受控标签体系'

    rules = {
        'storage': {'top_dir': top_dir, 'year_rule': year_rule, 'month_rule': month_rule,
                    'platform_dir': platform_dir},
        'filename': {'rule': filename_rule, 'no_extra_attrs': filename_no_extra, 'cleaning': cleaning},
        'package': {'files': pkg_files, 'article_package': article_package,
                    'assets_dir': assets_dir, 'source_page_in_package': source_page_in_package},
        'semantics': semantics,
    }
    warnings = [k for k, v in {
        'top_dir': top_dir, 'year_rule': year_rule, 'filename_rule': filename_rule,
        'cleaning.max_len': cleaning['max_len'],
    }.items() if not v]
    return rules, warnings


def parse_all():
    src = {n: load_rule(n) for n in RULE_FILES}
    warnings = []
    template, w1 = parse_template(src['WebArticle.md'])
    warnings += ['WebArticle.md: ' + w for w in w1]
    business, w2 = parse_business(src['webArticle同步配置规范.md'])
    warnings += ['webArticle同步配置规范.md: ' + w for w in w2]
    return {
        'source_files': {n: {'rule_src': os.path.join('rule_src', n),
                             'real_m4': ('99_obsConfig/Templates/' if n == 'WebArticle.md'
                                         else '99_obsConfig/') + n} for n in RULE_FILES},
        'template': template,
        'business': business,
        'warnings': warnings,
    }


if __name__ == '__main__':
    rules = parse_all()
    print(json.dumps(rules, ensure_ascii=False, indent=2))
