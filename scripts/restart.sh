#!/usr/bin/env bash
#
# ollama-rc restart — restarts the launchd daemon to load new code.
#
# After a code change, the running process still has the old version in memory
# (tsx loads the source at startup): this script does a clean restart of the
# service without re-running ./install.sh.
#
# Usage:
#   scripts/restart.sh          restarts the service
#   scripts/restart.sh status   shows whether the service is active (no restart)
#
# Note: if package.json changes in the future (new dependencies), a restart
# alone is not enough — run `npm install` first (or ./install.sh).
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ontech7.ollama-rc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
STATE="${STATE_DIR:-$HOME/.ollama-rc}"

# Is the service loaded? (launchctl print fails if it isn't)
is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

status() {
  if is_loaded; then
    echo "● $LABEL active:"
    launchctl print "$DOMAIN/$LABEL" | grep -E 'state =|pid =' | head -2 || true
  else
    echo "○ $LABEL not loaded."
  fi
}

case "${1:-restart}" in
  status)
    status
    ;;
  restart)
    if is_loaded; then
      echo "Restarting $LABEL (kickstart -k)..."
      launchctl kickstart -k "$DOMAIN/$LABEL"
    elif [ -f "$PLIST" ]; then
      echo "$LABEL not loaded: loading the plist."
      launchctl load "$PLIST"
    else
      echo "Plist not found ($PLIST). Run ./install.sh first" >&2
      exit 1
    fi
    echo "---"
    status
    echo "---"
    echo "Last lines of $STATE/logs/daemon.err.log:"
    tail -5 "$STATE/logs/daemon.err.log" 2>/dev/null || echo "(no error log)"
    ;;
  *)
    echo "Usage: $0 [restart|status]" >&2
    exit 1
    ;;
esac
