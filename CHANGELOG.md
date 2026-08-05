# Changelog

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
