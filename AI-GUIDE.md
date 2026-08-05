# ollama-rc — AI agent setup guide

Remote control for Claude Code served by Ollama: a local daemon plus a
Telegram bot that mimics Claude Code's `/remote-control` without Anthropic
infrastructure. Repo: https://github.com/ontech7/ollama-rc · MIT · Node 22+ ·
unofficial, not affiliated with Anthropic or Ollama.

## How to use this file

You are setting this up for a human. **Ask them what they want**, then run
the matching command below and verify it worked. The one thing only the human
can do is create the Telegram bot token with @BotFather (one-time) and, if a
pairing code is used, send `/start <code>` from their phone.

## Install

```bash
git clone https://github.com/ontech7/ollama-rc
cd ollama-rc
./install.sh
```

The installer is interactive: it checks prerequisites (Node 22, Ollama, tmux),
runs `npm install`, guides the human through the bot token and authorization
into `.env`, optionally pulls the Ollama models, registers the launchd daemon,
and adds the Claude Code hooks (`SessionStart` auto-attach + `PermissionRequest`
approve/reject from Telegram). It never overwrites existing `.env` values. If
you are running it non-interactively, it does the silent steps only and prints
what still needs manual edits.

Manual equivalent (same result, step by step):

```bash
cp .env.example .env            # then fill TELEGRAM_BOT_TOKEN + ALLOWED_USER_IDS / PAIRING_CODE
npm install
./scripts/install-launchd.sh    # or: npm run dev  for a foreground test
```

## Setup matrix — "if the user asks X, do Y"

| User asks for… | Do this |
|----------------|---------|
| install / set up ollama-rc | run the clone + `./install.sh` flow |
| help creating the Telegram bot | point them to @BotFather (https://t.me/BotFather) → `/newbot` |
| allow only themselves | set `ALLOWED_USER_IDS` to their Telegram numeric id (@userinfobot) |
| allow via a code instead | set `PAIRING_CODE` in `.env`; they send `/start <code>` once |
| arm / disarm remote control | from Telegram: `/rc on` / `/rc off` (or `ARMED_ON_START=true` in `.env`) |
| create a headless session | from Telegram: `/new <prompt>` (automode by default; `/new --standard <prompt>` for approve/reject prompts) |
| continue an ongoing session from the phone | make sure it runs inside tmux (`tmux new -s claude:<project>`); it auto-appears in `/sessions` and streams as a chat |
| see what the model is writing | select the session with `/sessions`: its messages stream as a chat automatically |
| answer a multiple-choice question | the question arrives as a `❓` message with one button per option; tap it (or reply with the option number/text) |
| auto-attach every session on start | `./install.sh` already adds the `SessionStart` + `PermissionRequest` hooks (see `~/.claude/settings.json`) |
| attach a terminal (tmux) session | from Telegram: `/attach <project>` (session must be named `claude:<project>`) |
| stop a session / a running turn | from Telegram: `/stop` |
| approve / reject a permission | tap `✓ Approve` / `✗ Reject` on the bot message (timeout → deny) |
| see the active session's raw screen | from Telegram: `/view` |
| send a file | the bot saves it to `~/.ollama-rc/inbox/` and forwards the path |
| check what sessions exist | from Telegram: `/sessions` or `/status` |
| run it without launchd | `npm run dev` in the repo (foreground) |
| uninstall ollama-rc | `./install.sh --uninstall` (asks about the Ollama model, then removes launchd, the hooks, and on confirmation the state dir; `.env` is kept) |

## Command reference (bot)

- `/start <code>` — pair this Telegram account (first time, if pairing is used).
- `/rc on` / `/rc off` / `/rc status` — global armed switch. **While disarmed
  the bot answers only `/rc`, `/help`, `/start`**; no streaming, no injection,
  no relay.
- `/sessions` — list sessions and switch the active one (inline buttons). Only
  the active session's screen is streamed.
- `/view` — send the active session's current screen (tmux pane).
- `/new <text>` — create a headless session and send it the prompt (automode by
  default: permissions auto-approved; `/new --standard <text>` to get the
  approve/reject buttons).
- `/attach <project>` — attach the `claude:<project>` tmux session.
- `/stop` — abort the active session's running turn (sends `Ctrl+C` to a tmux
  pane, like pressing ESC).
- `/status` — active session status.
- `/history [id]` — show the last messages of a session.
- `/delete [id]` — delete a session (with an inline confirm).
- `/help` — list commands.

Plain messages go to the active session: headless sessions receive them as a
new turn, terminal sessions as pasted input + Enter (so the human can answer
interactive prompts). Slash commands the bot doesn't own (`/clear`, `/compact`,
`/exit`, custom commands, …) are forwarded verbatim to the active session.
Selecting a session in `/sessions` also shows its last messages.
Terminal sessions must run inside tmux (`claude:<project>`) to receive text.

## Configuration & data

- `.env` at the repo root (never commit it). See the README's
  [Configuration](https://github.com/ontech7/ollama-rc#configuration) table
  for every variable and default.
- Minimum: `TELEGRAM_BOT_TOKEN` plus either `ALLOWED_USER_IDS` or
  `PAIRING_CODE`.
- Data: `~/.ollama-rc/state.json` (armed switch + sessions),
  `~/.ollama-rc/inbox/` (attachments), `~/.ollama-rc/logs/` (daemon.log).
  Override with `STATE_DIR`.
- The daemon talks only to the local Ollama (`OLLAMA_BASE_URL`) and to the
  Telegram Bot API. No Anthropic calls.

## Verify

- `node -v` is 22+; `./install.sh` finishes with the summary screen.
- `.env` contains `TELEGRAM_BOT_TOKEN` and one of `ALLOWED_USER_IDS` /
  `PAIRING_CODE`.
- `ollama list` shows `deepseek-v4-flash:0731-cloud`.
- From Telegram: `/rc on` replies "🔓 Remote control ARMED"; `/new hello`
  creates a session; a permission request shows `✓ Approve / ✗ Reject`.

## Links

[README](https://github.com/ontech7/ollama-rc#readme) · [Landing](https://ontech7.github.io/ollama-rc/) · [CHANGELOG](https://github.com/ontech7/ollama-rc/blob/main/CHANGELOG.md) · [LICENSE](https://github.com/ontech7/ollama-rc/blob/main/LICENSE)
