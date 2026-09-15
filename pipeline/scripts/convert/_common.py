#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
convert 阶段共享工具
====================
职责：
  1. 定位工作区根：向上查找含 config/pipeline.json 的目录；
     也可用环境变量 OBS_WS_ROOT 显式指定（测试/外部调用时用）。
  2. 读取 config/pipeline.json，并把其中的“工作区相对路径”统一解析为绝对路径。
  3. 提供 convert 阶段的默认输出约定（staging/converted 下按来源分子目录）。

约定：
  - 工作区根 = 含 config/ 与 staging/ 的目录（即本工作区 obsidian管理/）。
  - pipeline.json 内的相对路径一律以工作区根为基准。
"""
import json
import os

CFG_REL = os.path.join('config', 'pipeline.json')


def find_workspace_root(start=None):
    """从 start（缺省为 _common.py 所在目录）向上找含 config/pipeline.json 的目录。"""
    env = os.environ.get('OBS_WS_ROOT')
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    cur = os.path.abspath(start or os.path.dirname(os.path.abspath(__file__)))
    while True:
        if os.path.isfile(os.path.join(cur, CFG_REL)):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


def workspace_root():
    root = find_workspace_root()
    if not root:
        raise RuntimeError(
            '无法定位工作区根（向上未找到 config/pipeline.json）。'
            '可用环境变量 OBS_WS_ROOT 指定工作区根目录。')
    return root


def load_pipeline():
    """读取 config/pipeline.json；失败或缺省返回空 dict，由调用方兜底默认值。"""
    try:
        with open(os.path.join(workspace_root(), CFG_REL), encoding='utf-8') as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    return cfg if isinstance(cfg, dict) else {}


def ws_path(root, p):
    """p 为绝对路径则原样返回；相对路径按工作区根解析。"""
    if os.path.isabs(p):
        return p
    return os.path.normpath(os.path.join(root, p))


def convert_defaults(cfg=None):
    """convert 阶段默认输出约定（返回绝对路径 + 图片处理开关）。

    优先级：config/pipeline.json 的 convert 段 > 内置默认 staging/converted/…。
    兼容旧字段：顶层 webp_to_png（旧 抓取配置.json 风格）亦被读取。
    """
    cfg = cfg if cfg is not None else load_pipeline()
    root = workspace_root()
    conv = cfg.get('convert') or {}
    if not isinstance(conv, dict):
        conv = {}
    webp = cfg.get('webp_to_png', conv.get('webp_to_png', True))
    wbase = conv.get('wechat_output_base') or os.path.join('staging', 'converted', '微信文章')
    xbase = conv.get('xhs_output_base') or os.path.join('staging', 'converted', '小红书笔记')
    return {
        'workspace_root': root,
        'webp_to_png': bool(webp),
        'wechat_output_base': ws_path(root, wbase),
        'xhs_output_base': ws_path(root, xbase),
    }


if __name__ == '__main__':
    d = convert_defaults()
    print('workspace_root =', d['workspace_root'])
    print('wechat_output_base =', d['wechat_output_base'])
    print('xhs_output_base =', d['xhs_output_base'])
    print('webp_to_png =', d['webp_to_png'])
