#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# `|| true`: sotto set -euo pipefail, command -v che fallisce TERMINEREBBE lo script
# prima della guardia -z — il || true rende raggiungibile il messaggio di errore.
NODE="$(command -v node || true)"
TSX="$(command -v tsx || true)"
# tsx è una devDependency locale (node_modules/.bin) — spesso non è su PATH:
# fallback al bin locale dopo `npm install` (vedi README).
if [ -z "$TSX" ] && [ -x "$REPO/node_modules/.bin/tsx" ]; then
  TSX="$REPO/node_modules/.bin/tsx"
fi
STATE="${STATE_DIR:-$HOME/.ollama-rc}"
PLIST="$HOME/Library/LaunchAgents/com.ontech7.ollama-rc.plist"
LABEL="com.ontech7.ollama-rc"

if [ -z "$NODE" ] || [ -z "$TSX" ]; then
  echo "node o tsx non trovati in PATH" >&2
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
echo "Daemon ollama-rc installato (label $LABEL)."
echo "Log: $STATE/logs/daemon.log"
