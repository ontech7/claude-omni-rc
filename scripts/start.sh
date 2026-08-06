#!/usr/bin/env bash
#
# ollama-rc start — controlla che tutto sia installato e avvia il daemon.
#
# Se manca qualcosa (node, dipendenze, .env, servizio launchd, hook Claude
# Code) richiama ./install.sh; altrimenti avvia direttamente il daemon.
#
# Uso:
#   scripts/start.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ontech7.ollama-rc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
ENV_FILE="$REPO/.env"
SETTINGS="$HOME/.claude/settings.json"
API_PORT="${API_PORT:-4123}"

have() { command -v "$1" >/dev/null 2>&1; }

# Trova node anche quando non è su PATH (es. nvm non caricato in shell
# non-interattive) e lo mette su PATH per tutto lo script (serve anche a
# ./install.sh quando viene richiamato qui sotto).
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
    echo "Su Linux non c'è launchd: avvia il daemon in foreground con:"
    echo "    cd $REPO && npm run dev"
    exit 0
    ;;
  *)
    echo "Piattaforma non supportata: $(uname -s 2>/dev/null || echo unknown)" >&2
    exit 1
    ;;
esac

# --- 1. controllo "installato tutto" ---
missing=0
note() { printf '  %s %s\n' "$1" "$2"; }

check_node() {
  if ! have node; then note '✗' 'Node.js non trovato'; return 1; fi
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*$//')"
  if [ "${major:-0}" -lt 22 ]; then
    note '✗' "Node 22+ richiesto (hai $(node -v 2>/dev/null))"
    return 1
  fi
  note '✓' "Node $(node -v 2>/dev/null)"
}

check_deps() {
  if [ -d "$REPO/node_modules" ]; then note '✓' 'Dipendenze npm (node_modules)'; else note '✗' 'Dipendenze npm mancanti'; return 1; fi
}

check_env() {
  if [ ! -f "$ENV_FILE" ]; then note '✗' '.env mancante'; return 1; fi
  if grep -q '^TELEGRAM_BOT_TOKEN=.' "$ENV_FILE" && { grep -q '^ALLOWED_USER_IDS=.' "$ENV_FILE" || grep -q '^PAIRING_CODE=.' "$ENV_FILE"; }; then
    note '✓' '.env configurato (token + autorizzazione)'
  else
    note '✗' '.env non configurato (manca TELEGRAM_BOT_TOKEN o autorizzazione)'
    return 1
  fi
}

check_service() {
  if [ -f "$PLIST" ]; then note '✓' 'Servizio launchd installato'; else note '✗' 'Servizio launchd mancante'; return 1; fi
}

check_hooks() {
  if [ -f "$SETTINGS" ] && grep -qF "$REPO/scripts/attach.sh" "$SETTINGS" && grep -qF "$REPO/scripts/permission-hook.sh" "$SETTINGS"; then
    note '✓' 'Hook Claude Code installati'
  else
    note '✗' 'Hook Claude Code mancanti'
    return 1
  fi
}

check_model() {
  if ! have ollama; then
    note '⚠' 'Ollama non installato — il daemon parte ma le sessioni headless falliranno'
    return 0
  fi
  local model
  model="$(grep '^DEFAULT_MODEL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
  [ -n "$model" ] || model='deepseek-v4-flash:0731-cloud'
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
    note '✓' "Modello Ollama $model presente"
  else
    note '⚠' "Modello $model mancante — esegui: ollama pull $model"
  fi
}

echo "Controllo installazione ollama-rc…"
check_node || missing=1
check_deps || missing=1
check_env || missing=1
check_service || missing=1
check_hooks || missing=1
check_model

if [ "$missing" -eq 1 ]; then
  echo
  echo "==> Configurazione incompleta: eseguo ./install.sh"
  "$REPO/install.sh"
fi

# --- 2. avvio del daemon ---
is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

if is_loaded; then
  echo "● $LABEL già attivo."
elif [ -f "$PLIST" ]; then
  echo "Avvio $LABEL…"
  launchctl load "$PLIST"
else
  echo "Plist non trovata ($PLIST) — esegui ./install.sh" >&2
  exit 1
fi

# --- 3. readiness check ---
printf 'Attendo che il daemon risponda'
ok=0
for ((i = 0; i < 10; i++)); do
  if curl -fsS --max-time 1 "http://127.0.0.1:${API_PORT}/api/sessions" >/dev/null 2>&1; then ok=1; break; fi
  printf '.'
  sleep 0.5
done
echo
if [ "$ok" -eq 1 ]; then
  echo "● ollama-rc attivo su http://127.0.0.1:${API_PORT}"
else
  echo "⚠  Il daemon non risponde ancora. Ultime righe di ~/.ollama-rc/logs/daemon.err.log:" >&2
  tail -5 "$HOME/.ollama-rc/logs/daemon.err.log" 2>/dev/null || true
  exit 1
fi
