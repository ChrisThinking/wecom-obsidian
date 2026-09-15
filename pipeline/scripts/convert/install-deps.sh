#!/bin/bash
# 安装网页抓取工具依赖（macOS / Linux 通用）
# 微信文章脚本需要 beautifulsoup4（安装到 /tmp/pylibs，不影响系统环境）
# 小红书脚本仅用 Python3 标准库，无需安装。

set -e
echo "==> 安装 beautifulsoup4 到 /tmp/pylibs ..."
python3 -m pip install --target /tmp/pylibs beautifulsoup4
echo "==> 验证 ..."
python3 -c "import sys; sys.path.insert(0, '/tmp/pylibs'); import bs4; print('beautifulsoup4', bs4.__version__, 'OK')"
echo "==> 完成。微信文章脚本运行时会自动将 /tmp/pylibs 加入模块搜索路径。"
