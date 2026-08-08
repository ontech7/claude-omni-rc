---
name: writing-tests
description: How to write and run tests for claude-omni-rc with Vitest — file layout, the pure-helper + injected-dependency pattern, fake timers for the timeout/polling code, and what must never touch a test (real Telegram, real tmux, real Ollama, the real home directory). Use this skill whenever you add or change a test in test/, whenever you add behaviour to src/ or bot/ that needs covering, when a test is flaky or hangs, and when the user says "write a test", "add coverage", "the tests fail", "cover this case". Every change to this repo ships behind `npm test`, so read this before writing the first `it(...)`.
---

# Writing tests

The test suite is the only automated gate this project has. CI runs exactly
`npm run typecheck` then `npm test` (`.github/workflows/ci.yml`) on Node 22 —
there is no linter, no formatter, no coverage threshold, no e2e run. Whatever
the suite doesn't catch reaches a daemon that has shell access to the user's
machine. That asymmetry is why tests here aim at *consequences*, not at
line coverage.

## Layout and imports

- One file per module, mirroring the source: `src/permissions.ts` →
  `test/permissions.test.ts`, `src/sessions/manager.ts` →
  `test/manager.test.ts` (the `sessions/` subdirectory is flattened),
  `bot/telegram.ts` → `test/telegram.test.ts`. `vitest.config.ts` only picks up
  `test/**/*.test.ts`, so a test outside `test/` silently never runs.
- Imports carry the **`.js` extension** even though the sources are `.ts`:
  `import { Bus } from '../src/bus.js'`. The project is ESM
  (`"type": "module"`) with `moduleResolution: "bundler"` — dropping the
  extension works in some tools and not others, so match the existing style.
- Import only from `vitest` (`describe`, `it`, `expect`, `vi`, and the
  `beforeEach`/`afterEach` hooks). There is no test-utils package, no mocking
  library, no snapshot usage — don't introduce one for a single test.

## Make the unit testable instead of mocking the world

The codebase is already shaped for this, and the shape is worth preserving:

**Pure functions are exported for their tests.** `parseCommand`,
`parseNewFlags`, `htmlEscape`, `splitHtmlMessage`, `formatPct`,
`formatResetAt` are exported from `bot/telegram.ts` precisely so the parsing
and formatting logic can be tested without a bot. When you add logic that can
be expressed as input → output, put it in a top-level exported function and
test it directly. That is worth far more than a test that drives it through
five layers.

**Everything else takes its dependencies in the constructor.** `PermissionFlow`
takes `{ bus, config, setStatus, canNotify }`, `SessionManager` takes
`{ bus, state, idleGraceMs, armedOnStart }`, `TmuxWatcher` takes
`{ config, manager, tmux }`. Tests pass `vi.fn()` spies and a real `Bus` — the
bus is 19 lines and synchronous, so use the real one and assert on emitted
events rather than mocking it.

**Config comes from `loadConfig({...})`, never `process.env`.** `loadConfig`
accepts an env object, so a test builds exactly the config it needs:
`loadConfig({ PERMISSION_TIMEOUT_SECONDS: '120' })`. Mutating `process.env` in
a test leaks into every test that runs after it.

A typical setup is a small local factory rather than `beforeEach` state — see
`makeFlow()` at the top of `test/permissions.test.ts`. It keeps each `it`
independent, which is what makes the suite safe to run in any order.

## Nothing real, ever

A test must not touch anything outside the process. Concretely: no Telegram API
call, no `tmux` invocation, no Ollama or `fetch` to a live host, no writes to
`~/.claude-omni-rc` or `~/.claude`. Inject the seam instead — `TmuxClient` and
`createShExec` exist so a fake exec can be passed in, `OllamaClient` takes a
`baseUrl` and its `fetch`, `StateStore` takes a path. When a test genuinely
needs the filesystem (state persistence, transcript parsing), write into a
unique temp directory under `os.tmpdir()` and remove it in `afterEach`; a test
that writes to the real `STATE_DIR` will eat the developer's actual sessions.

The daemon test (`test/daemon.test.ts`) shows the pattern for the top level:
`createDaemon` accepts an injected bot (`overrides.bot`) so the whole wiring can
be started and stopped without a network.

## Time is the main source of flakiness

Half this codebase is timers: permission timeouts, the idle-grace reaper, the
tmux poll loop, the transcript watcher, throttled Telegram sends, the daily
update check. Never wait on real time — no `await new Promise(r =>
setTimeout(r, 50))`, no arbitrary sleeps. That is exactly how a suite starts
passing locally and failing on a slower CI runner.

Use fake timers, and restore them in a `finally` so one failing assertion
doesn't leave the rest of the file frozen:

```ts
it('times out to deny once armed', async () => {
  vi.useFakeTimers();
  try {
    const { flow, onPerm } = makeFlow(120);
    const p = flow.request('s1', 'Bash', {});
    flow.arm(onPerm.mock.calls[0][0].permission.id);
    vi.advanceTimersByTime(120_000);
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Timeout 120s' });
  } finally { vi.useRealTimers(); }
});
```

Two details that matter with promises under fake timers: use
`await vi.advanceTimersByTimeAsync(0)` to let already-resolved microtasks run
before asserting a promise has *not* settled, and always assert on the resolved
value rather than on "it didn't throw".

## What to actually assert

Aim at the behaviour a user would notice, and at the failure modes this project
has already been bitten by — the CHANGELOG is a list of them:

- **The safe default under every failure.** An unanswered permission denies; a
  missing notification target denies immediately instead of hanging; an
  unknown dialog kind answers `cancelled`; a disarmed daemon relays nothing.
  When you add a branch, add the test for the branch that protects the user.
- **The boundaries that bit us before.** Long Telegram messages get split
  (4096-char limit) with tags reopened; dynamic text is HTML-escaped before
  interpolation; `state.json` is written atomically and a corrupt one is
  preserved, not overwritten.
- **Idempotence and double-resolution.** `approve` on an already-resolved
  request returns `false`; `arm` after resolution creates no phantom timer.
  Async code that can be triggered twice should be tested twice.

Write the assertion so the failure message tells you what broke —
`expect(decision).toEqual({ behavior: 'deny', message: 'Timeout 120s' })` beats
`expect(decision.behavior).toBe('deny')`, because the second one still passes
when the reason silently changes.

Short inline comments explaining *why* an assertion exists are welcome and
already present in the suite (`// already resolved`, `// nobody would read the
notification`). They're the cheapest defence against someone "fixing" a test by
deleting it. Write them in English, even where the surrounding file still has
older Italian ones.

## Running

```bash
npm test              # vitest run — what CI runs
npx vitest run test/permissions.test.ts   # one file, while iterating
npx vitest            # watch mode
npm run typecheck     # tsc --noEmit; CI runs this first, so run it too
```

`tsconfig.json` includes `test`, and `strict` is on: a type error in a test
fails CI just like one in `src`. Don't reach for `as any` to get past it —
if the type is hard to satisfy in a test, the production signature is usually
the thing that wants fixing.

Before you call a change done: the full suite green, `typecheck` green, and
the new test actually failing when you revert the fix. A test that passes
against the broken code is worse than no test, because it will be trusted.
