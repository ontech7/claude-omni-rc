---
name: shipping-a-change
description: The definition of done for claude-omni-rc — the gate to run (typecheck + tests), the docs that must move with the code (README, AI-GUIDE, .env.example, CHANGELOG, index.html), commit message conventions, the security questions to ask before committing, and how a release is cut. Use this skill whenever you are about to commit, push, open a PR, or when the user says "ship it", "commit", "is this ready?", "cut a release", "bump the version", or asks whether a change is finished. Anything merged here becomes a daemon with shell access on someone's machine, so run through this before calling work done.
---

# Shipping a change

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, `npm test`
on Node 22 — and that is the entire automated gate. No linter, no formatter, no
coverage floor, no integration run, no reviewer bot. Everything else in this
checklist is something only you will catch.

## 1. The gate

```bash
npm run typecheck && npm test
```

Both green, locally, before you commit — not "it should be fine". `strict` is on
and `tsconfig.json` includes `test`, so a typing shortcut in a test fails the
build like any other. If you added behaviour, the new test must actually fail
when you revert the change; a test that passes against the broken code is worse
than none, because it will be trusted from then on.

## 2. Move the docs with the code

Docs here aren't decoration: `AI-GUIDE.md` is executed by agents setting the
project up, `.env.example` is the file users copy, and the README is what
someone reads before running an unsandboxed daemon. Stale means wrong.

| If you changed… | Update |
|---|---|
| a bot command, flag or button | `setMyCommands` + `/help` in `bot/telegram.ts`, README *Usage*, AI-GUIDE *Setup matrix* + *Command reference* |
| a config variable or default | `src/config.ts`, `.env.example`, README *Configuration* table, `install.sh` if a first-timer must choose it |
| install or uninstall behaviour | `install.sh`, README *Install* / *Manual install*, AI-GUIDE *Install*, the install command on `index.html` |
| a trust boundary, default-deny, or the armed switch | README *Security*, `SECURITY.md`, and the framing on `index.html` |
| anything a user would notice | `CHANGELOG.md` under `## [Unreleased]` |

Docs go in the **same commit** as the code. A follow-up commit that "fixes the
docs" only exists in a world where someone remembered.

### CHANGELOG entries

Write from the user's point of view — what changed for them and what they can
do about it, not which function you edited. Existing entries are the template:
a bolded lead, then the consequence. Breaking changes get **BREAKING:** and the
one-line fix (`/new` defaulting to `--standard` and `WORKSPACE_DIRS` becoming
required are the precedents).

## 3. The security pass

This project forwards the ability to run commands on someone's machine to a
chat app, with no sandbox. Before committing, answer these — and if any answer
is uncomfortable, raise it with the user instead of deciding alone:

- Does this add a path that runs while the daemon is **disarmed**? Nothing may
  stream, inject or relay when `/rc` is off, except `/rc`, `/help`, `/start`.
- Does it add a path that skips `authorize`, or that answers in a group chat?
  Authorization is default-deny and the bot is private-chat only.
- Does it make a permissive mode easier to fall into by accident? Unattended
  approval must stay an explicit opt-in per session or per config.
- On any failure, timeout or missing dependency, does it land on **deny/no-op**?
  An unanswered permission denies; a missing notification target denies rather
  than blocking.
- Does it widen where a headless session may run? `WORKSPACE_DIRS` has no
  home-directory fallback, on purpose.
- Does it log or send anything sensitive? Tokens, `.env` contents, pairing
  codes and full file contents don't belong in `daemon.log` or a Telegram
  message.

Also run `git status` and `git diff --staged` before committing and look at what
you're actually including — `.env`, `.claude-omni-rc/` and `logs/` are
gitignored, but a stray transcript, screenshot or scratch file with a token in
it is not.

## 4. Commit

The history uses Conventional Commits with an optional scope, in the imperative,
one concern per commit:

```
feat(bot): add /usage command and GitHub release update check
fix(bot): queue prompts for background sessions instead of broadcasting
test(transcript-watcher): fix flaky stale-binding test on CI
chore: translate scripts to English and polish installer output
docs: ...
```

Scopes seen in this repo: `bot`, `omni-rc`, `transcript-watcher`, or none for
cross-cutting work. Body optional; use it to explain *why*, since the diff
already shows what.

Commit on the branch you were told to develop on — never straight to `main`.

## 5. Push and PR

```bash
git push -u origin <branch>
```

Only open a pull request when the user asks for one. When you do, describe the
user-visible change and how you verified it, and say plainly what you could
*not* verify in this environment (anything needing a real tmux, a bot token, a
phone, or a browser). An honest "not verified end-to-end" is worth more than a
confident claim that turns out to be wrong on someone's machine.

## 6. Cutting a release (only when asked)

1. Bump `version` in `package.json` — `src/update.ts` reads it at runtime as
   `CURRENT_VERSION`, and that's what every install compares against the latest
   GitHub release to decide whether to notify.
2. Move the `## [Unreleased]` block to `## [x.y.z] - YYYY-MM-DD`.
3. Commit as `chore: release x.y.z`.
4. Tag and publish a GitHub release — the daily update check reads the *latest
   release*, so a tag without a release notifies nobody.

## The honest summary

When you report the change, say what you ran and what you couldn't. "typecheck
and tests pass; the tmux path is covered by unit tests but I couldn't exercise a
real session here" is a complete answer. "Done ✅" on top of an unverified
assumption is how a broken daemon reaches someone's phone at 2am.
