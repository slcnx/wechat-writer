#!/usr/bin/env bash
# macOS / Linux 启动：首次自动安装依赖
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules/@openai/codex ] || npm install --omit=dev --no-audit --no-fund
exec node src/server.js "$@"
