#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Rule Update（M1-C，DSH 机制壳）：读 rule_src 两文件 → 解析 → 校验 → 原子替换本地运行产物。

用法:
    python3 scripts/manage/rule_update.py check|update|report

- check ：轻量变化判断（两文件 sha256 vs 本地戳）；无变化且产物存在 → REUSE；否则 NEED_UPDATE（不执行）
- update：解析+校验 → 生成（模板/配置/业务规则 json）→ 原子替换 → 写戳 → 报告；失败保留旧产物（R7）
- report：打印最近一次生成的来源/结果摘要

环境（测试可覆盖）：
    OBS_RULES_DIR / OBS_OUT_CONFIG / OBS_OUT_TEMPLATE / OBS_RULES_JSON / OBS_STAMP_FILE
边界：Parser 只产出 Obs 资料业务规则；执行机制（去重/冲突/Verify/retry/Ledger）仍属 DSH 侧配置，不被 Obs 生成覆盖。
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import rule_parser

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE_DIR = os.path.join(ROOT, 'logs', 'state')


def env_or(key, default):
    return os.environ.get(key) or default


def paths():
    return {
        'config': env_or('OBS_OUT_CONFIG', os.path.join(ROOT, 'config', 'obsidian.json')),
        'template': env_or('OBS_OUT_TEMPLATE', os.path.join(ROOT, 'templates', '文章模板.md')),
        'rules_json': env_or('OBS_RULES_JSON', os.path.join(STATE_DIR, 'business-rules.json')),
        'stamp': env_or('OBS_STAMP_FILE', os.path.join(STATE_DIR, 'rule_stamp.json')),
    }


def sources_hashes():
    p = paths()
    h = {}
    for name, path in rule_parser.rule_paths().items():
        with open(path, 'rb') as f:
            h[name] = hashlib.sha256(f.read()).hexdigest()
    return h


def read_stamp():
    p = paths()['stamp']
    if not os.path.isfile(p):
        return None
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def write_stamp(hashes):
    p = paths()['stamp']
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump({'hashes': hashes,
                   'generated_at': __import__('datetime').datetime.now().isoformat(timespec='seconds')},
                  f, ensure_ascii=False, indent=2)


def check(verbose=True):
    h = sources_hashes()
    stamp = read_stamp()
    p = paths()
    ok = stamp is not None and stamp.get('hashes') == h and \
        os.path.isfile(p['config']) and os.path.isfile(p['template'])
    if verbose:
        print('RULE_CHECK %s' % ('REUSE（无变化，复用本地产物）' if ok else 'NEED_UPDATE（缺失或规则变化）'))
    return ok


# ---------- 生成 ----------

def build_template(rules):
    fields = rules['template']['fields']
    lines = ['---']
    for f in fields:
        name = f['name']
        if f['type'] == 'const':
            lines.append('%s: %s' % (name, f['default']))
        elif f['type'] == 'bool' and f['default'] is False:
            lines.append('%s: false' % name)
        elif f['type'] == 'array':
            lines.append('%s: []' % name)
        elif name in ('published', 'created'):
            lines.append('%s: {{%s}}' % (name, name))
        else:
            lines.append('%s: "{{%s}}"' % (name, name))
    lines.append('---')
    h1 = rules['template']['body'].get('h1', True)
    lines.append('')
    lines.append('# {{title}}' if h1 else '')
    lines.append('')
    lines.append('<!-- 正文：由 DSH FORMAT 注入；图片相对 assets/…（derived from rule_src/WebArticle.md） -->')
    return '\n'.join(lines).rstrip() + '\n'


def build_config(rules, prev):
    out = json.loads(json.dumps(prev)) if prev else {}
    if 'vault' not in out:
        out['vault'] = {'kind': 'external', 'vault_root': '【待填】', 'vault_test_root': 'tests/tmp_vault'}
    if '说明' not in out:
        out['说明'] = '【DSH 运行配置·Obsidian】M1-C 生成（derived from rule_src/ 两文件 + DSH 运行参数；禁止人工长期覆盖）'
    b = rules['business']
    fields = rules['template']['fields']
    out.setdefault('frontmatter', {})
    out['frontmatter']['schema'] = {}
    for f in fields:
        out['frontmatter']['schema'][f['name']] = {
            'type': f['type'],
            'default': f['default'],
            'runtime': f['runtime'],
            'note': '由 rule_src/WebArticle.md 解析（M1-C 生成；M2 起 format 按此 schema 输出）',
        }
    st = out.setdefault('store', {})
    st['top_folder'] = b['storage']['top_dir'] or st.get('top_folder', '01_文章分享')
    monthly = bool(b['storage'].get('month_rule'))
    st['folder_pattern'] = '{top}/{YYYY}/{MM}/{name}' if monthly else '{top}/{YYYY}/{name}'
    st['year_field'] = b['storage']['year_rule'] or st.get('year_field', 'created')
    if monthly:
        st['month_field'] = 'created'
    elif 'month_field' in st:
        del st['month_field']
    st['platform_dir'] = bool(b['storage']['platform_dir'])
    cleaning = b['filename']['cleaning']
    nm = st.setdefault('naming', {})
    nm['pattern'] = '纯标题（Obs 默认标题命名）'
    nm['cleanup'] = '禁符→_；压缩空白；去首尾点空格；上限%d字（Obs 5.3）' % (cleaning['max_len'] or 120)
    st['assets_dir'] = b['package']['assets_dir'] or 'assets'
    st['source_page'] = '保留在 Stored Asset' if b['package']['source_page_in_package'] else '（Obs 未确认入库）'
    st['package'] = '<name>/{<name>.md + %s/ + %s}（原子资产包，禁止跨文章共享）' % (
        st['assets_dir'], 'source_page.html' if b['package']['source_page_in_package'] else '')
    st['rule_source'] = 'M1-C 生成自 rule_src/（WebArticle.md + webArticle同步配置规范.md）→ M4 切 99_obsConfig'
    return out


def validate(rules):
    errs = []
    if not rules['template']['fields']:
        errs.append('模板无有效字段（frontmatter 缺失/损坏）')
    names = {f['name'] for f in rules['template']['fields']}
    for req in ('title', 'type', 'url'):
        if req not in names:
            errs.append('模板缺少必填字段: %s' % req)
    b = rules['business']
    if not b['storage']['top_dir']:
        errs.append('规范中未识别正式存储目录')
    if not b['storage']['year_rule']:
        errs.append('规范中未识别年份规则')
    if not b['filename']['cleaning']['max_len']:
        errs.append('规范中未识别文件名清洗上限')
    return errs


def atomic_write(path, text):
    tmp = path + '.tmp.%d' % os.getpid()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, path)


def update():
    rules = rule_parser.parse_all()
    errs = validate(rules)
    if errs:
        print('RULE_UPDATE_FAIL 校验未通过（保留旧产物，不替换）:')
        for e in errs:
            print('  -', e)
        print('  warnings:', rules['warnings'])
        return 2
    p = paths()
    prev = {}
    if os.path.isfile(p['config']):
        with open(p['config'], encoding='utf-8') as f:
            prev = json.load(f) or {}
    cfg_text = json.dumps(build_config(rules, prev), ensure_ascii=False, indent=2) + '\n'
    tpl_text = build_template(rules)
    rules_text = json.dumps(rules, ensure_ascii=False, indent=2) + '\n'
    atomic_write(p['template'], tpl_text)
    atomic_write(p['config'], cfg_text)
    atomic_write(p['rules_json'], rules_text)
    write_stamp(sources_hashes())
    print('RULE_UPDATE_OK')
    print('  来源: ✓ %s' % '  ✓ '.join(os.path.join('rule_src', n) for n in rule_parser.RULE_FILES))
    print('  生成: ✓ %s  ✓ %s  ✓ %s' % (p['template'], p['config'], p['rules_json']))
    print('  状态: ✓ Parser PASS  ✓ Config PASS —— 运行配置已更新')
    for w in rules['warnings']:
        print('  WARNING:', w)
    return 0


def report():
    rules_json = paths()['rules_json']
    if not os.path.isfile(rules_json):
        print('REPORT 无历史生成（先执行 update）')
        return 1
    with open(rules_json, encoding='utf-8') as f:
        rules = json.load(f)
    b = rules['business']
    print('REPORT 最近生成解析结果:')
    print('  template fields:', [f['name'] for f in rules['template']['fields']])
    print('  storage:', b['storage'])
    print('  filename:', b['filename']['rule'], b['filename']['cleaning'])
    print('  package:', b['package'])
    print('  semantics:', b['semantics'])
    for w in rules.get('warnings', []):
        print('  WARNING:', w)
    return 0


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('check', 'update', 'report'):
        print('用法: python3 scripts/manage/rule_update.py check|update|report', file=sys.stderr)
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == 'check':
        check()
        return 0
    if cmd == 'update':
        return update()
    return report()


if __name__ == '__main__':
    sys.exit(main())
