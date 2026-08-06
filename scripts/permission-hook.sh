#!/usr/bin/env bash
#
# claude-omni-rc PermissionRequest hook — Claude Code invokes it right before
# showing a permission prompt in interactive sessions. If the daemon is
# reachable and armed, it forwards the request to Telegram (✓ Approve / ✗ Reject)
# and returns the decision to the CLI; otherwise it emits no decision and
# Claude Code shows the normal terminal prompt (fail-safe).
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${API_PORT:-4123}"
BASE="http://127.0.0.1:${PORT}"

# Timeout consistent with the daemon's PERMISSION_TIMEOUT_SECONDS (default 120).
if [ -z "${PERMISSION_TIMEOUT_SECONDS:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  PERMISSION_TIMEOUT_SECONDS="$(grep -E '^PERMISSION_TIMEOUT_SECONDS=' "$REPO_DIR/.env" | head -n1 | cut -d= -f2)"
fi
PERMISSION_TIMEOUT_SECONDS="${PERMISSION_TIMEOUT_SECONDS:-120}"
MAX_WAIT=$((PERMISSION_TIMEOUT_SECONDS + 5))

# Hook request (stdin)
BODY="$(cat)"

# tmux session the CLI runs in → session id for the daemon
SID=""
if [ -n "${TMUX:-}" ]; then
  SID="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi

# Extracts tool_name + tool_input from the hook JSON (node is required by the installer).
PAYLOAD="$(SID="$SID" BODY="$BODY" node -e '
const body = (() => { try { return JSON.parse(process.env.BODY || "{}"); } catch { return {}; } })();
const toolName = body.tool_name ?? body.toolName ?? "tool";
const input = body.tool_input ?? body.input ?? {};
console.log(JSON.stringify({ toolName, input, sessionId: process.env.SID || "" }));
' 2>/dev/null)" || exit 0

# Long-poll: stays open until the user decides (or times out → deny).
RESP="$(printf '%s' "$PAYLOAD" | curl -fsS --max-time "$MAX_WAIT" -X POST "$BASE/api/permission" \
  -H 'content-type: application/json' -d @- 2>/dev/null)" || exit 0

case "$RESP" in
  allow)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    ;;
  deny)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Rejected from Telegram"}}}'
    ;;
  *) exit 0 ;; # no decision → native prompt
esac
