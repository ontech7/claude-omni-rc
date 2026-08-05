<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="ollama-rc" width="544">
  </picture>
</div>

<p align="center"><strong>Remote control for Claude Code, served by Ollama.</strong><br>
A local daemon plus a Telegram bot that mimics Claude Code's
<code>/remote-control</code> — see your sessions, chat with them, and approve
permissions from your phone — without any Anthropic infrastructure.</p>

<p align="center">
  <a href="https://github.com/ontech7/ollama-rc/actions/workflows/ci.yml"><img src="https://github.com/ontech7/ollama-rc/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white" alt="Node 22+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ontech7/ollama-rc" alt="License"></a>
</p>

<p align="center"><sub><a href="https://ontech7.github.io/ollama-rc/">Landing page</a> · <a href="AI-GUIDE.md">AI-GUIDE.md</a> — AI agents, start at <a href="AI-GUIDE.md">AI-GUIDE.md</a></sub></p>

---

```
@your_bot                       ← Telegram, from your phone
/rc on
🔓 Remote control ARMED.
/new write a haiku about tmux
🆕 Session a1b2c3d4 started.
🔧 Permission requested — session a1b2c3d4
Tool: Bash
{"command":"ollama list"}
[✓ Approve]  [✗ Reject]         ← you tap Approve from the couch
✅ Ran it: ollama list …
```

## Why there is no native remote control

Claude Code ships a `/remote-control` feature, but it is **architecturally
incompatible** with a local-Ollama setup: since v2.1.196 it is disabled when
`ANTHROPIC_BASE_URL` does not point to `api.anthropic.com`, it requires a
claude.ai account (Pro/Max/Team/Enterprise), and it syncs your transcripts
through Anthropic's servers.

If you drive Claude Code with an Ollama-served model — `ANTHROPIC_BASE_URL`
pointing at Ollama, a placeholder `ollama` token, models like
`deepseek-v4-flash:0731-cloud` — you get none of that. `ollama-rc` is a
**local** replacement: a daemon on your machine plus a Telegram bot
(long-polling, outbound-only, no open ports), gated by an explicit
`armed` switch. It is unofficial and not affiliated with Anthropic or Ollama.

## Quick install

```bash
git clone https://github.com/ontech7/ollama-rc
cd ollama-rc
./install.sh
```

The guided installer asks you the few questions it needs — your Telegram bot
token, who is allowed to control it, whether to download the models — then
installs the dependencies and registers the background daemon. It never
overwrites a value you already set in `.env`. After it finishes: message the
bot, pair with `/start <code>` (if you chose a pairing code), then `/rc on`.

Prefer to see what's happening? [Manual install](#manual-install) below.

## Prerequisites

| Tool | Why | Required |
|------|-----|----------|
| **Node.js 22+** | runtime | yes |
| **Ollama** (running) | serves the models | yes |
| **tmux** | mirror + inject text into terminal sessions | for `/attach` only |
| **ffmpeg** | voice-note → wav conversion for transcription | for voice only |

Models (pulled by the installer, or `ollama pull <name>` yourself):

- `deepseek-v4-flash:0731-cloud` — the default model for headless sessions
- `whisper-large-v3` — transcribes voice notes

## Manual install

This is what `./install.sh` does under the hood, step by step.

**1. Get a bot token.** Message [@BotFather](https://t.me/BotFather) on
Telegram, send `/newbot`, follow the prompts, and copy the token it gives you.

**2. Configure `.env`.**

```bash
cp .env.example .env
```

Fill in at least:

- `TELEGRAM_BOT_TOKEN` — the token from BotFather
- one authorization method:
  - `ALLOWED_USER_IDS` — your Telegram numeric id (find it with
    [@userinfobot](https://t.me/userinfobot)), or
  - `PAIRING_CODE` — a secret code; the first `/start <code>` authorizes that account

Everything else has a sensible default (see [Configuration](#configuration)).

**3. Install and start.**

```bash
npm install
./scripts/install-launchd.sh   # background daemon that restarts on login
```

For a first test in the foreground instead: `npm run dev` (logs to the
terminal). The launchd logs go to `~/.ollama-rc/logs/daemon.log`.

## Telegram setup

1. Open the chat with your bot.
2. If you set a pairing code: send `/start <your-code>`. If you allowlisted
   your user id, you're already in.
3. Arm remote control: **`/rc on`**. While disarmed the daemon mirrors
   nothing, injects nothing and relays nothing — the bot answers only
   `/rc`, `/help` and `/start`.

## Usage

Run your interactive Claude Code sessions the usual way, inside tmux:

```bash
tmux new -s claude:my-project    # then run `claude` inside
```

The daemon discovers `claude:*` tmux sessions and mirrors them (read-only);
with `/attach` you can also attach one explicitly.

| Command | What it does |
|---------|--------------|
| `/start <code>` | pair this Telegram account (first time) |
| `/rc on` / `/rc off` / `/rc status` | global armed switch |
| `/sessions` | list sessions, switch the active one |
| `/new <text>` | create a headless session and send it your prompt |
| `/attach <project>` | attach a `claude:<project>` tmux session |
| `/stop` | stop the active session (aborts the running turn) |
| `/status` | show the active session's status |
| `/help` | list the commands |

Plain text messages go to the active session (default: the most recent one):
headless sessions receive them as a new turn, terminal sessions receive them
as injected text (only while idle). Up to `MAX_HEADLESS_SESSIONS` headless
sessions run concurrently — the Ollama Cloud quota is finite.

## Remote permissions

When a headless session needs permission to run a tool, the bot forwards it
as a message with two buttons, and you decide from your phone:

```
🔧 Permission requested — session a1b2c3d4
Tool: Bash
{"command":"ollama list"}

[✓ Approve] [✗ Reject]
```

`✓ Approve` lets the tool run; `✗ Reject` blocks it and tells the model.
An unanswered request times out after `PERMISSION_TIMEOUT_SECONDS` (default
120) and is denied. Tools already covered by your allowlist rules (e.g. in
`~/.claude/settings.json`) never generate a notification.

## Media

- **Voice notes** — downloaded, converted with ffmpeg, transcribed with the
  Ollama whisper model, and sent to the session as text.
- **Files** — saved to `~/.ollama-rc/inbox/` and forwarded to the session as
  a file-path reference, which the model can read via its extra directories.
- **Photos** — saved to the inbox the same way and forwarded as a path
  reference only. The default model is text-only, so it cannot *see* the
  picture; there is no image-input pipeline. Pick a vision-capable Ollama
  model if you need that.

## Architecture

```
ollama-rc/
├── src/
│   ├── daemon.ts            entry: config, wiring, shutdown, restart
│   ├── config.ts            .env → typed config
│   ├── bus.ts               typed pub/sub event bus
│   ├── state.ts             persistent registry (~/.ollama-rc/state.json)
│   ├── sessions/
│   │   ├── manager.ts       session registry + armed switch + idle reaping
│   │   ├── sdk-driver.ts    headless sessions (Claude Agent SDK query+resume)
│   │   ├── mirror.ts        read-only tail of ~/.claude/projects/*.jsonl
│   │   └── tmux-inject.ts   bracketed-paste text injection into tmux panes
│   ├── permissions.ts       SDK canUseTool → Approve/Reject flow
│   ├── input.ts             attachments → inbox; voice → whisper transcription
│   └── ollama.ts            /api/show capabilities + whisper transcription
└── bot/
    └── telegram.ts          grammy bot: commands, keyboards, throttled edits
```

Data flow: `Telegram ↔ bot ↔ bus ↔ sessions (SDK / tmux) ↔ Ollama`.

- **Headless sessions** are owned by the daemon and driven via the Claude
  Agent SDK (`query` + `resume`, `canUseTool`), version **0.3.221** (pinned —
  the SDK is in preview and changes fast). Session ids are persisted, so
  sessions survive daemon restarts.
- **Terminal sessions** are mirrored read-only from the Claude project JSONL
  files and injected into via tmux with bracketed paste. The mirror only
  runs while armed; offsets are persisted per file.
- **State** — the `armed` switch and the session registry — lives in
  `~/.ollama-rc/state.json`.
- **Concurrency** — at most `MAX_HEADLESS_SESSIONS` headless turns at once;
  terminal injection only happens when the mirror reports the pane idle.

## Configuration

`.env` (or environment variables). Everything is optional except the bot
token and one authorization method.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TELEGRAM_BOT_TOKEN` | — | bot token from @BotFather (**required**) |
| `ALLOWED_USER_IDS` | — | comma-separated Telegram ids allowed to control |
| `PAIRING_CODE` | — | secret code authorizing the first `/start <code>` |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | where Ollama listens |
| `DEFAULT_MODEL` | `deepseek-v4-flash:0731-cloud` | model for headless sessions |
| `WHISPER_MODEL` | `whisper-large-v3` | model for voice transcription |
| `MAX_HEADLESS_SESSIONS` | `2` | concurrent headless sessions |
| `PERMISSION_TIMEOUT_SECONDS` | `120` | unanswered permission → deny |
| `WORKSPACE_DIRS` | — | `:`-separated project roots for `/attach` |
| `STATE_DIR` | `~/.ollama-rc` | where state, logs and the inbox live |
| `INBOX_DIR` | `<STATE_DIR>/inbox` | incoming attachments |
| `PROJECTS_DIR` | `~/.claude/projects` | JSONL mirror source |
| `ARMED_ON_START` | `false` | arm the remote control on daemon start |
| `IDLE_GRACE_MS` | `3000` | how long a session must be quiet to count as idle |
| `POLL_INTERVAL_MS` | `500` | mirror polling interval |

> Note: `~/.ollama-rc/logs/daemon.log` is a plain file without automatic
> rotation — rotation is left to the OS (`newsyslog`) or to you.

## Troubleshooting

**"Non autorizzato. Inviami /start <codice di pairing>."**
You're not allowlisted and haven't paired. Send `/start <code>` with the
`PAIRING_CODE` from `.env`, or add your id to `ALLOWED_USER_IDS`.

**The bot says "Remote control disattivato. Usa /rc on."**
That's the armed switch doing its job — everything is gated on it. Send
`/rc on` from Telegram (or restart the daemon with `ARMED_ON_START=true`).

**The daemon doesn't seem to be running.**
Check `~/.ollama-rc/logs/daemon.log` (and `daemon.err.log`), then re-run
`./scripts/install-launchd.sh` or `npm run dev` to see errors in the terminal.

**Ollama is not reachable.**
Start Ollama (the app or `ollama serve`). The daemon needs it at
`OLLAMA_BASE_URL`.

**A headless session is stuck on "running".**
Send `/stop` — it aborts the current turn via an `AbortController` and marks
the session stopped.

**"Sessione occupata" when sending a message.**
The session is mid-turn. Wait for it to go idle; terminal sessions accept
text only while idle (the daemon never injects blindly).

**Where is my data stored?**
State (`armed`, sessions) in `~/.ollama-rc/state.json`, attachments in
`~/.ollama-rc/inbox/`, logs in `~/.ollama-rc/logs/`. Override with
`STATE_DIR`.

## Disclaimer

This is an **unofficial** project. It talks to your local Ollama instance
and to the Telegram Bot API only; nothing leaves your machine otherwise.
The Claude Agent SDK is a preview and may change — the version is pinned for
a reason. Not affiliated with Anthropic or Ollama.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026.
