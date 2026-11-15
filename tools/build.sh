#!/usr/bin/env bash
# Package src/ into dist/zen-tree-tabs-<version>.xpi
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$ROOT/src/manifest.json")"
OUT="$ROOT/dist/zen-tree-tabs-$VERSION.xpi"
mkdir -p "$ROOT/dist"
rm -f "$OUT"
(cd "$ROOT/src" && zip -qr -X "$OUT" .)
echo "$OUT"
