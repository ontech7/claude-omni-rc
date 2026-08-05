# Fix UX Telegram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the seven Telegram UX problems (echo, question buttons/no-JSON, slash passthrough, interrupt, session history, session delete, approve/reject feedback) without regressing chat streaming or permissions.

**Architecture:** Pure helpers and new source functions get unit tests; the `TelegramBot` wiring (commands, callbacks, bus handlers) is implemented in `bot/telegram.ts` and verified with `npm run typecheck`, the existing test suite, and a manual checklist — matching the repo's convention of unit-testing only the pure/leaf functions.

**Tech Stack:** Node 22+, TypeScript (ESM), grammy (Telegram bot), vitest, Claude Agent SDK (pinned 0.3.221), tmux.

## Global Constraints

- Node >= 22, ESM (`"type": "module"`). Imports of local files must end in `.js` even for `.ts` sources.
- `npm run typecheck` (`tsc --noEmit`) and `npm test` (`vitest run`) must pass at the end of every task.
- Follow existing conventions: Italian comments, HTML-escaped dynamic fragments (`htmlEscape`) before interpolation, `.catch(() => {})` for optional Telegram sends.
- A staged-but-uncommitted change already exists in `bot/telegram.ts` (the `✅ Turn complete.` result-notification fix). Commits of that file will include it — expected, not an accident.
- Callback data is bounded (64 bytes); keep tokens short (a `randomUUID()` is fine).

---

### Task 1: `TmuxClient.sendKeys` (foundation for Fix 4)

**Files:**
- Modify: `src/sessions/tmux-inject.ts` (add method after `injectText`)
- Test: `test/tmux-inject.test.ts`

**Interfaces:**
- Produces: `TmuxClient.sendKeys(target: string, keys: string): Promise<void>` — sends raw keys (e.g. `'C-c'`) to the pane, resolving `target` like every other method. Throws on tmux error.

- [ ] **Step 1: Write the failing test**

Append to `test/tmux-inject.test.ts`:

```ts
it('sends keys to the pane (C-c interrupt)', async () => {
  const { exec, calls } = fakeExec([
    { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '$0 claude:proj\n' } },
    { call: ['send-keys', '-t', '$0', 'C-c'], result: { code: 0 } },
  ]);
  const tmux = new TmuxClient(exec);
  await tmux.sendKeys('claude:proj', 'C-c');
  expect(calls[1].args).toEqual(['send-keys', '-t', '$0', 'C-c']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tmux-inject.test.ts`
Expected: FAIL — `tmux.sendKeys is not a function`.

- [ ] **Step 3: Implement**

In `src/sessions/tmux-inject.ts`, after `injectText`, add:

```ts
// Invia tasti grezzi al pane (es. 'C-c' per interrompere la generazione come ESC).
async sendKeys(target: string, keys: string): Promise<void> {
  const t = await this.resolveTarget(target);
  const r = await this.exec(['send-keys', '-t', t, keys]);
  if (r.code !== 0) throw new Error(`tmux send-keys failed: ${r.stderr}`);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/tmux-inject.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/tmux-inject.ts test/tmux-inject.test.ts
git commit -m "feat: TmuxClient.sendKeys per interrompere la generazione (C-c)"
```

---

### Task 2: `readRecentMessages` + `resolveSessionTranscript` (foundation for Fix 5)

**Files:**
- Modify: `src/sessions/transcript.ts`
- Test: `test/transcript.test.ts`

**Interfaces:**
- Produces:
  - `interface RecentMessage { role: 'user' | 'assistant'; text: string }`
  - `readRecentMessages(file: string, max?: number): RecentMessage[]` — last `max` text messages, tools skipped, newest last.
  - `resolveSessionTranscript(projectsDir: string, projectDir: string, claudeSessionId?: string): string | undefined` — exact file by session id, else newest jsonl, else `undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `test/transcript.test.ts`:

```ts
describe('readRecentMessages / resolveSessionTranscript', () => {
  it('returns the last text messages, skipping tools and thinking', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, [
      userLine('primo'),
      textLine('m1', 'risposta 1', 'tool_use'),
      toolLine,
      textLine('m2', 'risposta 2', 'end_turn'),
      userLine('secondo'),
      textLine('m3', 'risposta 3', 'end_turn'),
    ].join('\n') + '\n');
    const msgs = readRecentMessages(file, 10);
    expect(msgs).toEqual([
      { role: 'user', text: 'primo' },
      { role: 'assistant', text: 'risposta 1' },
      { role: 'assistant', text: 'risposta 2' },
      { role: 'user', text: 'secondo' },
      { role: 'assistant', text: 'risposta 3' },
    ]);
  });
  it('respects max, keeping the newest messages', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, [userLine('a'), userLine('b'), userLine('c')].join('\n') + '\n');
    expect(readRecentMessages(file, 2)).toEqual([{ role: 'user', text: 'b' }, { role: 'user', text: 'c' }]);
  });
  it('returns [] for missing/empty files', () => {
    expect(readRecentMessages(join(tmpDir(), 'nope.jsonl'))).toEqual([]);
  });
  it('resolves by claudeSessionId, falling back to the newest file', () => {
    const base = tmpDir();
    const dir = join(base, mungedProjectDir('/Users/u/proj'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'abc.jsonl'), '');
    writeFileSync(join(dir, 'xyz.jsonl'), '');
    expect(resolveSessionTranscript(base, '/Users/u/proj', 'abc')).toBe(join(dir, 'abc.jsonl'));
    expect(resolveSessionTranscript(base, '/Users/u/proj')).toBe(join(dir, 'xyz.jsonl')); // più recente
    expect(resolveSessionTranscript(base, '/Users/u/other')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/transcript.test.ts`
Expected: FAIL — `readRecentMessages is not a function` / `resolveSessionTranscript is not a function`.

- [ ] **Step 3: Implement**

Add `readFileSync` to the existing `node:fs` import in `src/sessions/transcript.ts`, then append:

```ts
export interface RecentMessage { role: 'user' | 'assistant'; text: string }

// Storia retroattiva per il Fix 5: legge gli ultimi `max` messaggi testuali
// (user/assistant) dal transcript, saltando thinking e tool. Usata quando si
// seleziona una sessione e dal comando /history.
export function readRecentMessages(file: string, max = 10): RecentMessage[] {
  try {
    const out: RecentMessage[] = [];
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let d: { type?: string; message?: { content?: unknown } };
      try { d = JSON.parse(raw); } catch { continue; }
      if (d.type === 'assistant') {
        const blocks = Array.isArray(d.message?.content) ? d.message.content : [];
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue;
          const bb = b as { type?: string; text?: string };
          if (bb.type === 'text' && typeof bb.text === 'string' && bb.text.trim()) {
            out.push({ role: 'assistant', text: bb.text });
          }
        }
      } else if (d.type === 'user') {
        const c = d.message?.content;
        if (typeof c === 'string' && c.trim()) out.push({ role: 'user', text: c });
      }
    }
    return out.slice(-max);
  } catch {
    return [];
  }
}

// Risolve il file transcript di una sessione: quello esatto per claudeSessionId
// (le headless lo scrivono in ~/.claude/projects), altrimenti il più recente
// per il project dir (stessa logica del TranscriptWatcher).
export function resolveSessionTranscript(projectsDir: string, projectDir: string, claudeSessionId?: string): string | undefined {
  const dir = resolveTranscriptDir(projectsDir, projectDir);
  if (!dir) return undefined;
  if (claudeSessionId) {
    const p = join(dir, `${claudeSessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return newestTranscriptFile(dir);
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/transcript.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/transcript.ts test/transcript.test.ts
git commit -m "feat: leggi la storia recente dal transcript (readRecentMessages)"
```

---

### Task 3: Auto-allow `AskUserQuestion` in the API permission hook (Fix 2, terminal path)

**Files:**
- Modify: `src/api.ts:30-47` (the `/api/permission` handler)
- Test: `test/api.test.ts`

**Interfaces:**
- Produces: `/api/permission` with `toolName === 'AskUserQuestion'` responds `allow` immediately (no long-poll, no `session.permission` event).

- [ ] **Step 1: Write the failing test**

Append to `test/api.test.ts`:

```ts
it('auto-allows AskUserQuestion without a permission request', async () => {
  const { manager, api, bus } = makeApi();
  open.push(api);
  await api.ready;
  manager.setArmed(true);
  let permissionEvents = 0;
  bus.on('session.permission', () => { permissionEvents++; });
  const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toolName: 'AskUserQuestion', input: { questions: [{ question: 'x', options: [{ label: 'a' }] }] } }),
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('allow');
  expect(permissionEvents).toBe(0); // nessuna notifica di permesso
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/api.test.ts`
Expected: FAIL — the response is `deny` (after timeout) and `permissionEvents` is 1.

- [ ] **Step 3: Implement**

In `src/api.ts`, inside the `/api/permission` handler, right after `const toolName = input.toolName ?? 'tool';` (currently line 38), add:

```ts
// AskUserQuestion non è una richiesta di permesso: il CLI mostra il menu nel
// pane e la risposta arriva via tmux (bottoni della domanda). Auto-allow,
// niente JSON + Approve/Reject in chat.
if (toolName === 'AskUserQuestion') {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('allow');
  return;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/api.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts test/api.test.ts
git commit -m "fix: auto-allow AskUserQuestion nel permission hook (niente mega JSON)"
```

---

### Task 4: SDK driver — AskUserQuestion → prompt, auto-allow (Fix 2, headless path)

**Files:**
- Modify: `src/sessions/sdk-driver.ts` (imports, `canUseTool`, the `tool_use` loop)
- Test: `test/sdk-driver.test.ts`

**Interfaces:**
- Consumes: `parseAskUserQuestions(input: unknown): PromptQuestion[]` from `./transcript.js` (already exported).
- Produces:
  - `canUseTool('AskUserQuestion', …)` resolves `{ behavior: 'allow' }` without touching `permissionFlow`.
  - A `tool_use` block named `AskUserQuestion` emits `{ type: 'session.prompt', sessionId, questions }` instead of a `session.tool` bubble.

- [ ] **Step 1: Write the failing tests**

Append to `test/sdk-driver.test.ts`:

```ts
it('auto-allows AskUserQuestion in canUseTool without a permission request', async () => {
  const { sdk, session } = makeDriver();
  queryMock.mockImplementationOnce(async function* () { yield resultMsg(session.id, 'ok'); });
  await sdk.runTurn(session.id, 'x');
  const opts = queryMock.mock.calls[0][0].options;
  const decision = await opts.canUseTool('AskUserQuestion', { questions: [{ question: 'x', options: [{ label: 'a' }] }] }, {});
  expect(decision).toEqual({ behavior: 'allow' });
});

it('emits session.prompt for AskUserQuestion tool_use instead of a tool bubble', async () => {
  const { sdk, session, bus, events } = makeDriver();
  const prompts: unknown[] = [];
  bus.on('session.prompt', e => prompts.push(e));
  queryMock.mockImplementationOnce(async function* () {
    yield {
      type: 'assistant', uuid: 'u', session_id: session.id,
      message: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }] } }] },
      parent_tool_use_id: null,
    };
    yield resultMsg(session.id, 'ok');
  });
  await sdk.runTurn(session.id, 'x');
  expect(prompts).toHaveLength(1);
  expect((prompts[0] as any).questions[0].options).toHaveLength(2);
  const toolBubbles = events.filter(e => (e as any).type === 'session.tool' && (e as any).kind === 'tool_use');
  expect(toolBubbles).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sdk-driver.test.ts`
Expected: FAIL — the AskUserQuestion tool_use currently produces a `session.tool` bubble, and `canUseTool` routes through `permissionFlow` (no `prompt` events).

- [ ] **Step 3: Implement**

In `src/sessions/sdk-driver.ts`:

1. Add the import:
```ts
import { parseAskUserQuestions } from './transcript.js';
```

2. In the `query({...})` options, replace the `canUseTool` callback:
```ts
canUseTool: (toolName, input, opts) => {
  // AskUserQuestion: niente permesso — la risposta è la domanda stessa.
  if (toolName === 'AskUserQuestion') return Promise.resolve({ behavior: 'allow' });
  return permissionFlow.request(sessionId, toolName, input as Record<string, unknown>, opts.signal);
},
```

3. In the assistant-message loop, special-case the `tool_use` block (currently emits `session.tool` for every tool):
```ts
for (const block of msg.message.content) {
  if (block.type === 'tool_use') {
    if (block.name === 'AskUserQuestion') {
      // il menu a scelta multipla diventa una domanda ❓ con bottoni
      // (stesso percorso delle terminali), non una bubble di tool col JSON.
      const questions = parseAskUserQuestions(block.input);
      if (questions.length) bus.emit({ type: 'session.prompt', sessionId, questions });
      continue;
    }
    bus.emit({
      type: 'session.tool', sessionId, toolName: block.name, kind: 'tool_use',
      toolUseId: block.id, input: block.input as Record<string, unknown>,
    });
  }
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/sdk-driver.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/sdk-driver.ts test/sdk-driver.test.ts
git commit -m "fix: AskUserQuestion headless → session.prompt con auto-allow (niente JSON)"
```

---

### Task 5: Pure helpers in `bot/telegram.ts` (Fix 2/5/6/7 primitives)

**Files:**
- Modify: `bot/telegram.ts` (top section, pure helpers)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `PromptQuestion` from `../src/types.js`, `RecentMessage` from `../src/sessions/transcript.js`.
- Produces:
  - `interface CallbackData { action: 'approve'|'deny'|'select'|'answer'|'del'|'del-yes'|'del-no'; id: string; index?: number; questionIndex?: number }`
  - `parseCallbackData(data: string): CallbackData` (extended, backward-compatible).
  - `promptMessage(questions: PromptQuestion[]): string` — the `❓` header block.
  - `matchesInjected(recent: {text:string;at:number}[], text: string, now: number, windowMs?: number): boolean` — echo suppression matcher.
  - `renderHistory(messages: RecentMessage[], title: string, maxChars?: number): string` — the history block HTML.

- [ ] **Step 1: Write the failing tests**

Append to `test/telegram.test.ts` and extend the import on line 2:

```ts
import { parseCommand, parseCallbackData, permissionMessage, sessionListText, EditThrottler, attachmentPlan, stripAnsi, mdToHtml, relativeTime, ToolBurstAggregator, promptMessage, matchesInjected, renderHistory } from '../bot/telegram.js';
```

New tests:

```ts
describe('parseCallbackData extensions', () => {
  it('parses question answer callbacks', () => {
    expect(parseCallbackData('q:answer:tok1:0:2')).toEqual({ action: 'answer', id: 'tok1', questionIndex: 0, index: 2 });
  });
  it('parses delete callbacks', () => {
    expect(parseCallbackData('sess:del:abc')).toEqual({ action: 'del', id: 'abc' });
    expect(parseCallbackData('sess:del-yes:abc')).toEqual({ action: 'del-yes', id: 'abc' });
    expect(parseCallbackData('sess:del-no:abc')).toEqual({ action: 'del-no', id: 'abc' });
  });
});

describe('promptMessage', () => {
  it('renders the header with HTML escaping', () => {
    const qs = [{ header: 'Lens', question: 'Pick <one>?', options: [{ label: 'a' }] }];
    const out = promptMessage(qs);
    expect(out).toContain('Lens');
    expect(out).toContain('Pick &lt;one&gt;?');
  });
});

describe('matchesInjected', () => {
  it('matches recent injected text and ignores old or different text', () => {
    const now = 1_000_000;
    const recent = [{ text: 'ciao', at: now - 1_000 }, { text: 'vecchio', at: now - 61_000 }];
    expect(matchesInjected(recent, 'ciao', now)).toBe(true);
    expect(matchesInjected(recent, '  ciao  ', now)).toBe(true); // trim
    expect(matchesInjected(recent, 'vecchio', now)).toBe(false);  // fuori finestra
    expect(matchesInjected(recent, 'altro', now)).toBe(false);
  });
});

describe('renderHistory', () => {
  it('renders messages with role icons and markdown', () => {
    const html = renderHistory([{ role: 'user', text: 'ciao' }, { role: 'assistant', text: '**ok**' }], 'proj');
    expect(html).toContain('🧑 ciao');
    expect(html).toContain('<b>ok</b>');
    expect(html).toContain('proj');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — new imports/parsing/renderers don't exist yet.

- [ ] **Step 3: Implement**

In `bot/telegram.ts`:

1. Add to the imports at the top:
```ts
import type { PromptQuestion } from '../src/types.js';
import type { RecentMessage } from '../src/sessions/transcript.js';
```

2. Replace the `parseCallbackData` function (and its return type) with:

```ts
export interface CallbackData {
  action: 'approve' | 'deny' | 'select' | 'answer' | 'del' | 'del-yes' | 'del-no';
  id: string;
  index?: number;        // per 'answer': indice opzione
  questionIndex?: number; // per 'answer': indice domanda
}

export function parseCallbackData(data: string): CallbackData {
  const parts = data.split(':');
  if (parts.length === 3) {
    const [ns, action, id] = parts;
    if (ns === 'perm' && (action === 'approve' || action === 'deny') && id) return { action, id };
    if (ns === 'sess' && action === 'select' && id) return { action: 'select', id };
    if (ns === 'sess' && action === 'del' && id) return { action: 'del', id };
    if (ns === 'sess' && (action === 'del-yes' || action === 'del-no') && id) return { action, id };
  }
  if (parts.length === 5) {
    const [ns, action, token, q, o] = parts;
    if (ns === 'q' && action === 'answer' && token && /^\d+$/.test(q) && /^\d+$/.test(o)) {
      return { action: 'answer', id: token, questionIndex: Number(q), index: Number(o) };
    }
  }
  throw new Error(`bad callback data: ${data}`);
}
```

3. Add these pure helpers after `permissionMessage`:

```ts
// Intestazione della domanda a scelta multipla (le opzioni diventano bottoni).
export function promptMessage(questions: PromptQuestion[]): string {
  return questions
    .map(q => {
      const title = q.header ? `${q.header}: ${q.question}` : q.question;
      return `❓ <b>${htmlEscape(title)}</b>`;
    })
    .join('\n\n');
}

// Matcher per il Fix 1: sopprime l'echo di un testo che il bot ha appena
// iniettato nel pane (l'utente lo vede già). Confronto trim, finestra 60s.
export function matchesInjected(recent: { text: string; at: number }[], text: string, now: number, windowMs = 60_000): boolean {
  const t = text.trim();
  return recent.some(item => now - item.at <= windowMs && item.text.trim() === t);
}

// Blocco di storia per il Fix 5: gli ultimi messaggi renderizzati come chat.
export function renderHistory(messages: RecentMessage[], title: string, maxChars = 3000): string {
  const body = messages.map(m => `${m.role === 'user' ? '🧑' : '🤖'} ${mdToHtml(m.text)}`).join('\n\n');
  return `<b>Last messages · ${htmlEscape(title)}</b>\n\n${body.slice(0, maxChars)}`;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/telegram.test.ts && npm run typecheck`
Expected: all PASS (including the pre-existing `parseCallbackData` tests — the new object shapes omit the optional fields, so `toEqual` still matches).

- [ ] **Step 5: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat: helper puri per domande-bottoni, storia, echo e delete callbacks"
```

---

### Task 6: Bot wiring — commands & message routing (Fixes 3, 4, 5, 6)

**Files:**
- Modify: `bot/telegram.ts`

**Interfaces:**
- Consumes: `TmuxClient.sendKeys` (Task 1), `readRecentMessages` + `resolveSessionTranscript` (Task 2), `renderHistory` + `matchesInjected` (Task 5).
- Produces: new private methods/fields used by Task 7:
  - fields `recentInjected`, `pendingPrompts`
  - `recordInjected(sessionId: string, text: string): void`
  - `isInjectedEcho(sessionId: string, text: string): boolean`
  - `readHistory(sessionId: string): Promise<string | undefined>`
  - `deleteSession(id: string): boolean`

- [ ] **Step 1: Add fields + register the new commands**

In `bot/telegram.ts` class `TelegramBot`, add two fields next to `private toolBursts`:

```ts
private recentInjected = new Map<string, { text: string; at: number }[]>();
private pendingPrompts = new Map<string, { sessionId: string; questions: PromptQuestion[]; text: string }>();
```

In `register()`, after `bot.command('attach', ...)`, add:

```ts
bot.command('history', ctx => this.onHistory(ctx));
bot.command('delete', ctx => this.onDelete(ctx));
```

In `start()`, extend `setMyCommands`:

```ts
{ command: 'history', description: 'Show the last messages of a session' },
{ command: 'delete', description: 'Delete a session' },
```

- [ ] **Step 2: Fix 3 — forward unknown slash commands**

Replace the body of `onMessage` (currently drops everything starting with `/`):

```ts
private async onMessage(ctx: Context): Promise<void> {
  if (!this.authorize(ctx)) return;
  if (!ctx.message) return;
  const text = ctx.message.text ?? '';
  if (!this.deps.manager.isArmed()) { await this.send(ctx, '🔒 Remote control is off. Send /rc on.'); return; }
  // I comandi del bot sono già gestiti da grammy (bot.command). Quelli che
  // arrivano qui (slash command di Claude: /clear, /compact, /exit,
  // /frontend-release, …) vengono inoltrati alla sessione attiva, slash incluso.
  await this.routeMessageToSession(ctx, text);
}
```

- [ ] **Step 3: Fix 4 — `/stop` interrupts terminal sessions too**

Replace `onStop`:

```ts
private async onStop(ctx: Context): Promise<void> {
  if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
  const s = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : undefined;
  if (!s) { await this.send(ctx, 'No active session.'); return; }
  if (s.kind === 'headless') {
    this.deps.permissionFlow.cancelAllForSession(s.id);
    this.deps.sdk.stop(s.id); // abort del turno in corso
    await this.send(ctx, '🛑 Stop requested for the active session.');
  } else if (s.tmuxTarget) {
    try {
      await this.deps.tmux.sendKeys(s.tmuxTarget, 'C-c');
      await this.send(ctx, `🛑 Ctrl+C sent to <code>${htmlEscape(s.tmuxTarget)}</code> — generation interrupted.`);
    } catch (e) {
      await this.send(ctx, `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
    }
  } else {
    await this.send(ctx, 'This terminal session has no tmux pane to interrupt.');
  }
}
```

- [ ] **Step 4: Fix 5 — `/history` command + shared history reader**

Add to `bot/telegram.ts`:

```ts
private async onHistory(ctx: Context): Promise<void> {
  if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
  const id = ctx.match?.toString().trim() || this.activeSessionId;
  if (!id) { await this.send(ctx, 'No active session. Select one with /sessions.'); return; }
  const hist = await this.readHistory(id);
  if (!hist) { await this.send(ctx, 'No transcript available for this session yet.'); return; }
  await this.send(ctx, hist);
}

private async readHistory(sessionId: string): Promise<string | undefined> {
  const s = this.deps.manager.get(sessionId);
  if (!s) return undefined;
  const file = s.transcriptFile
    ?? resolveSessionTranscript(this.deps.config.projectsDir, s.projectDir, s.kind === 'headless' ? s.claudeSessionId : undefined);
  if (!file) return undefined;
  const msgs = readRecentMessages(file, 10);
  if (!msgs.length) return undefined;
  return renderHistory(msgs, s.title || s.id.slice(0, 8));
}
```

Add the import for the two transcript functions at the top of `bot/telegram.ts`:

```ts
import { readRecentMessages, resolveSessionTranscript } from '../src/sessions/transcript.js';
```

- [ ] **Step 5: Fix 6 — `/delete` command + shared delete helper**

Add to `bot/telegram.ts`:

```ts
private async onDelete(ctx: Context): Promise<void> {
  if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
  const id = ctx.match?.toString().trim() || this.activeSessionId;
  if (!id) { await this.send(ctx, 'Usage: /delete [session id]'); return; }
  const s = this.deps.manager.get(id);
  if (!s) { await this.send(ctx, 'Session not found.'); return; }
  const kb = new InlineKeyboard()
    .text('✓ Yes, delete', `sess:del-yes:${s.id}`)
    .text('✗ No', `sess:del-no:${s.id}`);
  await ctx.reply(`Delete session <b>${htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}]?`, {
    parse_mode: 'HTML', reply_markup: kb,
  });
}

private deleteSession(id: string): boolean {
  this.deps.permissionFlow.cancelAllForSession(id);
  this.deps.sdk.stop(id); // abort del turno headless in corso
  const ok = this.deps.manager.remove(id);
  if (ok) this.deps.manager.persist();
  return ok;
}
```

- [ ] **Step 6: Fix 1 — record injected texts + echo matcher**

In `routeMessageToSession`, after the terminal inject, record the text:

```ts
} else {
  if (!session.tmuxTarget) {
    await this.send(ctx, 'This session is not running in tmux, so text can’t be injected. Start it with:\n<code>tmux new -s claude:&lt;project&gt;</code>');
    return;
  }
  await this.deps.tmux.injectText(session.tmuxTarget, text);
  this.recordInjected(session.id, text);
}
```

Add the two methods:

```ts
private recordInjected(sessionId: string, text: string): void {
  const list = this.recentInjected.get(sessionId) ?? [];
  list.push({ text, at: Date.now() });
  if (list.length > 5) list.shift();
  this.recentInjected.set(sessionId, list);
}

private isInjectedEcho(sessionId: string, text: string): boolean {
  return matchesInjected(this.recentInjected.get(sessionId) ?? [], text, Date.now());
}
```

- [ ] **Step 7: Update `/help` text**

Replace the `help` command handler body:

```ts
bot.command('help', ctx => { if (this.authorize(ctx)) this.send(ctx, 'Commands: /rc on|off|status · /sessions · /view · /new &lt;text&gt; · /stop · /status · /attach &lt;project&gt; · /history [id] · /delete [id] · /help'); });
```

- [ ] **Step 8: Verify**

Run: `npm run typecheck && npm test`
Expected: all PASS. Manual checklist (live daemon):
- Send `/frontend-release` to a terminal session → appears in the pane.
- `/stop` on a terminal session → `Ctrl+C sent …` and generation stops.
- `/history` → shows last messages; `/delete` → shows the confirm buttons (answering them is wired in Task 7).

- [ ] **Step 9: Commit**

```bash
git add bot/telegram.ts
git commit -m "feat: slash passthrough, /stop per terminali, /history, /delete"
```

---

### Task 7: Bot wiring — callbacks & bus handlers (Fixes 1, 2, 5, 6, 7)

**Files:**
- Modify: `bot/telegram.ts`

**Interfaces:**
- Consumes: `CallbackData` + `parseCallbackData` (Task 5), `promptMessage` (Task 5), `readHistory`/`recordInjected`/`isInjectedEcho`/`deleteSession`/`pendingPrompts` (Task 6).
- Produces: no new public surface.

- [ ] **Step 1: Fix 7 — approve/reject edit the message**

Add this method to `TelegramBot`:

```ts
// Feedback persistente (Fix 7): sostituisce i bottoni con l'esito della decisione.
private async editCallbackDecision(ctx: Context, header: string): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  if (!msg || !('text' in msg)) return;
  await ctx.editMessageText(`${header}\n\n${msg.text}`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard(), // svuota i bottoni
  }).catch(() => {});
}
```

- [ ] **Step 2: Fix 2 — answer a question via button**

Add to `TelegramBot`:

```ts
// Risponde a una domanda a scelta multipla: inietta l'etichetta nel pane
// (terminali) o la invia come testo (headless, best-effort). Il messaggio
// viene modificato per mostrare la risposta scelta.
private async answerPrompt(ctx: Context, parsed: CallbackData): Promise<void> {
  const pending = this.pendingPrompts.get(parsed.id);
  if (!pending) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
  const q = pending.questions[parsed.questionIndex ?? 0];
  const opt = q?.options[parsed.index ?? 0];
  if (!q || !opt) { await ctx.answerCallbackQuery({ text: 'Invalid option' }); return; }
  const s = this.deps.manager.get(pending.sessionId);
  if (!s) { await ctx.answerCallbackQuery({ text: 'Session gone' }); return; }
  this.pendingPrompts.delete(parsed.id);
  let toast = `✓ ${opt.label}`;
  try {
    if (s.kind === 'terminal' && s.tmuxTarget) {
      await this.deps.tmux.injectText(s.tmuxTarget, opt.label);
      this.recordInjected(s.id, opt.label);
    } else if (s.kind === 'headless') {
      if (this.deps.sdk.isBusy(s.id)) {
        toast = '⏳ Session busy — reply by text';
      } else {
        void this.deps.sdk.runTurn(s.id, opt.label);
      }
    }
  } catch (e) {
    toast = `⚠️ ${e instanceof Error ? e.message : String(e)}`;
  }
  await ctx.answerCallbackQuery({ text: toast });
  const ack = `${pending.text}\n\n✅ <b>Risposta:</b> ${htmlEscape(opt.label)}`;
  await ctx.editMessageText(ack, { parse_mode: 'HTML', reply_markup: new InlineKeyboard() }).catch(() => {});
}
```

- [ ] **Step 3: Rewrite `onCallback` to use the new actions**

Replace the whole `onCallback` body:

```ts
private async onCallback(ctx: Context): Promise<void> {
  if (!this.authorize(ctx)) return;
  if (!this.deps.manager.isArmed()) { await ctx.answerCallbackQuery({ text: '🔒 Remote control is off' }); return; }
  const data = ctx.callbackQuery?.data ?? '';
  try {
    const parsed = parseCallbackData(data);
    switch (parsed.action) {
      case 'approve': {
        const ok = this.deps.permissionFlow.approve(parsed.id);
        await ctx.answerCallbackQuery({ text: ok ? '✓ Approved' : 'Already resolved' });
        if (ok) await this.editCallbackDecision(ctx, '✅ <b>Approved</b>');
        break;
      }
      case 'deny': {
        const ok = this.deps.permissionFlow.deny(parsed.id);
        await ctx.answerCallbackQuery({ text: ok ? '✗ Rejected' : 'Already resolved' });
        if (ok) await this.editCallbackDecision(ctx, '❌ <b>Rejected</b>');
        break;
      }
      case 'select': {
        const s = this.deps.manager.get(parsed.id);
        if (s) this.activeSessionId = s.id;
        await ctx.answerCallbackQuery({ text: 'Session selected' });
        await ctx.editMessageText(sessionListText(this.deps.manager.list(), this.activeSessionId), { parse_mode: 'HTML' });
        // Fix 5: mostra la storia recente della sessione appena selezionata.
        const hist = await this.readHistory(parsed.id);
        if (hist && this.chatId) void this.bot.api.sendMessage(this.chatId, hist, { parse_mode: 'HTML' }).catch(() => {});
        break;
      }
      case 'answer': {
        await this.answerPrompt(ctx, parsed);
        break;
      }
      case 'del': {
        const s = this.deps.manager.get(parsed.id);
        if (!s) { await ctx.answerCallbackQuery({ text: 'Session not found' }); return; }
        await ctx.answerCallbackQuery({ text: 'Confirm?' });
        const kb = new InlineKeyboard()
          .text('✓ Yes, delete', `sess:del-yes:${s.id}`)
          .text('✗ No', `sess:del-no:${s.id}`);
        await ctx.reply(`Delete session <b>${htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}]?`, {
          parse_mode: 'HTML', reply_markup: kb,
        }).catch(() => {});
        break;
      }
      case 'del-yes': {
        const ok = this.deleteSession(parsed.id);
        await ctx.answerCallbackQuery({ text: ok ? '🗑 Deleted' : 'Already deleted' });
        await ctx.editMessageText(ok ? '🗑 Session deleted.' : 'Session already gone.', { parse_mode: 'HTML' }).catch(() => {});
        if (this.activeSessionId === parsed.id) this.activeSessionId = undefined;
        break;
      }
      case 'del-no': {
        await ctx.answerCallbackQuery({ text: 'Cancelled' });
        await ctx.editMessageText('Delete cancelled.', { parse_mode: 'HTML' }).catch(() => {});
        break;
      }
    }
  } catch {
    await ctx.answerCallbackQuery({ text: 'Invalid data' });
  }
}
```

- [ ] **Step 4: Fix 2 — render `session.prompt` as buttons**

Replace the `session.prompt` handler in `subscribeBus`:

```ts
bus.on('session.prompt', ({ sessionId, questions }) => {
  if (!this.deps.manager.isArmed()) return;
  if (sessionId !== this.activeSessionId) return;
  this.toolBurst(sessionId).close();
  const token = randomUUID();
  this.pendingPrompts.set(token, { sessionId, questions, text: promptMessage(questions) });
  const kb = new InlineKeyboard();
  questions.forEach((q, qi) => q.options.forEach((o, oi) => {
    kb.text(htmlEscape(o.label.slice(0, 24)), `q:answer:${token}:${qi}:${oi}`).row();
  }));
  const hint = '\n\n<i>Tocca un\'opzione o rispondi con il numero.</i>';
  if (this.chatId) {
    void this.bot.api.sendMessage(this.chatId, promptMessage(questions) + hint, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
  }
});
```

Add the `randomUUID` import at the top of `bot/telegram.ts`:

```ts
import { randomUUID } from 'node:crypto';
```

- [ ] **Step 5: Fix 1 — suppress injected echoes in the text handler**

Replace the `session.text` handler in `subscribeBus`:

```ts
bus.on('session.text', e => {
  if (!this.deps.manager.isArmed()) return;
  if (e.sessionId !== this.activeSessionId) return;
  this.toolBurst(e.sessionId).close(); // il testo chiude la raffica di tool
  // Fix 1: l'echo di un testo iniettato dal bot non viene reinoltrato.
  if (e.role === 'user' && this.isInjectedEcho(e.sessionId, e.text)) return;
  // sia le headless che i transcript delle terminali arrivano come markdown.
  void this.forwardText(e.sessionId, mdToHtml(e.text), e.role);
});
```

- [ ] **Step 6: Fix 6 — 🗑 button in the `/sessions` list**

Replace the keyboard construction in `onSessions`:

```ts
const kb = new InlineKeyboard();
for (const s of list) kb.text(s.id.slice(0, 6), `sess:select:${s.id}`).text('🗑', `sess:del:${s.id}`).row();
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`
Expected: all PASS. Manual checklist (live daemon):
- AskUserQuestion (terminal): `❓` message with one button per option, no JSON permission; tapping injects the option into the pane and edits the message to show the answer.
- Approve/Reject a permission: message edited to `✅ Approved` / `❌ Rejected`, buttons gone.
- Selecting a session: last messages appear.
- `/sessions`: each row has a 🗑; tapping it asks confirm; Yes deletes, No cancels.
- Send a message to a terminal session: no echo of your own text.

- [ ] **Step 8: Commit**

```bash
git add bot/telegram.ts
git commit -m "feat: bottoni domande + ack, edit approve/reject, storia su select, delete confermato, echo soppresso"
```

---

### Task 8: Docs, CHANGELOG and final verification

**Files:**
- Modify: `README.md` (command table + Remote permissions/usage), `AI-GUIDE.md` (command reference), `CHANGELOG.md`, `bot/telegram.ts` only if `/help` text needs a touch.

- [ ] **Step 1: Update the command docs**

In `README.md`:
- In the "Usage" command table add:
  - `| /history [id] | show the last messages of a session (default: active) |`
  - `| /delete [id] | delete a session (headless: stops it; terminal: untracks only) |`
- Under "Remote permissions" add a line: AskUserQuestion is auto-allowed; the question appears with one button per option; tapping injects the answer into the terminal session. Plain slash commands not owned by the bot (e.g. `/clear`, `/compact`, `/exit`) are forwarded to the active session.

In `AI-GUIDE.md` command reference, add the two commands and the slash-passthrough note.

In `CHANGELOG.md` add an entry (feature/fix lines for all seven fixes).

- [ ] **Step 2: Final verification**

Run: `npm run typecheck && npm test`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md AI-GUIDE.md CHANGELOG.md
git commit -m "docs: /history, /delete, slash passthrough, bottoni domande, echo fix"
```

---

## Self-review notes

- Fix 1 → Task 6 (recordInjected) + Task 7 (suppression in `session.text`).
- Fix 2 → Task 3 (api auto-allow), Task 4 (sdk prompt + auto-allow), Task 5 (`promptMessage`/callback parsing), Task 7 (buttons + `answerPrompt`).
- Fix 3 → Task 6 (`onMessage`).
- Fix 4 → Task 1 (`sendKeys`) + Task 6 (`onStop`).
- Fix 5 → Task 2 (`readRecentMessages`/`resolveSessionTranscript`), Task 5 (`renderHistory`), Task 6 (`/history` + `readHistory`), Task 7 (history on select).
- Fix 6 → Task 5 (callback parsing), Task 6 (`/delete` + `deleteSession`), Task 7 (`del`/`del-yes`/`del-no` + 🗑 row).
- Fix 7 → Task 5 (callback parsing), Task 7 (`editCallbackDecision`).
- Open items from the spec (§6) remain verification steps, not blockers: the non-interactive CLI behavior of auto-allowed `AskUserQuestion` (headless) and the headless transcript filename shape for `resolveSessionTranscript` — both have safe fallbacks (busy toast / newest-file fallback).

