#!/usr/bin/env bash
# Launch a throwaway Zen instance with the extension loaded unpacked from src/
# and Marionette enabled (port $MARIONETTE_PORT, default 2829).
#
#   tools/dev.sh [--fresh]     --fresh wipes the dev profile first
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${ZTT_DEV_PROFILE:-${XDG_CACHE_HOME:-$HOME/.cache}/zen-tree-tabs-dev-profile}"
PORT="${MARIONETTE_PORT:-2829}"
EXT_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["browser_specific_settings"]["gecko"]["id"])' "$ROOT/src/manifest.json")"

if [[ "${1:-}" == "--fresh" ]]; then rm -rf "$PROFILE"; shift; fi
mkdir -p "$PROFILE/extensions"

cat > "$PROFILE/user.js" <<EOF
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.experiments.enabled", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.startupScanScopes", 15);
user_pref("marionette.port", $PORT);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("zen.welcome-screen.seen", true);
user_pref("devtools.chrome.enabled", true);
user_pref("devtools.debugger.remote-enabled", true);
user_pref("devtools.debugger.prompt-connection", false);
user_pref("browser.sessionstore.resume_from_crash", true);
user_pref("browser.startup.page", 3);
EOF

# Proxy file: loads the extension straight from the source directory.
printf '%s' "$ROOT/src" > "$PROFILE/extensions/$EXT_ID"

exec zen-browser --no-remote --profile "$PROFILE" --marionette -remote-allow-system-access -purgecaches "$@" \
  >"$PROFILE/stdout.log" 2>&1
