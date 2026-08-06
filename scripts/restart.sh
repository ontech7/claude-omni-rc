#!/usr/bin/env bash
#
# ollama-rc restart — riavvia il daemon launchd per caricare il codice nuovo.
#
# Dopo una modifica al codice, il processo in esecuzione ha ancora la versione
# vecchia in memoria (tsx carica il sorgente all'avvio): questo script fa un
# restart pulito del servizio senza rifare ./install.sh.
#
# Uso:
#   scripts/restart.sh          riavvia il servizio
#   scripts/restart.sh status   mostra se il servizio è attivo (senza riavviare)
#
# Nota: se in futuro package.json cambia (nuove dipendenze), un restart da solo
# non basta — serve prima `npm install` (o ./install.sh).
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.ontech7.ollama-rc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
STATE="${STATE_DIR:-$HOME/.ollama-rc}"

# Il servizio è caricato? (launchctl print fallisce se non lo è)
is_loaded() {
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1
}

status() {
  if is_loaded; then
    echo "● $LABEL attivo:"
    launchctl print "$DOMAIN/$LABEL" | grep -E 'state =|pid =' | head -2 || true
  else
    echo "○ $LABEL non caricato."
  fi
}

case "${1:-restart}" in
  status)
    status
    ;;
  restart)
    if is_loaded; then
      echo "Riavvio $LABEL (kickstart -k)..."
      launchctl kickstart -k "$DOMAIN/$LABEL"
    elif [ -f "$PLIST" ]; then
      echo "$LABEL non caricato: carico il plist."
      launchctl load "$PLIST"
    else
      echo "Plist non trovata ($PLIST). Esegui prima ./install.sh" >&2
      exit 1
    fi
    echo "---"
    status
    echo "---"
    echo "Ultime righe di $STATE/logs/daemon.err.log:"
    tail -5 "$STATE/logs/daemon.err.log" 2>/dev/null || echo "(nessun log di errore)"
    ;;
  *)
    echo "Uso: $0 [restart|status]" >&2
    exit 1
    ;;
esac
