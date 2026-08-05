#!/usr/bin/env bash
#
# ollama-rc — guided installer
#
#   git clone https://github.com/ontech7/ollama-rc
#   cd ollama-rc
#   ./install.sh
#
# Walks you through everything a non-expert needs to get the daemon running:
# prerequisites, npm dependencies, your Telegram bot token, the Ollama models
# and (on macOS) the background daemon. You only answer a few prompts; the
# script never overwrites values you already set in .env.
#
# When stdin is not a terminal (piped / CI) the script skips the interactive
# prompts and just does the non-interactive steps.
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$REPO_DIR/.env"
ENV_EXAMPLE="$REPO_DIR/.env.example"
STATE_DIR="${STATE_DIR:-$HOME/.ollama-rc}"
DEFAULT_OLLAMA_URL="http://127.0.0.1:11434"
DEFAULT_MODEL_FALLBACK="deepseek-v4-flash:0731-cloud"
TRANSCRIBE_MODEL_FALLBACK="gemma4:cloud"

if [ -t 1 ]; then
  c_reset='\033[0m'; c_bold='\033[1m'; c_green='\033[32m'
  c_yellow='\033[33m'; c_red='\033[31m'; c_cyan='\033[36m'
else
  c_reset=''; c_bold=''; c_green=''; c_yellow=''; c_red=''; c_cyan=''
fi

info() { printf '%b\n' "${c_cyan}==>${c_reset} $*"; }
ok()   { printf '%b\n' "${c_green}==>${c_reset} $*"; }
warn() { printf '%b\n' "${c_yellow}==>${c_reset} $*"; }
err()  { printf '%b\n' "${c_red}==>${c_reset} $*" >&2; }

[ -t 0 ] && INTERACTIVE=1 || INTERACTIVE=0

have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<EOF
ollama-rc installer

Usage: ./install.sh [--help]

Guided installer for the ollama-rc daemon + Telegram bot.
It checks prerequisites, installs npm dependencies, helps you configure
.env (bot token + authorization), pulls the Ollama models, registers the
background daemon (launchd) and adds the Claude Code SessionStart hook so
every session auto-attaches to remote control.

Environment:
  STATE_DIR   where state and logs live (default: ~/.ollama-rc)
EOF
}

# set_env KEY VALUE — set or update one line in .env, never duplicates
set_env() {
  local key="$1" val="$2" esc
  esc="$(printf '%s' "$val" | sed 's/\\/\\\\/g; s/&/\\&/g; s/|/\\|/g')"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i.bak -E "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

get_env() {
  grep "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-
}

check_platform() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Darwin|Linux) ;;
    *)
      err "Unsupported platform: $(uname -s 2>/dev/null || echo unknown)"
      err "ollama-rc targets macOS (launchd) and Linux."
      exit 1
      ;;
  esac
}

check_node() {
  if ! have node; then
    err "Node.js is required but not installed."
    echo "  macOS:  brew install node"
    echo "  Linux:  install the LTS from https://nodejs.org"
    echo "  Then run this installer again."
    exit 1
  fi
  local major
  major="$(node -v 2>/dev/null | sed 's/^v//; s/\..*$//')"
  if [ "${major:-0}" -lt 22 ]; then
    err "Node 22+ is required (you have $(node -v 2>/dev/null)). Upgrade and re-run."
    exit 1
  fi
  ok "Node $(node -v 2>/dev/null) found."
}

check_optional_tools() {
  # tmux is only needed for terminal-session mirroring/injection;
  # ffmpeg only for voice-note transcription. Missing → warn, keep going.
  if ! have tmux; then
    warn "tmux is not installed. Terminal sessions (mirror + /attach) will be unavailable."
    echo "  Install it with:  brew install tmux   (or:  apt install tmux)"
  else
    ok "tmux found."
  fi
  if ! have ffmpeg; then
    warn "ffmpeg is not installed. Voice-note transcription will be unavailable."
    echo "  Install it with:  brew install ffmpeg   (or:  apt install ffmpeg)"
  else
    ok "ffmpeg found."
  fi
}

check_ollama() {
  local base="${OLLAMA_BASE_URL:-$DEFAULT_OLLAMA_URL}"
  if ! have ollama; then
    warn "Ollama is not installed. It must be running for anything to work."
    echo "  Install it from https://ollama.com/download and start it."
    return
  fi
  if curl -fsS "$base/api/version" >/dev/null 2>&1; then
    ok "Ollama is running ($base)."
  else
    warn "Ollama is installed but not reachable at $base. Start it (the Ollama app) and re-run this script."
  fi
}

install_deps() {
  info "Installing npm dependencies (first run takes a minute)…"
  ( cd "$REPO_DIR" && npm install ) || { err "npm install failed."; exit 1; }
  ok "Dependencies installed."
}

prepare_env() {
  [ -f "$ENV_FILE" ] || { cp "$ENV_EXAMPLE" "$ENV_FILE" && ok "Created .env from .env.example."; }

  # Migrazione: whisper è stato rimosso dal registry di Ollama (2026). Un .env
  # esistente può ancora avere WHISPER_MODEL (es. l'invalido "whisper-large-v3") →
  # lo converte in TRANSCRIBE_MODEL e rimuove la chiave vecchia.
  local old_wm cur_wm
  old_wm="$(get_env WHISPER_MODEL)"
  if [ -n "$old_wm" ]; then
    cur_wm="$(get_env TRANSCRIBE_MODEL)"
    if [ -z "$cur_wm" ]; then
      if [ "$old_wm" = "whisper-large-v3" ] || [ "$old_wm" = "whisper:large-v3" ]; then
        set_env TRANSCRIBE_MODEL "$TRANSCRIBE_MODEL_FALLBACK"
        warn "Migrated WHISPER_MODEL ($old_wm, removed from Ollama) → TRANSCRIBE_MODEL=$TRANSCRIBE_MODEL_FALLBACK"
      else
        set_env TRANSCRIBE_MODEL "$old_wm"
        ok "Migrated WHISPER_MODEL → TRANSCRIBE_MODEL=$old_wm"
      fi
    fi
    sed -i.bak -E '/^WHISPER_MODEL=/d' "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  fi

  local token ids pair
  token="$(get_env TELEGRAM_BOT_TOKEN)"
  ids="$(get_env ALLOWED_USER_IDS)"
  pair="$(get_env PAIRING_CODE)"

  if [ -n "$token" ]; then
    ok "TELEGRAM_BOT_TOKEN already set."
  elif [ "$INTERACTIVE" -eq 0 ]; then
    warn "TELEGRAM_BOT_TOKEN not set — edit $ENV_FILE manually and re-run (see README)."
  else
    info "Let's create your Telegram bot token."
    echo " 1. Open Telegram and message @BotFather:  https://t.me/BotFather"
    echo " 2. Send  /newbot  and follow the prompts (pick any name and username)"
    echo " 3. Copy the token BotFather sends (it looks like  123456789:AA…)"
    local n=0
    while [ -z "$token" ] && [ "$n" -lt 3 ]; do
      printf '%b' "${c_bold}Bot token${c_reset} (or press Enter to skip for now): "
      read -r token
      token="$(printf '%s' "$token" | tr -d '[:space:]')"
      n=$((n + 1))
    done
    if [ -n "$token" ]; then
      set_env TELEGRAM_BOT_TOKEN "$token"
      ok "TELEGRAM_BOT_TOKEN saved to .env."
    else
      warn "Skipped — you can edit $ENV_FILE later and re-run ./install.sh."
    fi
  fi

  if [ -n "$ids" ] || [ -n "$pair" ]; then
    ok "Authorization already configured (ALLOWED_USER_IDS / PAIRING_CODE)."
    return
  fi
  [ "$INTERACTIVE" -eq 0 ] && { warn "No authorization configured yet — set ALLOWED_USER_IDS or PAIRING_CODE in $ENV_FILE."; return; }

  info "Who is allowed to control this? Pick one."
  echo "  • Your own Telegram user id (recommended, easiest) — find it by messaging @userinfobot"
  echo "  • A pairing code you send to the bot as  /start <code>  (works from any account that knows the code)"
  printf '%b' "${c_bold}Telegram user id${c_reset} (or press Enter to use a pairing code instead): "
  read -r ids
  ids="$(printf '%s' "$ids" | tr -d '[:space:]')"
  if [ -n "$ids" ]; then
    if [ "$ids" -eq "$ids" ] 2>/dev/null; then
      set_env ALLOWED_USER_IDS "$ids"
      ok "ALLOWED_USER_IDS set to $ids."
      return
    fi
    warn "\"$ids\" doesn't look like a numeric id — falling back to a pairing code."
  fi
  printf '%b' "${c_bold}Pairing code${c_reset} (press Enter to auto-generate one): "
  read -r pair
  pair="$(printf '%s' "$pair" | tr -d '[:space:]')"
  [ -n "$pair" ] || pair="$(LC_ALL=C tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c 8)"
  set_env PAIRING_CODE "$pair"
  ok "PAIRING_CODE saved. From Telegram, send:  /start $pair"
}

ensure_model() {
  local name="$1" note="$2"
  [ -n "$name" ] || return
  if ! have ollama; then return; fi
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$name"; then
    ok "Model $name already present."
    return
  fi
  [ "$INTERACTIVE" -eq 0 ] && { warn "Model $name missing — run  ollama pull $name  when ready."; return; }
  printf '%b' "Download model ${c_bold}$name${c_reset} ($note)? [y/N]: "
  read -r ans
  case "${ans:-N}" in
    y|Y|yes|Yes)
      info "Pulling $name (large download)…"
      ollama pull "$name" || warn "Pull failed — retry later with:  ollama pull $name"
      ;;
    *) warn "Skipped. Pull later with:  ollama pull $name" ;;
  esac
}

install_service() {
  case "$(uname -s)" in
    Darwin)
      if [ -x "$REPO_DIR/scripts/install-launchd.sh" ]; then
        info "Registering the background daemon (launchd)…"
        if STATE_DIR="$STATE_DIR" "$REPO_DIR/scripts/install-launchd.sh"; then
          ok "Daemon registered — it now runs and will restart automatically."
        else
          warn "launchd setup failed — you can still run  npm run dev  to test in the foreground."
        fi
      fi
      ;;
    Linux)
      info "On Linux there is no launchd; run the daemon in the foreground for now:"
      echo "    cd $REPO_DIR && npm run dev"
      ;;
  esac
}

# Claude Code SessionStart hook: ogni sessione che parte si auto-aggancia al
# remote control (analogo del /remote-control nativo). Il merge preserva tutto
# ciò che è già in ~/.claude/settings.json ed è idempotente.
install_hook() {
  if ! have node; then return; fi
  info "Adding the Claude Code SessionStart hook (auto-attach)…"
  if node "$REPO_DIR/scripts/setup-hook.mjs" "$HOME/.claude/settings.json" "$REPO_DIR/scripts/attach.sh"; then
    ok "SessionStart hook installed."
  else
    warn "Hook install failed — add it manually (see README → \"Auto-attach\")."
  fi
}

print_summary() {
  cat <<EOF

${c_bold}ollama-rc is installed. Next steps:${c_reset}
  1. Open the chat with your bot on Telegram.
     • If you set a pairing code, send:        /start <pairing code>
     • If you allowlisted your user id, any message works.
  2. Arm remote control:                       /rc on
  3. Try it:
     /new write a haiku            — headless session
     /sessions                     — list and switch sessions
     /attach <project>             — attach a tmux terminal session
     /help                         — all commands

  The SessionStart hook auto-attaches every Claude Code session you start,
  including the one you're in right now — restart it (or run  claude  again)
  and it will show up in /sessions.

  Logs:   $STATE_DIR/logs/daemon.log
  Docs:   https://github.com/ontech7/ollama-rc#readme
  Your $ENV_FILE holds secrets — keep it private, never commit it.
EOF
}

main() {
  case "${1:-}" in
    --help|-h) usage; exit 0 ;;
    --) ;;
    "") ;;
    *) err "Unknown option: $1"; usage; exit 1 ;;
  esac

  printf '%b\n' "${c_bold}ollama-rc — remote control for Claude Code, via Telegram${c_reset}"
  check_platform
  check_node
  check_optional_tools
  check_ollama
  install_deps
  prepare_env
  local default_model transcribe_model
  default_model="$(get_env DEFAULT_MODEL)"; [ -n "$default_model" ] || default_model="$DEFAULT_MODEL_FALLBACK"
  transcribe_model="$(get_env TRANSCRIBE_MODEL)"; [ -n "$transcribe_model" ] || transcribe_model="$TRANSCRIBE_MODEL_FALLBACK"
  ensure_model "$default_model" "used for headless sessions"
  if [ "$transcribe_model" != "gemma4:cloud" ]; then
    ensure_model "$transcribe_model" "used to transcribe voice notes (audio-capable)"
  else
    info "TRANSCRIBE_MODEL=$transcribe_model (cloud). Note: gemma4:cloud has no audio — voice notes need a local audio model (gemma4:e2b)."
  fi
  install_service
  install_hook
  print_summary
}

main "$@"
