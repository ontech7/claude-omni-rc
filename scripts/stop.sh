#!/usr/bin/env bash
#
# claude-omni-rc stop — shuts everything down: launchd daemon, headless sessions and hooks.
#
# Stops what ./install.sh started:
#   1. the launchd daemon (bootout → KeepAlive won't restart it)
#   2. the headless claude sessions spawned by the daemon (process group + orphans)
#   3. the Claude Code hooks (SessionStart + PermissionRequest) from settings.json
#
# The user's terminal sessions (tmux) are NOT touched.
#
# Usage:
#   scripts/stop.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ontech7.claude-omni-rc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SETTINGS="$HOME/.claude/settings.json"

have() { command -v "$1" >/dev/null 2>&1; }

# Finds node even when it's not on PATH (e.g. nvm not loaded in non-interactive
# shells) and puts it on PATH for the whole script.
find_node() {
  local n
  n="$(command -v node 2>/dev/null || true)"
  [ -n "$n" ] && { echo "$n"; return 0; }
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local v
    v="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
    if [ -n "$v" ] && [ -x "$HOME/.nvm/versions/node/$v/bin/node" ]; then
      echo "$HOME/.nvm/versions/node/$v/bin/node"
      return 0
    fi
  fi
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -n "$NODE_BIN" ]; then
  export PATH="$(dirname "$NODE_BIN"):$PATH"
fi

case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin) ;;
  Linux)
    echo "No launchd on Linux: nothing to stop."
    echo "If the daemon runs in the foreground, stop it with Ctrl+C in its terminal."
    exit 0
    ;;
  *)
    echo "Unsupported platform: $(uname -s 2>/dev/null || echo unknown)" >&2
    exit 1
    ;;
esac

# --- 1. launchd daemon ---
DAEMON_PID=""
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  DAEMON_PID="$(launchctl print "$DOMAIN/$LABEL" | awk -F'= ' '/pid =/{print $2; exit}')"
  echo "Stopping daemon $LABEL (pid ${DAEMON_PID:-?})…"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  echo "  ✓ daemon stopped."
else
  echo "Daemon $LABEL not loaded — nothing to stop."
fi

# --- 2. headless sessions ---
# The daemon is the leader of its process group: the headless children (claude
# spawned by the SDK) share that PGID, the user's terminal sessions don't.
# Note: pgrep/pkill can't see a launchd job's tree (separate audit session on
# macOS) — kill by PID/group is used instead, which works.
if [ -n "$DAEMON_PID" ]; then
  echo "Stopping headless sessions (process group $DAEMON_PID)…"
  kill -TERM -"$DAEMON_PID" 2>/dev/null || true
  for ((i = 0; i < 20; i++)); do
    kill -0 -"$DAEMON_PID" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -"$DAEMON_PID" 2>/dev/null || true
  echo "  ✓ process group terminated."
fi

# Safety net: orphans of a previously crashed daemon. ps also sees processes in
# separate audit sessions (pgrep/pkill don't). The --output-format stream-json
# signature is unique to headless (SDK) sessions: terminal sessions don't have
# it. The [c] prevents the script from matching itself.
ORPHANS="$(ps -axo pid=,command= | awk '/[c]laude.*--output-format stream-json/ {print $1}')"
if [ -n "$ORPHANS" ]; then
  echo "Removing orphaned headless sessions: $ORPHANS"
  kill -TERM $ORPHANS 2>/dev/null || true
  sleep 2
  kill -KILL $ORPHANS 2>/dev/null || true
  echo "  ✓ orphans terminated."
fi

# --- 3. Claude Code hooks ---
if have node; then
  echo "Removing Claude Code hooks from $SETTINGS…"
  node "$REPO/scripts/setup-hook.mjs" --remove "$SETTINGS" "$REPO/scripts/attach.sh" "$REPO/scripts/permission-hook.sh"
else
  echo "node not found — remove the hooks manually from $SETTINGS." >&2
fi

echo "claude-omni-rc stopped. To restart: ./scripts/start.sh"
