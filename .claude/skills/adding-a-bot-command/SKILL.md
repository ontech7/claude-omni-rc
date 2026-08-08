---
name: adding-a-bot-command
description: The end-to-end checklist for adding, renaming, or changing a Telegram command or inline button in bot/telegram.ts — registration, the authorize + requireArmed gate, HTML escaping, message splitting, callback data, tests, and the four places the command list is duplicated (setMyCommands, /help, README, AI-GUIDE). Use this skill whenever the user asks for a new bot command or flag, wants an existing one to behave differently, mentions "/new", "/rc", "/sessions", "/usage", inline buttons, or says "add a command to the bot". Half a command shipped is a command that lies to the user in /help, so read this first.
---

# Adding a bot command

`bot/telegram.ts` is the largest file in the repo (~2000 lines) and the only
place a stranger's message turns into an action on the user's machine. A
command that skips one of the gates below isn't a smaller feature — it's a
hole. Work through this in order.

## 1. Decide where the logic goes

If any part of the command can be expressed as input → output — parsing
arguments, formatting a reply, deciding what to show — put it in an **exported
top-level function** above the class, next to `parseCommand`, `parseNewFlags`,
`htmlEscape`, `splitHtmlMessage`, `formatPct`. Those exist so the logic can be
tested without a bot, and every one of them is covered in
`test/telegram.test.ts`. The handler method on the class should then be thin:
gate, call the pure function, send.

State changes belong to their owner, not to the bot: sessions go through
`SessionManager`, permissions through `PermissionFlow`, dialogs through
`DialogFlow`, headless turns through `SdkDriver`, tmux through `TmuxClient`.
The bot is a transport. Adding session bookkeeping inside a handler is how the
daemon and the bot's idea of reality drift apart.

## 2. Register it

Registration lives in `register()`:

```ts
bot.command('usage', ctx => this.safe(ctx, 'usage', () => this.onUsage(ctx)));
```

`safe(...)` is not optional decoration — grammy stops the bot on the first
unhandled middleware error, which used to kill the daemon. Every handler goes
through it.

If the command takes arguments and you extend `parseCommand`, update its
`ParsedCommand` union and the `CONTROL_COMMANDS` set together; the parser is
also what decides which slash commands are *not* ours and get forwarded
verbatim to the active session. Forwarding is the default, so a typo'd command
name silently ends up pasted into someone's Claude session instead of erroring.

## 3. Gate it — this is the part that matters

Every handler that does anything at all starts with:

```ts
if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
```

- `authorize` enforces default-deny (`ALLOWED_USER_IDS` / `PAIRING_CODE`),
  refuses group/channel chats outright, and binds the notification chat.
- `requireArmed` enforces the `/rc` switch. **While disarmed the bot answers
  only `/rc`, `/help` and `/start`** — no streaming, no injection, no relay.
  That promise is made in the README, on the landing page, and in SECURITY.md.

The only commands that legitimately skip `requireArmed` are those three. If you
find yourself wanting a fourth, that's a design conversation with the user, not
a judgement call — the armed switch is the project's main safety story.

Inline button handlers (`callback_query`) need the same gates: see the
`isArmed()` check that answers the callback with "🔒 Remote control is off".
Bus subscriptions in `subscribeBus()` are gated too — each one returns early
when disarmed, and the streaming ones also check
`e.sessionId !== this.deps.manager.getActive()`.

## 4. Send the reply correctly

Always reply through `this.send(...)`, never `ctx.reply` directly. It routes
through `splitHtmlMessage` because Telegram rejects anything over 4096
characters and the send is wrapped in a `.catch` — a long reply sent raw
disappears without a trace. `SEND_MAX_CHARS` is 3800 to leave room for the
tags the splitter reopens across a cut.

Everything is sent with `parse_mode: 'HTML'`, and malformed markup is rejected
by Telegram (again, silently). So **escape every dynamic fragment** with
`htmlEscape()` before interpolating it — session titles, model names, file
paths, error strings, anything that came from outside. Only `b`, `i`, `code`,
`pre`, `a` are supported tags.

For fire-and-forget sends inside a synchronous path, use `this.track(promise,
'label')` so a rejection is logged instead of becoming an unhandled rejection.

Inline keyboards use `InlineKeyboard` with structured callback data — follow
the existing encode/decode helpers rather than string-concatenating; the
decoder throws `bad callback data` on anything it doesn't recognise, which is
what keeps a stale button from doing something unintended. Note that HTML
parse mode does **not** apply to button labels.

## 5. Update the four places the command list lives

This is where commands rot. A new or renamed command must appear in all of
them, in the same wording:

1. `setMyCommands([...])` in `start()` — the Telegram autocomplete menu.
2. The `/help` string in the `help` handler.
3. `README.md` → the Usage section.
4. `AI-GUIDE.md` → both the "Setup matrix" row (if a user would ask for it in
   words) and the "Command reference" list.

The landing page (`index.html`) only needs touching if it mentions the command
in prose — check with a grep for the command name before assuming it doesn't.

## 6. Test it

Add cases to `test/telegram.test.ts` (see the `writing-tests` skill for the
suite's conventions). At minimum:

- the pure parsing/formatting function, including the malformed input that a
  fat-fingered phone keyboard produces;
- the disarmed path — the command must do nothing and say so;
- the unauthorized path, if the command touches anything sensitive;
- escaping, if the reply interpolates anything user-controlled.

Then `npm run typecheck && npm test`.

## 7. Ship it

Follow the `shipping-a-change` skill: a `feat(bot):` or `fix(bot):` commit, a
`CHANGELOG.md` entry under `## [Unreleased]` written from the user's point of
view, and the docs updates from step 5 in the same commit as the code — a
commit that changes behaviour without its docs is what makes `/help` lie.
