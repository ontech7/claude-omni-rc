#!/usr/bin/env bash
#
# ollama-rc PermissionRequest hook — Claude Code la invoca subito prima di
# mostrare un prompt di permesso nelle sessioni interattive. Se il daemon è
# raggiungibile e armato, inoltra la richiesta a Telegram (✓ Approve / ✗ Reject)
# e restituisce la decisione al CLI; altrimenti non emette alcuna decisione e
# Claude Code mostra il normale prompt nel terminale (fail-safe).
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${API_PORT:-4123}"
BASE="http://127.0.0.1:${PORT}"

# Timeout coerente con PERMISSION_TIMEOUT_SECONDS del daemon (default 120).
if [ -z "${PERMISSION_TIMEOUT_SECONDS:-}" ] && [ -f "$REPO_DIR/.env" ]; then
  PERMISSION_TIMEOUT_SECONDS="$(grep -E '^PERMISSION_TIMEOUT_SECONDS=' "$REPO_DIR/.env" | head -n1 | cut -d= -f2)"
fi
PERMISSION_TIMEOUT_SECONDS="${PERMISSION_TIMEOUT_SECONDS:-120}"
MAX_WAIT=$((PERMISSION_TIMEOUT_SECONDS + 5))

# Richiesta del hook (stdin)
BODY="$(cat)"

# Sessione tmux in cui gira il CLI → id sessione per il daemon
SID=""
if [ -n "${TMUX:-}" ]; then
  SID="$(tmux display-message -p '#S' 2>/dev/null || true)"
fi

# Estrae tool_name + tool_input dal JSON del hook (node è richiesto dall'installer).
PAYLOAD="$(SID="$SID" BODY="$BODY" node -e '
const body = (() => { try { return JSON.parse(process.env.BODY || "{}"); } catch { return {}; } })();
const toolName = body.tool_name ?? body.toolName ?? "tool";
const input = body.tool_input ?? body.input ?? {};
console.log(JSON.stringify({ toolName, input, sessionId: process.env.SID || "" }));
' 2>/dev/null)" || exit 0

# Long-poll: resta aperto finché l'utente decide (o scade → deny).
RESP="$(printf '%s' "$PAYLOAD" | curl -fsS --max-time "$MAX_WAIT" -X POST "$BASE/api/permission" \
  -H 'content-type: application/json' -d @- 2>/dev/null)" || exit 0

case "$RESP" in
  allow)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
    ;;
  deny)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Rejected from Telegram"}}}'
    ;;
  *) exit 0 ;; # niente decisione → prompt nativo
esac
