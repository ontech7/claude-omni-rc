# Changelog

## [Unreleased]

- **`/usage`**: 5h/weekly usage window for whichever provider is configured.
  Anthropic is read natively via the Agent SDK's experimental `/usage` control
  API; any other provider (Ollama, a custom proxy) shells out to
  [`ollama-usage`](https://github.com/ontech7/ollama-usage), which must be
  installed and authenticated on the daemon's machine.
- **Update check**: the daemon checks GitHub once a day for a newer release
  and, at most once per version, logs and sends a Telegram notice to the bound
  chat. Disable with `CLAUDE_OMNI_RC_NO_UPDATE_CHECK=1`.

## [0.2.0] - 2026-08-07

### Hardening pass (breaking defaults)

- **Long replies no longer vanish.** Telegram rejects messages over 4096
  characters and the send was swallowed by a `.catch`, so a long answer never
  arrived. Text is now split into several messages at line boundaries, reopening
  any HTML tag left open across the cut.
- **Permission prompts no longer hang after a daemon restart.** The notification
  chat is persisted in `state.json`. When no chat is bound, the
  `PermissionRequest` hook gets no decision (native in-terminal prompt) instead
  of blocking the session for `PERMISSION_TIMEOUT_SECONDS` and then denying.
- **Private chats only.** The bot refuses groups, supergroups and channels, and
  never binds one as a notification target — a group could otherwise receive the
  full session stream.
- **BREAKING: `/new` defaults to `--standard`.** Headless sessions ask before
  every tool call. Automode is now opt-in per session (`--auto`) or globally
  (`DEFAULT_PERMISSION_MODE=auto`). Sessions restored from an older `state.json`
  without an explicit mode also ask.
- **BREAKING: `/new` requires `WORKSPACE_DIRS`.** It no longer falls back to
  `$HOME`, which rooted an unattended agent at every file you own. The installer
  now asks for a project root.
- **`state.json` is written atomically** (temp file + rename). An unreadable
  state file is kept as `state.json.corrupt-<ts>` and reported, instead of being
  silently replaced by an empty one — losing sessions and authorized users.
- **Much lower idle CPU.** Overlapping polls are skipped, the process table is
  snapshotted once per poll instead of once per session, and a tracked session's
  real cwd is re-checked every `CWD_REFRESH_MS` (default 10s) rather than on
  every 500 ms poll.
- Added [SECURITY.md](SECURITY.md) and a security section in the README, with
  the known limitations stated rather than omitted.
- Remaining Italian user-facing strings translated to English.
- **Multiple-choice questions no longer get stuck.** `AskUserQuestion` is now a
  proper flow: question sets are queued and shown one at a time, with
  single-select, multi-select (toggle + Done) and a free-text "Other" option.
  Answers are delivered per question to terminal sessions (option numbers) and
  as one message per set to headless sessions, so Claude continues after the
  last answer instead of leaving the input blocked.
- **Plan approval and model refusals no longer strand the session.**
  - **Plan approval** (`ExitPlanMode`, headless sessions) arrives as a 📋
    message with the plan text and ✓ Approve / ✗ Reject / ✏️ Edit buttons — Edit
    asks for the new plan text as a message, and the edited plan is sent back
    via `updatedInput`. Previously the plan was auto-approved in automode or
    shown as a raw permission JSON in standard mode, with no way to review or
    edit it. Terminal sessions still show the plan approval as a full-screen
    terminal UI the bot cannot drive — documented in the README.
  - **Model refusal** (`refusal_fallback_prompt`, the one `request_user_dialog`
    kind the CLI emits) offers 🔄 Retry / Skip, answered with the CLI's
    `retry_fallback` / `cancelled` result. Any unknown dialog kind is shown
    with a Cancel button instead of being ignored — an ignored dialog parks the
    turn and blocks the user. Unanswered dialogs time out into the CLI's
    default behavior, and `/stop`, `/delete` and `/rc off` cancel them.

- **Headless sessions are now provider-agnostic ("omni")** — the daemon spawns
  `claude` with the provider configured in `.env` (`ANTHROPIC_BASE_URL` /
  `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`), falling back to Ollama when
  unset. `/new --model <name>` picks the model per session. The `SessionStart`
  hook now registers every Claude Code session, whatever model backs it.
- **Renamed to `claude-omni-rc`** — the project is now positioned as remote
  control for *any* model that runs through the Claude Code CLI (Ollama-served
  models, other local or proxied LLMs, or Claude itself), not just Ollama.
  State dir default is now `~/.claude-omni-rc`, the launchd label is
  `com.ontech7.claude-omni-rc`, and the new `omni-rc` command starts a Claude
  Code session inside a `claude:<name>` tmux session ready for remote control.
  `/rc` with no argument now toggles the armed switch.
- **Stability hardening** —
  - **The daemon can no longer crash** — a global `bot.catch` (grammy no longer
    stops on a middleware error), a `safe()` wrapper on every handler, `track()`
    on fire-and-forget promises and an `unhandledRejection` guard mean one bad
    message (e.g. tmux down during injection) yields a friendly error, not a
    dead daemon.
  - **Timeouts everywhere** — Telegram API calls (35s), tmux commands (10s),
    file downloads (30s) and Ollama fetches (10s); the bot can no longer hang
    on a stuck network call.
  - **`/stop` reports the real outcome** — "Turn aborted" when a turn was
    running, the session's actual status otherwise; Ctrl+C to terminal panes is
    reported accurately.
  - **Multiple-choice questions show every option** — a numbered list of the
    full option text (with descriptions) in the message, plus tap buttons as a
    shortcut; nothing is truncated anymore.
  - **Markup is corrected, not dropped** — `mdToHtml` protects code blocks and
    balances tags, so malformed markdown can no longer make Telegram silently
    discard a message.
  - **History is capped by whole messages** — never cut mid-message; long
    messages are truncated at a word boundary with an explicit marker.
  - **The active session survives restarts** — `activeSessionId` is persisted
    in the state, so streaming resumes on the same session after a daemon
    restart.
- **Telegram UX fixes** —
  - **No echo of your own messages** — text the bot injects into a tmux
    session is not forwarded back from the transcript; messages typed at the
    terminal still stream.
  - **Multiple-choice questions as buttons** — `AskUserQuestion` is
    auto-allowed (no raw-JSON permission bubble) and appears with one inline
    button per option; tapping answers the session. Numbered replies still work.
  - **Claude slash commands** — `/`-commands the bot doesn't own (e.g.
    `/clear`, `/compact`, `/exit`, `/frontend-release`) are forwarded verbatim
    to the active session instead of being dropped.
  - **Interrupt** — `/stop` now sends `Ctrl+C` to the active terminal session's
    pane (like pressing ESC), and still aborts headless turns.
  - **Session history** — selecting a session shows its last messages; a new
    `/history [id]` command re-reads them on demand.
  - **Session delete** — new `/delete [id]` command and a 🗑 button per row in
    `/sessions`, with an inline confirm. Headless turns are stopped first;
    terminal panes are untracked, not killed.
  - **Approve/Reject feedback** — the permission message is edited in place
    (`✅ Approved` / `❌ Rejected`, buttons removed) instead of only a toast.
  - **Automode by default for `/new`** — headless sessions auto-approve every
    permission (no prompts); `/new --standard <text>` restores the approve/
    reject flow. The mode is per-session and persisted.
- **SessionStart hook + local API** — `./install.sh` adds a Claude Code
  `SessionStart` hook (`scripts/attach.sh`) that auto-attaches every session on
  start via a loopback HTTP API (`src/api.ts`, `API_PORT`, default 4123):
  project dir from cwd, tmux target auto-detected. The closest equivalent to
  Claude Code's native `/remote-control`. Idempotent; silent when the daemon is
  down.
- **Chat streaming for terminal sessions** — the active session's conversation
  is streamed as a chat by tailing the transcript Claude Code writes
  (`~/.claude/projects/…`): assistant messages rendered from markdown, your
  prompts echoed, tool calls grouped into one `🔧` notice per work burst (the
  first call creates the bubble, later ones update it). Notifications are
  event-driven: `❓` questions with the options (reply with the option number),
  permission buttons, and a `❌` on serious errors (e.g. `max_tokens`) — no
  status chatter while Claude works. `/view` still grabs the raw screen.
  History is never replayed.
- **Remote permissions for terminal sessions** — a `PermissionRequest` hook in
  `~/.claude/settings.json` delegates CLI permission decisions to Telegram
  (✓ Approve / ✗ Reject); it falls back to the native in-terminal prompt when
  the daemon is down or remote control is disarmed.
- **Session lifecycle** — sessions whose tmux target disappears are pruned from
  `/sessions`; a new status (`awaiting-input`) marks sessions that are waiting
  for you.
- **Tmux-only discovery** — only `claude:*` tmux sessions (plus hook / `/attach`
  ones) are tracked, registered with the pane's real cwd; no `~/.claude/projects`
  scanning, so non-Ollama sessions never appear.
- **Voice transcription removed** — text-only for now (whisper was removed
  from Ollama); transcription may return in the future.
- **`./install.sh --uninstall`** — removes the launchd agent and the
  SessionStart hook, and asks before removing the Ollama model and the state
  dir (`.env` is kept for a quick reinstall).
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
  registry (`~/.claude-omni-rc/state.json`) holding the global `armed` switch and
  the session list.
- **Headless sessions** driven via the Claude Agent SDK (`query` + `resume`,
  `canUseTool`), pinned at `0.3.221`; session ids persist across restarts.
- **Terminal sessions** discovered from tmux (`claude:*`), mirrored by
  capturing the pane, and driven 1:1 by pasting input + Enter, gated on the
  `armed` switch.
- **Remote permissions** — SDK `canUseTool` requests surface in Telegram as
  `✓ Approve` / `✗ Reject` buttons; unanswered requests time out into a deny
  (`PERMISSION_TIMEOUT_SECONDS`).
- **Media** — files saved to `~/.claude-omni-rc/inbox/` and forwarded as a path
  reference the model can read via its extra directories.
- **Security** — default-deny pairing (`ALLOWED_USER_IDS` or `PAIRING_CODE`);
  while disarmed the bot answers only `/rc`, `/help`, `/start`.
- **launchd agent** (`com.ontech7.claude-omni-rc`) with install script and template.
- **Guided installer** (`./install.sh`) that walks a non-expert through
  prerequisites, bot token, authorization, models and the daemon registration.
- **Docs & landing** — English README, `AI-GUIDE.md` (AI-agent setup matrix),
  landing page (`index.html`), CHANGELOG, MIT LICENSE, GitHub Pages `.nojekyll`
  and a CI workflow (`npm ci` → typecheck → vitest).
