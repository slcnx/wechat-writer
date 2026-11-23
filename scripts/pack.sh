#!/usr/bin/env bash
# 打包成 dist/wechat-writer.zip（不含 node_modules），供拷贝到 Windows 安装。
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/wechat-writer
cp -R package.json src public skills scripts docs dist/wechat-writer/
[ -f package-lock.json ] && cp package-lock.json dist/wechat-writer/
(cd dist && zip -qr wechat-writer.zip wechat-writer && rm -rf wechat-writer)
echo "已生成 $(pwd)/dist/wechat-writer.zip"
