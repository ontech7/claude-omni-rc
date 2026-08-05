# Changelog

## [Unreleased]

- **SessionStart hook + local API** — `./install.sh` now adds a Claude Code
  `SessionStart` hook (`scripts/attach.sh`) that auto-attaches every session
  on start via a new loopback HTTP API (`src/api.ts`, `API_PORT`, default
  4123): project dir from cwd, tmux target auto-detected. The closest
  equivalent to Claude Code's native `/remote-control`. Idempotent; silent
  when the daemon is down.
- **Session discovery** — the daemon now surfaces *every* session with recent
  activity in `~/.claude/projects`, not only tmux `claude:*` ones, so
  `/sessions` always reflects what's running. tmux `claude:*` sessions stay
  fully controllable (mirror + inject); other sessions are read-only mirrors.
  Pre-existing history is consumed silently on attach — no replay flood on the
  bot, only activity from that point on.
- **Voice transcription reworked** — whisper was removed from the Ollama
  registry, so transcription now goes through `/api/chat` with base64 audio
  and `think: false`. The config key is now `TRANSCRIBE_MODEL` (default
  `gemma4:cloud` — no audio capability; set it to a local model like
  `gemma4:e2b` for voice). The bot pre-checks the model's audio capability
  and explains what to set. `install.sh` migrates a stale `WHISPER_MODEL`
  in an existing `.env`.
- **Bot in English** — all user-facing bot messages are now English (the bot
  was previously Italian).
- **Command menu** — the bot registers `/rc`, `/sessions`, `/new`, `/stop`,
  `/status`, `/attach`, `/help` via `setMyCommands`, so Telegram suggests them
  when you type `/`.
- **Injection guard** — the bot explains that a non-tmux terminal session
  can't receive injected text (with the `tmux new -s claude:<project>` hint).

## [0.1.0] - 2026-08-05

Initial release — Phase 1 MVP: local daemon + Telegram bot that mimics Claude
Code's `/remote-control` for Ollama-served models, without Anthropic
infrastructure.

- **Daemon** (Node 22 + tsx) with a typed internal event bus and a persistent
  registry (`~/.ollama-rc/state.json`) holding the global `armed` switch and
  the session list.
- **Headless sessions** driven via the Claude Agent SDK (`query` + `resume`,
  `canUseTool`), pinned at `0.3.221`; session ids persist across restarts.
- **Terminal sessions** mirrored read-only from the Claude project JSONL files
  and injected into via tmux with bracketed paste, gated on the `armed` switch;
  per-file offsets persist across restarts.
- **Remote permissions** — SDK `canUseTool` requests surface in Telegram as
  `✓ Approve` / `✗ Reject` buttons; unanswered requests time out into a deny
  (`PERMISSION_TIMEOUT_SECONDS`).
- **Media** — voice notes transcribed with Ollama's whisper model (ffmpeg
  conversion); files saved to `~/.ollama-rc/inbox/` and forwarded as a path
  reference the model can read via its extra directories.
- **Security** — default-deny pairing (`ALLOWED_USER_IDS` or `PAIRING_CODE`);
  while disarmed the bot answers only `/rc`, `/help`, `/start`.
- **launchd agent** (`com.ontech7.ollama-rc`) with install script and template.
- **Guided installer** (`./install.sh`) that walks a non-expert through
  prerequisites, bot token, authorization, models and the daemon registration.
- **Docs & landing** — English README, `AI-GUIDE.md` (AI-agent setup matrix),
  landing page (`index.html`), CHANGELOG, MIT LICENSE, GitHub Pages `.nojekyll`
  and a CI workflow (`npm ci` → typecheck → vitest).
