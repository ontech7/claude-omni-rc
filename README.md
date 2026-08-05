<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="ollama-rc" width="544">
  </picture>
</div>

<p align="center"><strong>Take your session with you.</strong><br>
A local daemon plus a Telegram bot that mimics Claude Code's
<code>/remote-control</code> — keep talking to any running session from your
phone, approve permissions, and pick up exactly where you left off — without
any Anthropic infrastructure.</p>

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

Headline use case: you leave a long task running (a build, a migration, a
multi-hour review), arm ollama-rc, walk out the door — and keep steering that
same session, plus any other session you have running, from your phone.
Starting brand-new conversations is a bonus, not the point.

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

To remove everything: `./install.sh --uninstall` — it asks before removing the
Ollama model, then removes the launchd agent, the SessionStart hook and (on
confirmation) the state dir. Your `.env` is kept so a reinstall is one command.

## Prerequisites

| Tool | Why | Required |
|------|-----|----------|
| **Node.js 22+** | runtime | yes |
| **Ollama** (running) | serves the models | yes |
| **tmux** | inject input 1:1 and resolve the project dir for transcripts | for terminal sessions |

Model pulled by the installer (or `ollama pull` yourself):

- `deepseek-v4-flash:0731-cloud` — the default model for headless sessions

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
3. Arm remote control: **`/rc on`**. While disarmed the daemon streams
   nothing, injects nothing and relays nothing — the bot answers only
   `/rc`, `/help` and `/start`.

## Usage

Run your interactive Claude Code sessions the usual way, inside tmux:

```bash
tmux new -s claude:my-project    # then run `claude` inside
```

The daemon tracks `claude:*` tmux sessions (and any session attached via the
`SessionStart` hook or `/attach`); with `/attach` you can also add one
explicitly.

### How sessions get attached

Only **your sessions** are tracked — nothing scans `~/.claude/projects` on its
own. A session appears via the `claude:*` tmux discovery, the `SessionStart`
hook, or `/attach`; sessions running outside of ollama-rc (e.g. plain
Anthropic-hosted Claude Code) never show up.

- **Chat, not screen** — for each tracked session the daemon reads the
  conversation the CLI itself writes (`~/.claude/projects/<project>/…jsonl`)
  and streams it to Telegram as a chat: assistant messages rendered from
  markdown, your prompts echoed, tool calls grouped into a single `🔧` notice
  per work burst (the first call creates the bubble, the following ones update
  it). Notifications are event-driven — `❓` questions, permission buttons, `❌`
  on serious errors — with no status chatter while Claude works. History is
  never replayed: streaming starts from the moment you select
  the session with `/sessions`.
- **Multiple-choice questions** — when the model asks a question, the question
  and its options arrive as a `❓` message; reply with the option number (or
  its text) and it's answered 1:1.
- **Interact 1:1** — a message you send is pasted into the session and
  submitted (Enter). This needs tmux: a session not in tmux streams as chat
  but is read-only.
- **Headless sessions** (`/new`) stream their assistant text the same way and
  use the remote-permission buttons.
- `/view` still grabs the full current screen of the active session whenever
  you want the raw terminal.

### Auto-attach with a SessionStart hook

`./install.sh` also adds a Claude Code **`SessionStart` hook** that registers
every session with the daemon the moment it starts — the closest equivalent to
Claude Code's native `/remote-control`. The hook:

1. reads the project dir from the working directory,
2. if you're inside tmux, records the tmux session as the injection target
   (any tmux session works, not just `claude:*`),
3. tells the daemon on `127.0.0.1:${API_PORT}` to attach it.

So the session you're running right now can be continued from Telegram even
if it wasn't started with the `claude:` naming convention. To add it
manually, merge into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "/abs/path/to/ollama-rc/scripts/attach.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

The hook is idempotent and silently does nothing when the daemon isn't
running, so it never blocks Claude Code from starting.

| Command | What it does |
|---------|--------------|
| `/start <code>` | pair this Telegram account (first time) |
| `/rc on` / `/rc off` / `/rc status` | global armed switch |
| `/sessions` | list sessions, switch the active one |
| `/view` | show the active session's current screen |
| `/new <text>` | create a headless session and send it your prompt |
| `/attach <project>` | attach a `claude:<project>` tmux session |
| `/stop` | stop the active session (aborts the running turn) |
| `/status` | show the active session's status |
| `/help` | list the commands |

Plain text messages go to the active session (default: the most recent one):
headless sessions receive them as a new turn, terminal sessions receive them
as typed input (pasted into the pane + Enter). Up to `MAX_HEADLESS_SESSIONS`
headless sessions run concurrently — the Ollama Cloud quota is finite.

## Remote permissions

Permission requests arrive as a message with two buttons — from headless and
terminal sessions alike — and you decide from your phone:

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

- **Headless sessions** (`/new`) use the Agent SDK permission flow
  (`canUseTool`).
- **Terminal sessions** (Claude Code running in tmux) delegate via a
  `PermissionRequest` hook that `./install.sh` adds to `~/.claude/settings.json`.
  The hook forwards the request to the bot, waits for your verdict, and returns
  it to Claude Code. When the daemon is down or remote control is disarmed the
  hook returns no decision and Claude Code shows its normal in-terminal prompt
  — ollama-rc never blocks or auto-denies a regular session.

## Media

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
│   │   ├── tmux-watcher.ts  discover `claude:*` tmux sessions, prune dead ones
│   │   ├── tmux-inject.ts   pane cwd, capture-pane (/view), paste-and-Enter input
│   │   ├── transcript.ts    read the CLI transcripts (~/.claude/projects/…)
│   │   └── transcript-watcher.ts  tail transcripts → chat events + status
│   ├── permissions.ts       SDK canUseTool → Approve/Reject flow
│   ├── api.ts               loopback HTTP API (SessionStart hook attach, sessions)
│   ├── input.ts             attachments → inbox
│   └── ollama.ts            /api/show capabilities
└── bot/
    └── telegram.ts          grammy bot: commands, keyboards, chat streaming
```

Data flow: `Telegram ↔ bot ↔ bus ↔ sessions (SDK / tmux) ↔ Ollama`.

- **Headless sessions** are owned by the daemon and driven via the Claude
  Agent SDK (`query` + `resume`, `canUseTool`), version **0.3.221** (pinned —
  the SDK is in preview and changes fast). Session ids are persisted, so
  sessions survive daemon restarts.
- **Terminal sessions** are discovered from tmux (`claude:*`) and streamed as a
  chat by tailing the transcript the CLI writes; input is driven 1:1 by pasting
  into the pane + Enter, and permissions are delegated through a
  `PermissionRequest` hook. Streaming only runs while armed and follows the
  session selected in `/sessions`.
- **State** — the `armed` switch and the session registry — lives in
  `~/.ollama-rc/state.json`.
- **Concurrency** — at most `MAX_HEADLESS_SESSIONS` headless turns at once.

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
| `MAX_HEADLESS_SESSIONS` | `2` | concurrent headless sessions |
| `PERMISSION_TIMEOUT_SECONDS` | `120` | unanswered permission → deny |
| `WORKSPACE_DIRS` | — | `:`-separated project roots for `/attach` |
| `STATE_DIR` | `~/.ollama-rc` | where state, logs and the inbox live |
| `INBOX_DIR` | `<STATE_DIR>/inbox` | incoming attachments |
| `PROJECTS_DIR` | `~/.claude/projects` | where Claude Code stores session transcripts |
| `API_PORT` | `4123` | loopback port for the local API (SessionStart hook, permission hook) |
| `ARMED_ON_START` | `false` | arm the remote control on daemon start |
| `IDLE_GRACE_MS` | `3000` | how long a session must be quiet to count as idle |
| `POLL_INTERVAL_MS` | `500` | tmux discovery polling interval |

> Note: `~/.ollama-rc/logs/daemon.log` is a plain file without automatic
> rotation — rotation is left to the OS (`newsyslog`) or to you.

## Troubleshooting

**"Not authorized. Send /start <pairing code>."**
You're not allowlisted and haven't paired. Send `/start <code>` with the
`PAIRING_CODE` from `.env`, or add your id to `ALLOWED_USER_IDS`.

**The bot says "Remote control is off. Send /rc on."**
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

**The bot says text "can't be injected" into a session.**
That session isn't running inside tmux. Restart it with `tmux new -s
claude:<project>` and it becomes continuable from Telegram.

**A session I started outside tmux doesn't show up.**
Sessions are tracked via tmux (`claude:*`), the SessionStart hook or `/attach`.
A session attached by the hook but started outside tmux streams as chat but is
read-only (there's no pane to inject into). To make it fully continuable, start
Claude Code inside tmux: `tmux new -s claude:<project>`.

**The session streams nothing.**
Make sure you've selected it with `/sessions` — only the active session is
streamed. A session without a transcript (or a non-Ollama one) is read-only:
use `/view` for its raw screen. If a real Ollama session still shows nothing,
check `PROJECTS_DIR` matches where Claude Code writes its transcripts
(`~/.claude/projects`).

**Sessions aren't auto-attaching on start.**
Check `~/.claude/settings.json` contains the SessionStart hook (re-run
`./install.sh` to add it), the daemon is running, and `API_PORT` isn't taken
by something else.

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
