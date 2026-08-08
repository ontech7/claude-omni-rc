---
name: adding-a-config-option
description: The five-file checklist for adding, renaming, or changing the default of a claude-omni-rc setting — src/config.ts, .env.example, the README configuration table, install.sh, and the config tests — plus how to pick a safe default and how to change one without breaking existing installs. Use this skill whenever the user wants a new environment variable or knob, wants to change a default (timeout, poll interval, permission mode, model, workspace dirs), mentions .env or says "make it configurable", "add an env var", "expose a setting", or the Italian equivalents ("aggiungi una variabile", "rendilo configurabile", "cambia il default"). A setting that exists in only three of the five places is a support ticket, so read this first.
---

# Adding a config option

Configuration in this project is read exactly once, in `loadConfig()`
(`src/config.ts`), from an env object that defaults to `process.env`. Nothing
else in the codebase reads `process.env` — that's what makes the whole system
testable and what makes `.env.example` an honest document. Keep it that way:
a `process.env.FOO` sprinkled in a module is invisible to tests, to the
installer, and to the user reading the README.

## The five places, every time

A setting is not "added" until all five are done. They drift silently because
nothing checks them against each other.

1. **`src/config.ts`** — a field on the `Config` interface *and* its line in
   the returned object. Use the existing parsers: `parseNum(env, 'KEY',
   fallback)` for numbers (it survives a non-numeric value by falling back
   instead of producing `NaN`, which would otherwise become an infinite
   timer), `expandHome()` for anything that can be a path, `env.X === 'true'`
   for booleans, and `split(',')`/`split(':')` + `trim` + `filter(Boolean)` for
   lists. `''` and `undefined` must behave the same — a user who leaves a key
   blank in `.env` means "default", not "empty string".
2. **`.env.example`** — the key, its default, and a comment saying what it does
   and when you'd change it. This file is the one most users actually read;
   commented-out keys (like `CLAUDE_OMNI_RC_NO_UPDATE_CHECK`) signal
   "advanced, usually leave alone".
3. **`README.md` → Configuration table** — one row: variable, default, purpose.
   Match the default to what `config.ts` actually returns, not to what the
   comment says. Mark it **required** in bold if `/new` or the daemon refuses
   to work without it.
4. **`install.sh`** — only if the setting is something a first-time user must
   choose. The installer is interactive, never overwrites existing `.env`
   values, and prints what still needs a manual edit in non-interactive mode.
   Most settings do *not* belong in the installer; adding a prompt for every
   knob is how a two-minute install becomes a questionnaire.
5. **`test/config.test.ts`** — the default when the key is absent, and the
   parse when it's present. If the value has a dangerous mode (see below), also
   assert that garbage input lands on the safe side.

If the setting changes runtime behaviour a user would notice, add a
`CHANGELOG.md` entry under `## [Unreleased]` too.

## Choosing the default

This daemon can run shell commands on someone's machine from a chat app, so
defaults are a security decision, not ergonomics. The rule the project already
follows: **the default is the conservative option, and the permissive one is
opted into explicitly.**

- `DEFAULT_PERMISSION_MODE=standard` — every tool call asks. `auto` means an
  unattended agent with Bash access, so it must be chosen, never inherited.
- `WORKSPACE_DIRS` has no fallback. It used to default to `$HOME`, which rooted
  an unattended agent at every file the user owns; `/new` now refuses to start
  until it's set. Don't reintroduce a "helpful" fallback.
- `ARMED_ON_START=false` — a restarted daemon does nothing until someone arms it.
- Authorization is default-deny: with both `ALLOWED_USER_IDS` and
  `PAIRING_CODE` empty, nobody is authorized.

When a value is a timeout or an interval, ask what happens if it never fires
and make *that* the safe outcome — an unanswered permission denies at
`PERMISSION_TIMEOUT_SECONDS`, it does not approve.

When a value costs something per tick (`CWD_REFRESH_MS` runs `ps` + `lsof`,
`POLL_INTERVAL_MS` drives tmux discovery), say so in the comment. A future
reader lowering it to 100ms should know what they're buying.

## Changing an existing default

Existing users have an `.env` and a `state.json` written by the old version, and
the installer will not rewrite their `.env`. So:

- A default that becomes **more restrictive** is a breaking change. Mark it
  `**BREAKING:**` in the CHANGELOG with the one-line fix the user can apply
  (`/new` defaulting to `--standard` and `WORKSPACE_DIRS` becoming required are
  the precedents to imitate).
- Consider what happens to persisted state written before the change. Sessions
  restored from an older `state.json` without an explicit `permissionMode` fall
  back to asking — restored data should land on the safe default, never on the
  permissive one.
- Renaming a key orphans it in every existing `.env`. Prefer keeping the name;
  if you must rename, read both and say so in the CHANGELOG.

## Wiring it through

`createDaemon(config)` in `src/daemon.ts` is where the config reaches the
components — pass the individual value into the constructor that needs it
(`idleGraceMs`, `pollIntervalMs`) or the whole `Config` where a component
already takes it (`PermissionFlow`, `SdkDriver`, `TelegramBot`). Don't reach
back into a global.

## Verify

```bash
npm run typecheck && npm test
```

Then read your own `.env.example` line as a stranger: does it tell you what
happens if you leave it alone? If not, rewrite the comment — that sentence is
the whole interface for most people who install this.
