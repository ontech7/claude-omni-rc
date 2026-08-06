#!/usr/bin/env bash
#
# omni-rc — start a Claude Code session inside tmux, ready for remote control.
#
#   omni-rc <name> [options]
#
# Creates (or reattaches to) a tmux session named `claude:<name>` running
# Claude Code, so the claude-omni-rc daemon can mirror it, inject input and
# capture its screen. If the session already exists, omni-rc just attaches.
#
# Options:
#   -c, --cwd <dir>     start in this directory (default: current)
#   -m, --model <model> pass --model <model> to claude
#   -p, --prompt <text> send <text> as the first message
#   -d, --detach        create the session but don't attach to it
#   -k, --kill          kill the claude:<name> session instead of starting it
#   -l, --list          list all claude:* tmux sessions and exit
#   -h, --help          show this help
#   --                  everything after is passed to claude verbatim
#
# Examples:
#   omni-rc myproject
#   omni-rc myproject -c ~/code/myproject -m deepseek-v4-flash:0731-cloud
#   omni-rc myproject -p "review the current diff"
#   omni-rc -l
#
set -uo pipefail

usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
  exit 0
}

# --- parse options ---------------------------------------------------------
CWD=""
MODEL=""
PROMPT=""
DETACH=0
KILL=0
LIST=0
CLAUDE_ARGS=()
NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    -l|--list) LIST=1; shift ;;
    -k|--kill) KILL=1; shift ;;
    -d|--detach) DETACH=1; shift ;;
    -c|--cwd) CWD="${2:-}"; shift 2 ;;
    -m|--model) MODEL="${2:-}"; shift 2 ;;
    -p|--prompt) PROMPT="${2:-}"; shift 2 ;;
    --) shift; CLAUDE_ARGS+=("$@"); break ;;
    -*) echo "omni-rc: unknown option: $1" >&2; usage ;;
    *) NAME="$1"; shift ;;
  esac
done

if [ "$LIST" -eq 1 ]; then
  if command -v tmux >/dev/null 2>&1; then
    tmux ls -F '#{session_name}' 2>/dev/null | grep '^claude:' || echo "No claude:* sessions."
  else
    echo "tmux is not installed."
  fi
  exit 0
fi

if [ -z "$NAME" ]; then
  echo "omni-rc: missing session name" >&2
  usage
fi

# tmux session names can't contain ':' and a name with spaces is asking for trouble
case "$NAME" in
  *:*|*' '*|'') echo "omni-rc: invalid session name '$NAME' (no spaces or colons)" >&2; exit 1 ;;
esac

if ! command -v tmux >/dev/null 2>&1; then
  echo "omni-rc: tmux is not installed" >&2
  exit 1
fi

SESSION="claude:$NAME"

# tmux reads `claude:<name>` as session:window, so a colon-named session can't
# be targeted by name. Resolve it to its session id (`$0`…) — unique and stable.
resolve_target() {
  tmux list-sessions -F '#{session_id} #{session_name}' 2>/dev/null | awk -v want="$1" '$2 == want { print $1; exit }'
}

TARGET="$(resolve_target "$SESSION")"

if [ "$KILL" -eq 1 ]; then
  if [ -n "$TARGET" ]; then
    tmux kill-session -t "$TARGET"
    echo "Killed $SESSION."
  else
    echo "No session $SESSION."
  fi
  exit 0
fi

# already running → just attach (or report when detached)
if [ -n "$TARGET" ]; then
  if [ "$DETACH" -eq 1 ]; then
    echo "$SESSION is already running."
    exit 0
  fi
  echo "Attaching to existing $SESSION…"
  exec tmux attach-session -t "$TARGET"
fi

# build the claude command
CLAUDE_CMD=(claude)
[ -n "$MODEL" ] && CLAUDE_CMD+=(--model "$MODEL")
[ "${#CLAUDE_ARGS[@]}" -gt 0 ] && CLAUDE_CMD+=("${CLAUDE_ARGS[@]}")

CWD="${CWD:-$PWD}"
if [ ! -d "$CWD" ]; then
  echo "omni-rc: directory not found: $CWD" >&2
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "omni-rc: 'claude' not found on PATH — the session will start but Claude Code won't." >&2
fi

if ! tmux new-session -d -s "$SESSION" -c "$CWD" "${CLAUDE_CMD[@]}"; then
  echo "omni-rc: failed to create $SESSION" >&2
  exit 1
fi
TARGET="$(resolve_target "$SESSION")"

if [ -n "$PROMPT" ] && [ -n "$TARGET" ]; then
  # let claude boot, then send the prompt as the first message
  ( sleep 2; tmux send-keys -t "$TARGET" "$PROMPT" Enter ) &
fi

echo "Started $SESSION in $CWD."
if [ "$DETACH" -eq 1 ]; then
  echo "Detached — attach later with: omni-rc $NAME"
else
  exec tmux attach-session -t "$TARGET"
fi
