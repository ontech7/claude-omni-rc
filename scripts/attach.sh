#!/usr/bin/env bash
#
# claude-omni-rc attach — registers the current Claude Code session with the daemon.
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
# Only Ollama sessions are registered: without ANTHROPIC_BASE_URL (or with
# Anthropic's) the session isn't served by our daemon and isn't relevant.
#
# When the session is NOT inside tmux but the daemon is running, the hook emits
# a systemMessage (JSON on stdout) reminding the user to start it with
# `omni-rc <name>` instead — a session outside tmux can be mirrored read-only
# from Telegram but can't receive input or be captured with /view.
#
set -uo pipefail

case "${ANTHROPIC_BASE_URL:-}" in
  '') exit 0 ;;
  *anthropic.com*) exit 0 ;;
esac

PORT="${API_PORT:-4123}"
BASE="http://127.0.0.1:${PORT}"
PROJECT_DIR="$(pwd 2>/dev/null || printf '%s' "${HOME:-}")"
TMUX_TARGET=""
if [ -n "${TMUX:-}" ]; then
  TMUX_TARGET="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if curl -fsS --max-time 5 -X POST "$BASE/api/attach" \
  -H 'content-type: application/json' \
  -d "{\"projectDir\":\"$(json_escape "$PROJECT_DIR")\",\"tmuxTarget\":\"$(json_escape "$TMUX_TARGET")\",\"title\":\"$(json_escape "$(basename "$PROJECT_DIR" 2>/dev/null || echo claude-omni-rc)")\"}" \
  >/dev/null 2>&1; then
  # daemon is up: if this session isn't inside tmux, remind the user that
  # remote control can inject input and capture the screen only from tmux.
  if [ -z "$TMUX_TARGET" ]; then
    NAME="$(basename "$PROJECT_DIR" 2>/dev/null || echo session)"
    printf '{"systemMessage":"⚠️ omni-rc: this session is not inside tmux. If you plan to use remote control from your phone, restart it with: omni-rc %s"}\n' "$(json_escape "$NAME")"
  fi
fi
