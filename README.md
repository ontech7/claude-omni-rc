# ollama-rc

Remote control per Claude Code servito da Ollama: daemon locale + bot Telegram.
Mima `/remote-control` di Claude Code senza infrastruttura Anthropic.

## Prerequisiti
- Node 22, Ollama attivo, `tmux` (`brew install tmux`), `ffmpeg` (`brew install ffmpeg`)
- Modelli: `ollama pull deepseek-v4-flash:0731-cloud` (default) e `ollama pull whisper-large-v3` (voce)

## Setup
1. `cp .env.example .env` e compila i segreti (token da @BotFather, ALLOWED_USER_IDS o PAIRING_CODE)
2. `npm install`
3. `./scripts/install-launchd.sh`  (o `npm run dev` per il primo test in foreground)

## Uso
- Sessioni interattive: `tmux new -s claude:<progetto>` → dentro, `claude`
- Da Telegram: `/rc on` armare · `/sessions` · `/new <testo>` · `/attach <progetto>` · `/stop` · `/status`
- Da disattivo il bot risponde solo a `/rc`, `/help`, `/start`
- Permessi headless: bottoni `✓ Approva` / `✗ Rifiuta` direttamente in chat
- Media: foto/voci/file salvati in `~/.ollama-rc/inbox/`; le immagini viaggiano come
  *riferimento al path* (il modello headless le legge via `additionalDirectories`) — non
  come blocco immagine nel prompt (limite dell'SDK query testuale). Voci trascritte via whisper.

## Architettura
Daemon (Node 22 + tsx) → bus eventi → bot grammy (long-polling).
Sessione headless = SDK 0.3.221 (`query`+`resume`, `canUseTool`); sessione terminale =
mirror dei JSONL `~/.claude/projects` (read-only) + iniezione tmux con bracketed paste.
Stato (`armed`, sessioni, offset) in `~/.ollama-rc/state.json`. Vedi `docs/superpowers/specs/`.

> Nota log: i log del daemon (`~/.ollama-rc/logs/daemon.log`) sono file plain senza rotazione
> automatica — la rotazione è demandata all'OS (newsyslog) o all'utente. Segnalato come
> follow-up rispetto alla spec §14.
