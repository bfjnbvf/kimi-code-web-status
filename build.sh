#!/bin/bash
# 打包 Kimi Code Monitor 为可分发的 zip（仅包含运行必需文件）
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('manifest.json','utf8')).version)")
OUT="kimi-code-monitor-v${VERSION}.zip"

rm -f "$OUT"
zip -r "$OUT" \
  manifest.json \
  content.js content.css background.js \
  popup.html popup.js \
  icons \
  README.md LICENSE \
  -x "*.DS_Store"

echo "已生成 $OUT"
unzip -l "$OUT"
