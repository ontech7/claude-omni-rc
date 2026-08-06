<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/wordmark-dark.svg">
    <img src="assets/wordmark-light.svg" alt="claude-omni-rc" width="544">
  </picture>
</div>

<p align="center"><strong>Take your session with you.</strong><br>
A local daemon plus a Telegram bot that mimics Claude Code's
<code>/remote-control</code> — keep talking to any running session from your
phone, approve permissions, and pick up exactly where you left off — without
any Anthropic infrastructure. It works with <em>any</em> model that runs
through the Claude Code CLI: Ollama-served models, other local or proxied
LLMs, or Claude itself.</p>

<p align="center">
  <a href="https://github.com/ontech7/claude-omni-rc/actions/workflows/ci.yml"><img src="https://github.com/ontech7/claude-omni-rc/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white" alt="Node 22+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/ontech7/claude-omni-rc" alt="License"></a>
</p>

<p align="center"><sub><a href="https://ontech7.github.io/claude-omni-rc/">Landing page</a> · <a href="AI-GUIDE.md">AI-GUIDE.md</a> — AI agents, start at <a href="AI-GUIDE.md">AI-GUIDE.md</a></sub></p>

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
multi-hour review), arm claude-omni-rc, walk out the door — and keep steering that
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
`deepseek-v4-flash:0731-cloud` — you get none of that. `claude-omni-rc` is a
**local** replacement: a daemon on your machine plus a Telegram bot
(long-polling, outbound-only, no open ports), gated by an explicit
`armed` switch. It is unofficial and not affiliated with Anthropic or Ollama.

## Quick install

```bash
git clone https://github.com/ontech7/claude-omni-rc
cd claude-omni-rc
./install.sh
```

The guided installer asks you the few questions it needs — your Telegram bot
token, who is allowed to control it, whether to download the models — then
installs the dependencies and registers the background daemon. It never
overwrites a value you already set in `.env`. After it finishes: message the
bot, pair with `/start <code>` (if you chose a pairing code), then `/rc on`.

Prefer to see what's happening? [Manual install](#manual-install) below.

To remove everything: `./install.sh --uninstall` — it asks before removing the
Ollama model, then removes the launchd agent, the Claude Code hooks
(SessionStart + PermissionRequest) and (on confirmation) the state dir. Your
`.env` is kept so a reinstall is one command.

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
terminal). The launchd logs go to `~/.claude-omni-rc/logs/daemon.log`.

After code changes, restart the daemon to load the new code (no reinstall):
`./scripts/restart.sh` (or `./scripts/restart.sh status` to check it).

Start and stop the whole thing (daemon + headless sessions + hooks):

```bash
./scripts/start.sh   # checks everything is installed (runs ./install.sh if not), then starts the daemon
./scripts/stop.sh    # stops the daemon, kills headless sessions, removes the Claude Code hooks
```

`stop.sh` also removes the SessionStart/PermissionRequest hooks from
`~/.claude/settings.json`, so sessions stop auto-attaching until you run
`./scripts/start.sh` again. Your own terminal (tmux) sessions are never touched.

## Telegram setup

1. Open the chat with your bot.
2. If you set a pairing code: send `/start <your-code>`. If you allowlisted
   your user id, you're already in.
3. Arm remote control: **`/rc on`**. While disarmed the daemon streams
   nothing, injects nothing and relays nothing — the bot answers only
   `/rc`, `/help` and `/start`.

## Usage

Run your interactive Claude Code sessions the usual way, inside tmux. The
installer adds an `omni-rc` shell function that does it for you:

```bash
omni-rc my-project                          # tmux session claude:my-project + claude
omni-rc my-project -c ~/code/my-project -m deepseek-v4-flash:0731-cloud
omni-rc my-project -p "review the current diff"
omni-rc -l                                  # list claude:* sessions
```

(Equivalent to `tmux new -s claude:my-project` and running `claude` inside;
`omni-rc --help` lists every option. If the session already exists, `omni-rc`
just reattaches.)

The daemon tracks `claude:*` tmux sessions (and any session attached via the
`SessionStart` hook or `/attach`); with `/attach` you can also add one
explicitly.

### How sessions get attached

Only **your sessions** are tracked — nothing scans `~/.claude/projects` on its
own. A session appears via the `claude:*` tmux discovery, the `SessionStart`
hook, or `/attach`; sessions running outside of claude-omni-rc (e.g. plain
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
- **Multiple-choice questions** — when the model asks a question, it arrives as
  a `❓` message with a numbered list of every option (with descriptions), plus
  one inline button per option as a shortcut — nothing is truncated; tap or
  reply with the number. `AskUserQuestion` is auto-allowed, so no raw-JSON
  permission bubble appears.
- **Interact 1:1** — a message you send is pasted into the session and
  submitted (Enter). This needs tmux: a session not in tmux streams as chat
  but is read-only.
- **Headless sessions** (`/new`) stream their assistant text the same way.
  They run in **automode by default** (every permission is auto-approved, no
  prompts); add `--standard` to `/new` to get the remote-permission
  approve/reject buttons instead.
- `/view` still grabs the full current screen of the active session whenever
  you want the raw terminal.

#### "I started claude without tmux — can I move it under tmux?"

No — a running process can't be adopted by tmux. There is no seamless way to
move an already-started Claude Code session into a tmux pane (`reptyr` exists
on Linux but is fragile and doesn't work on macOS). What you get instead:

- **Read-only mirroring still works.** A session started outside tmux is
  registered by the `SessionStart` hook and its transcript is streamed to
  Telegram as a chat — you can follow it from your phone.
- **What you lose without tmux:** sending input to the session (it's
  read-only) and `/view` (there's no pane to capture). Headless `/new`
  sessions are unaffected.
- **The fix is to start under tmux from the beginning:** `omni-rc <name>`
  (or `tmux new -s claude:<name>`). If you're already in a session and know
  you'll want remote control, restart it with `omni-rc <name>` — the
  `SessionStart` hook now reminds you with a warning when you start a session
  outside tmux.

### Auto-attach and remote permissions via hooks

`./install.sh` also adds two Claude Code **hooks** that make a running session
behave like the native `/remote-control`:

- **`SessionStart`** — registers every session with the daemon the moment it
  starts: it reads the project dir from the working directory, records the
  tmux session as the injection target if you're inside tmux (any tmux session
  works, not just `claude:*`), and tells the daemon on
  `127.0.0.1:${API_PORT}` to attach it. So a session you started without the
  `claude:` naming convention can still be continued from Telegram.
- **`PermissionRequest`** — delegates CLI permission decisions to Telegram for
  terminal (tmux) sessions; see [Remote permissions](#remote-permissions).

To add them manually, merge into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "/abs/path/to/claude-omni-rc/scripts/attach.sh", "timeout": 10 }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          { "type": "command", "command": "/abs/path/to/claude-omni-rc/scripts/permission-hook.sh", "timeout": 600 }
        ]
      }
    ]
  }
}
```

Both hooks are idempotent. When the daemon is down or remote control is
disarmed, SessionStart does nothing (Claude Code starts normally) and
PermissionRequest returns no decision — Claude Code shows its native
in-terminal prompt, so a regular session is never blocked.

| Command | What it does |
|---------|--------------|
| `/start <code>` | pair this Telegram account (first time) |
| `/rc` (no arg) / `/rc on` / `/rc off` / `/rc status` | global armed switch — no argument toggles it |
| `/sessions` | list sessions, switch the active one |
| `/view` | show the active session's current screen |
| `/new <text>` | create a headless session and send it your prompt (automode; add `--standard` for approve/reject prompts) |
| `/attach <project>` | attach a `claude:<project>` tmux session |
| `/stop` | stop the active session (aborts the running turn; sends Ctrl+C to a tmux pane); reports whether a turn was actually aborted |
| `/status` | show the active session's status |
| `/history [id]` | show the last messages of a session (default: active) |
| `/delete [id]` | delete a session (headless: stops it; terminal: untracks only) |
| `/help` | list the commands |

Plain text messages go to the active session (default: the most recent one):
headless sessions receive them as a new turn, terminal sessions receive them
as typed input (pasted into the pane + Enter). Slash commands the bot doesn't
own (e.g. `/clear`, `/compact`, `/exit`, `/frontend-release`) are forwarded
verbatim to the active session too, so Claude Code's own commands work from
the phone. Up to `MAX_HEADLESS_SESSIONS` headless sessions run concurrently —
the Ollama Cloud quota is finite.

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
  — claude-omni-rc never blocks or auto-denies a regular session.

## Media

- **Files** — saved to `~/.claude-omni-rc/inbox/` and forwarded to the session as
  a file-path reference, which the model can read via its extra directories.
- **Photos** — saved to the inbox the same way and forwarded as a path
  reference only. The default model is text-only, so it cannot *see* the
  picture; there is no image-input pipeline. Pick a vision-capable Ollama
  model if you need that.

## Architecture

```
claude-omni-rc/
├── src/
│   ├── daemon.ts            entry: config, wiring, shutdown, restart
│   ├── config.ts            .env → typed config
│   ├── bus.ts               typed pub/sub event bus
│   ├── state.ts             persistent registry (~/.claude-omni-rc/state.json)
│   ├── sessions/
│   │   ├── manager.ts       session registry + armed switch + idle reaping
│   │   ├── sdk-driver.ts    headless sessions (Claude Agent SDK query+resume)
│   │   ├── tmux-watcher.ts  discover `claude:*` tmux sessions, prune dead ones
│   │   ├── tmux-inject.ts   pane cwd, capture-pane (/view), paste-and-Enter input
│   │   ├── transcript.ts    read the CLI transcripts (~/.claude/projects/…)
│   │   └── transcript-watcher.ts  tail transcripts → chat events + status
│   ├── permissions.ts       SDK canUseTool → Approve/Reject flow
│   ├── api.ts               loopback HTTP API (SessionStart attach, permission hook, sessions)
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
  `~/.claude-omni-rc/state.json`.
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
| `STATE_DIR` | `~/.claude-omni-rc` | where state, logs and the inbox live |
| `INBOX_DIR` | `<STATE_DIR>/inbox` | incoming attachments |
| `PROJECTS_DIR` | `~/.claude/projects` | where Claude Code stores session transcripts |
| `API_PORT` | `4123` | loopback port for the local API (SessionStart hook, permission hook) |
| `ARMED_ON_START` | `false` | arm the remote control on daemon start |
| `IDLE_GRACE_MS` | `3000` | how long a session must be quiet to count as idle |
| `POLL_INTERVAL_MS` | `500` | tmux discovery polling interval |

> Note: `~/.claude-omni-rc/logs/daemon.log` is a plain file without automatic
> rotation — rotation is left to the OS (`newsyslog`) or to you.

## Troubleshooting

**"Not authorized. Send /start <pairing code>."**
You're not allowlisted and haven't paired. Send `/start <code>` with the
`PAIRING_CODE` from `.env`, or add your id to `ALLOWED_USER_IDS`.

**The bot says "Remote control is off. Send /rc on."**
That's the armed switch doing its job — everything is gated on it. Send
`/rc on` from Telegram (or restart the daemon with `ARMED_ON_START=true`).

**The daemon doesn't seem to be running.**
Check `~/.claude-omni-rc/logs/daemon.log` (and `daemon.err.log`), then re-run
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
State (`armed`, sessions) in `~/.claude-omni-rc/state.json`, attachments in
`~/.claude-omni-rc/inbox/`, logs in `~/.claude-omni-rc/logs/`. Override with
`STATE_DIR`.

## Disclaimer

This is an **unofficial** project. It talks to your local Ollama instance
and to the Telegram Bot API only; nothing leaves your machine otherwise.
The Claude Agent SDK is a preview and may change — the version is pinned for
a reason. Not affiliated with Anthropic or Ollama.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026.
