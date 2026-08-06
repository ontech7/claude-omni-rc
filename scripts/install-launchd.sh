#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# `|| true`: under set -euo pipefail, a failing command -v would TERMINATE the
# script before the -z guard — the || true keeps the error message reachable.
NODE="$(command -v node || true)"
TSX="$(command -v tsx || true)"
# tsx is a local devDependency (node_modules/.bin) — often not on PATH:
# fall back to the local bin after `npm install` (see README).
if [ -z "$TSX" ] && [ -x "$REPO/node_modules/.bin/tsx" ]; then
  TSX="$REPO/node_modules/.bin/tsx"
fi
STATE="${STATE_DIR:-$HOME/.ollama-rc}"
PLIST="$HOME/Library/LaunchAgents/com.ontech7.ollama-rc.plist"
LABEL="com.ontech7.ollama-rc"

if [ -z "$NODE" ] || [ -z "$TSX" ]; then
  echo "node or tsx not found in PATH" >&2
  exit 1
fi

mkdir -p "$STATE/logs"
mkdir -p "$(dirname "$PLIST")"
sed -e "s|__NODE__|$NODE|g" \
    -e "s|__TSX__|$TSX|g" \
    -e "s|__DAEMON__|$REPO/src/daemon.ts|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__STATE__|$STATE|g" \
    "$REPO/scripts/com.ontech7.ollama-rc.plist.template" > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "ollama-rc daemon installed (label $LABEL)."
echo "Logs: $STATE/logs/daemon.log"
