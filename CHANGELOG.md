# Changelog

## [Unreleased]

- **SessionStart hook + local API** — `./install.sh` adds a Claude Code
  `SessionStart` hook (`scripts/attach.sh`) that auto-attaches every session on
  start via a loopback HTTP API (`src/api.ts`, `API_PORT`, default 4123):
  project dir from cwd, tmux target auto-detected. The closest equivalent to
  Claude Code's native `/remote-control`. Idempotent; silent when the daemon is
  down.
- **Pane mirroring (1:1)** — terminal sessions are mirrored from the tmux pane
  itself: the active session's screen is captured and streamed, so rendered
  markdown and interactive UI (multiple-choice prompts included) show up, and
  input is pasted + Enter. Only the session selected in `/sessions` is
  streamed; `/view` grabs the current screen. History is never replayed.
- **Tmux-only discovery** — only `claude:*` tmux sessions (plus hook / `/attach`
  ones) are tracked; no `~/.claude/projects` scanning, so non-Ollama sessions
  never appear. The JSONL mirror was removed.
- **Voice transcription removed** — text-only for now (whisper was removed
  from Ollama); transcription may return in the future.
- **`./install.sh --uninstall`** — removes the launchd agent and the
  SessionStart hook, and asks before removing the Ollama model, the state dir
  and `.env`.
- **Bot in English** — all user-facing bot messages are now English (the bot
  was previously Italian).
- **Command menu** — `/rc`, `/sessions`, `/view`, `/new`, `/stop`, `/status`,
  `/attach`, `/help` registered via `setMyCommands`, so Telegram suggests them
  when you type `/`.

## [0.1.0] - 2026-08-05

Initial release — Phase 1 MVP: local daemon + Telegram bot that mimics Claude
Code's `/remote-control` for Ollama-served models, without Anthropic
infrastructure.

- **Daemon** (Node 22 + tsx) with a typed internal event bus and a persistent
  registry (`~/.ollama-rc/state.json`) holding the global `armed` switch and
  the session list.
- **Headless sessions** driven via the Claude Agent SDK (`query` + `resume`,
  `canUseTool`), pinned at `0.3.221`; session ids persist across restarts.
- **Terminal sessions** discovered from tmux (`claude:*`), mirrored by
  capturing the pane, and driven 1:1 by pasting input + Enter, gated on the
  `armed` switch.
- **Remote permissions** — SDK `canUseTool` requests surface in Telegram as
  `✓ Approve` / `✗ Reject` buttons; unanswered requests time out into a deny
  (`PERMISSION_TIMEOUT_SECONDS`).
- **Media** — files saved to `~/.ollama-rc/inbox/` and forwarded as a path
  reference the model can read via its extra directories.
- **Security** — default-deny pairing (`ALLOWED_USER_IDS` or `PAIRING_CODE`);
  while disarmed the bot answers only `/rc`, `/help`, `/start`.
- **launchd agent** (`com.ontech7.ollama-rc`) with install script and template.
- **Guided installer** (`./install.sh`) that walks a non-expert through
  prerequisites, bot token, authorization, models and the daemon registration.
- **Docs & landing** — English README, `AI-GUIDE.md` (AI-agent setup matrix),
  landing page (`index.html`), CHANGELOG, MIT LICENSE, GitHub Pages `.nojekyll`
  and a CI workflow (`npm ci` → typecheck → vitest).
