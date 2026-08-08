#!/usr/bin/env bash
#
# claude-omni-rc start — checks that everything is installed and starts the daemon.
#
# If something is missing (node, dependencies, .env, launchd service, Claude
# Code hooks) it calls ./install.sh; otherwise it starts the daemon directly.
#
# Usage:
#   scripts/start.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ontech7.claude-omni-rc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
ENV_FILE="$REPO/.env"
SETTINGS="$HOME/.claude/settings.json"
API_PORT="${API_PORT:-4123}"

have() { command -v "$1" >/dev/null 2>&1; }

# Finds node even when it's not on PATH (e.g. nvm not loaded in non-interactive
# shells) and puts it on PATH for the whole script (also needed by
# ./install.sh when it's called below).
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
    echo "No launchd on Linux: start the daemon in the foreground with:"
    echo "    cd $REPO && npm run dev"
    exit 0
    ;;
  *)
    echo "Unsupported platform: $(uname -s 2>/dev/null || echo unknown)" >&2
    exit 1
    ;;
esac

# --- 1. "everything installed" check ---
missing=0
note() { printf '  %s %s\n' "$1" "$2"; }

check_node() {
  if ! have node; then note '✗' 'Node.js not found'; return 1; fi
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*$//')"
  if [ "${major:-0}" -lt 22 ]; then
    note '✗' "Node 22+ required (you have $(node -v 2>/dev/null))"
    return 1
  fi
  note '✓' "Node $(node -v 2>/dev/null)"
}

check_deps() {
  if [ -d "$REPO/node_modules" ]; then note '✓' 'npm dependencies (node_modules)'; else note '✗' 'npm dependencies missing'; return 1; fi
}

check_env() {
  if [ ! -f "$ENV_FILE" ]; then note '✗' '.env missing'; return 1; fi
  if grep -q '^TELEGRAM_BOT_TOKEN=.' "$ENV_FILE" && { grep -q '^ALLOWED_USER_IDS=.' "$ENV_FILE" || grep -q '^PAIRING_CODE=.' "$ENV_FILE"; }; then
    note '✓' '.env configured (token + authorization)'
  else
    note '✗' '.env not configured (missing TELEGRAM_BOT_TOKEN or authorization)'
    return 1
  fi
}

check_service() {
  if [ -f "$PLIST" ]; then note '✓' 'launchd service installed'; else note '✗' 'launchd service missing'; return 1; fi
}

check_hooks() {
  if [ -f "$SETTINGS" ] && grep -qF "$REPO/scripts/attach.sh" "$SETTINGS" && grep -qF "$REPO/scripts/permission-hook.sh" "$SETTINGS"; then
    note '✓' 'Claude Code hooks installed'
  else
    note '✗' 'Claude Code hooks missing'
    return 1
  fi
}

check_model() {
  if ! have ollama; then
    note '⚠' 'Ollama not installed — the daemon starts but headless sessions will fail'
    return 0
  fi
  local model
  model="$(grep '^DEFAULT_MODEL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  [ -n "$model" ] || model='deepseek-v4-flash:cloud'
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
    note '✓' "Ollama model $model present"
  else
    note '⚠' "Model $model missing — run: ollama pull $model"
  fi
}

echo "Checking claude-omni-rc installation…"
check_node || missing=1
check_deps || missing=1
check_env || missing=1
check_service || missing=1
check_hooks || missing=1
check_model

if [ "$missing" -eq 1 ]; then
  echo
  echo "==> Incomplete configuration: running ./install.sh"
  "$REPO/install.sh"
fi

# --- 2. start the daemon ---
is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

if is_loaded; then
  echo "● $LABEL already active."
elif [ -f "$PLIST" ]; then
  echo "Starting $LABEL…"
  launchctl load "$PLIST"
else
  echo "Plist not found ($PLIST) — run ./install.sh" >&2
  exit 1
fi

# --- 3. readiness check ---
printf 'Waiting for the daemon to respond'
ok=0
for ((i = 0; i < 10; i++)); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${API_PORT}/api/sessions" >/dev/null 2>&1; then ok=1; break; fi
  printf '.'
  sleep 0.5
done
echo
if [ "$ok" -eq 1 ]; then
  echo "● claude-omni-rc active at http://127.0.0.1:${API_PORT}"
else
  echo "⚠  The daemon is not responding yet. Last lines of ~/.claude-omni-rc/logs/daemon.err.log:" >&2
  tail -5 "$HOME/.claude-omni-rc/logs/daemon.err.log" 2>/dev/null || true
  exit 1
fi
