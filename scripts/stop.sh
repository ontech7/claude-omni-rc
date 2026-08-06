#!/usr/bin/env bash
#
# ollama-rc stop — spegne tutto: daemon launchd, sessioni headless e hook.
#
# Ferma ciò che ./install.sh ha messo in moto:
#   1. il daemon launchd (bootout → KeepAlive non lo riavvia)
#   2. le sessioni claude headless spawnate dal daemon (process group + orfani)
#   3. gli hook Claude Code (SessionStart + PermissionRequest) da settings.json
#
# Le sessioni terminali dell'utente (tmux) NON vengono toccate.
#
# Uso:
#   scripts/stop.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ontech7.ollama-rc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
SETTINGS="$HOME/.claude/settings.json"

have() { command -v "$1" >/dev/null 2>&1; }

# Trova node anche quando non è su PATH (es. nvm non caricato in shell
# non-interattive) e lo mette su PATH per tutto lo script.
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
    echo "Su Linux non c'è launchd: niente da fermare."
    echo "Se il daemon gira in foreground, fermalo con Ctrl+C nel suo terminale."
    exit 0
    ;;
  *)
    echo "Piattaforma non supportata: $(uname -s 2>/dev/null || echo unknown)" >&2
    exit 1
    ;;
esac

# --- 1. daemon launchd ---
DAEMON_PID=""
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  DAEMON_PID="$(launchctl print "$DOMAIN/$LABEL" | awk -F'= ' '/pid =/{print $2; exit}')"
  echo "Fermo il daemon $LABEL (pid ${DAEMON_PID:-?})…"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  echo "  ✓ daemon fermato."
else
  echo "Daemon $LABEL non caricato — niente da fermare."
fi

# --- 2. sessioni headless ---
# Il daemon è il leader del suo process group: i figli headless (claude spawnato
# dall'SDK) condividono quel PGID, le sessioni terminali dell'utente no.
# Nota: pgrep/pkill non vedono l'albero di un job launchd (audit session
# separato su macOS) — si usa kill per PID/gruppo, che funziona.
if [ -n "$DAEMON_PID" ]; then
  echo "Fermo le sessioni headless (process group $DAEMON_PID)…"
  kill -TERM -"$DAEMON_PID" 2>/dev/null || true
  for ((i = 0; i < 20; i++)); do
    kill -0 -"$DAEMON_PID" 2>/dev/null || break
    sleep 0.5
  done
  kill -KILL -"$DAEMON_PID" 2>/dev/null || true
  echo "  ✓ process group terminato."
fi

# Rete di sicurezza: orfani di un daemon crashato in precedenza. ps vede anche
# i processi in audit session separati (pgrep/pkill no). La firma
# --output-format stream-json è unica delle sessioni headless (SDK): le
# sessioni terminali non la hanno. Il [c] evita che lo script matchi se stesso.
ORPHANS="$(ps -axo pid=,command= | awk '/[c]laude.*--output-format stream-json/ {print $1}')"
if [ -n "$ORPHANS" ]; then
  echo "Rimuovo sessioni headless orfane: $ORPHANS"
  kill -TERM $ORPHANS 2>/dev/null || true
  sleep 2
  kill -KILL $ORPHANS 2>/dev/null || true
  echo "  ✓ orfani terminati."
fi

# --- 3. hook Claude Code ---
if have node; then
  echo "Rimuovo gli hook Claude Code da $SETTINGS…"
  node "$REPO/scripts/setup-hook.mjs" --remove "$SETTINGS" "$REPO/scripts/attach.sh" "$REPO/scripts/permission-hook.sh"
else
  echo "node non trovato — rimuovi gli hook manualmente da $SETTINGS." >&2
fi

echo "ollama-rc fermato. Per riavviare: ./scripts/start.sh"
