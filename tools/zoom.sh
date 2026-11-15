#!/usr/bin/env bash
# Screenshot the dev browser and crop/zoom the sidebar: tools/zoom.sh out.png [height]
set -euo pipefail
OUT="$1"; H="${2:-560}"
python3 "$(dirname "$0")/marionette.py" shot "$OUT.full.png" >/dev/null
magick "$OUT.full.png" -crop "190x${H}+0+140" +repage -filter point -resize 300% "$OUT"
rm "$OUT.full.png"
echo "$OUT"
