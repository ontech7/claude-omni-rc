#!/usr/bin/env bash
#
# ollama-rc attach — registers the current Claude Code session with the daemon.
#
# Called by the Claude Code SessionStart hook (installed by ./install.sh), so
# every session auto-attaches to remote control — the closest equivalent to
# Claude Code's native /remote-control. It reads the project dir from the
# working directory and, if running inside tmux, records the tmux session as
# the injection target.
#
# Never fails loudly: if the daemon isn't running, the hook does nothing and
# Claude Code starts normally.
#
set -uo pipefail

PORT="${API_PORT:-4123}"
BASE="http://127.0.0.1:${PORT}"
PROJECT_DIR="$(pwd 2>/dev/null || printf '%s' "${HOME:-}")"
TMUX_TARGET=""
if [ -n "${TMUX:-}" ]; then
  TMUX_TARGET="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

curl -fsS --max-time 5 -X POST "$BASE/api/attach" \
  -H 'content-type: application/json' \
  -d "{\"projectDir\":\"$(json_escape "$PROJECT_DIR")\",\"tmuxTarget\":\"$(json_escape "$TMUX_TARGET")\",\"title\":\"$(json_escape "$(basename "$PROJECT_DIR" 2>/dev/null || echo ollama-rc)")\"}" \
  >/dev/null 2>&1 || true
