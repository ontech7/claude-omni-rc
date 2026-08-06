# Stabilizzazione del remote control — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere il remote control Telegram affidabile: nessun errore in un handler può più uccidere il daemon o far sparire un messaggio; `/stop` risponde con lo stato reale; le scelte multiple mostrano le opzioni per intero; ogni chiamata esterna è limitata da un timeout.

**Architecture:** Error containment a più strati (`bot.catch` globale, wrapper `safe()` sugli handler, `track()` per i fire-and-forget, guardia `unhandledRejection`), timeout su Telegram/tmux/Ollama, e correzioni puntuali (feedback reale su `/stop`, testo completo nelle scelte multiple, `mdToHtml` corretto con balance pass, `renderHistory` che taglia per messaggi interi, `activeSessionId` persistito nel manager). Helper puri testati; il wiring del bot è verificato da typecheck + suite esistente + checklist manuale (convenzione del repo).

**Tech Stack:** Node 22+, TypeScript (ESM), grammy (Telegram bot), vitest, tmux.

## Global Constraints

- Node >= 22, ESM (`"type": "module"`). Import di file locali con estensione `.js` anche per sorgenti `.ts`.
- `npm run typecheck` (`tsc --noEmit`) e `npm test` (`vitest run`) verdi alla fine di ogni task.
- Convenzioni del repo: commenti in italiano, frammenti dinamici html-escapati (`htmlEscape`) prima dell'interpolazione, `.catch()` funzionali mantenuti dove l'errore fa parte della logica (es. fallback edit→send).
- Convenzione test: si testano solo helper puri/leaf (vedi `test/telegram.test.ts`); il wiring di `TelegramBot` è verificato da typecheck + test esistenti + checklist manuale.
- Spec di riferimento: `docs/superpowers/specs/2026-08-06-stability-hardening-design.md`.
- I messaggi del bot sono in inglese (vedi CHANGELOG 0.1.0).

---

### Task 1: `mdToHtml` v2 + `balanceHtml` (markup corretto, mai messaggi persi)

**Files:**
- Modify: `bot/telegram.ts` (funzione `mdToHtml` esistente, righe ~89-99, e helper nuovi dopo di essa)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Produces:
  - `mdToHtml(text: string): string` — invariata la firma, nuova implementazione.
  - `balanceHtml(html: string): string` — chiude i tag aperti a fine stringa (LIFO) e scarta le chiusure orfane; l'output è sempre HTML bilanciato.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` to `test/telegram.test.ts`. Extend the import on line 2 to include `balanceHtml`:

```ts
import { parseCommand, parseCallbackData, permissionMessage, sessionListText, EditThrottler, attachmentPlan, stripAnsi, mdToHtml, relativeTime, ToolBurstAggregator, promptMessage, matchesInjected, renderHistory, balanceHtml } from '../bot/telegram.js';
```

```ts
describe('mdToHtml v2 / balanceHtml', () => {
  it('renders bold, italic and nested ***both***', () => {
    expect(mdToHtml('**bold** and *it*')).toBe('<b>bold</b> and <i>it</i>');
    expect(mdToHtml('***both***')).toBe('<b><i>both</i></b>');
  });
  it('protects code blocks and inline code from formatting', () => {
    expect(mdToHtml('`**code**`')).toBe('<code>**code**</code>');
    expect(mdToHtml('```js\n# h\n**x**\n```')).toBe('<pre>js\n# h\n**x**\n</pre>');
  });
  it('converts headings outside code to bold', () => {
    expect(mdToHtml('# not a heading')).toBe('<b>not a heading</b>');
  });
  it('leaves unclosed markers literal (no unbalanced HTML)', () => {
    expect(mdToHtml('**unclosed')).toBe('**unclosed');
  });
  it('escapes raw HTML and renders links', () => {
    expect(mdToHtml('<b>')).toBe('&lt;b&gt;');
    expect(mdToHtml('[t](https://x.com)')).toBe('<a href="https://x.com">t</a>');
  });
  it('balanceHtml closes unclosed tags, drops orphan closes, keeps valid HTML', () => {
    expect(balanceHtml('<b>a')).toBe('<b>a</b>');
    expect(balanceHtml('<b><i>x</b>')).toBe('<b><i>x</i></b>');
    expect(balanceHtml('x</i>y')).toBe('xy');
    expect(balanceHtml('<b>ok</b>')).toBe('<b>ok</b>');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — `mdToHtml('***both***')` non rende il nesting, il codice dentro `<pre>` viene formattato, e `balanceHtml` non esiste.

- [ ] **Step 3: Implement**

Replace the `mdToHtml` function and add `balanceHtml` after it:

```ts
// Rende il markdown del modello in HTML per Telegram, correggendo il markup:
// blocchi di codice protetti (niente formattazione dentro <pre>/<code>), nesting
// grassetto/corsivo gestito, e passata finale di bilanciamento → l'output è
// sempre HTML valido accettato da Telegram (mai un messaggio scartato).
export function mdToHtml(text: string): string {
  const blocks: string[] = [];
  // Separatore per i placeholder del codice: un NUL non compare mai nel testo
  // del modello, quindi il ripristino non può corrompere il contenuto.
  const P = String.fromCharCode(0);
  const protect = (c: string, kind: 'pre' | 'code'): string => {
    const idx = blocks.length;
    blocks.push(kind === 'pre' ? `<pre>${c}</pre>` : `<code>${c}</code>`);
    return `${P}${idx}${P}`;
  };
  let out = htmlEscape(text);
  out = out.replace(/```([\s\S]*?)```/g, (_m, c) => protect(c, 'pre'));
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => protect(c, 'code'));
  out = out
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>');
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  out = out.replace(/^[-*]\s+(.+)$/gm, '• $1');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(new RegExp(`${P}([0-9]+)${P}`, 'g'), (_m, i) => blocks[Number(i)]);
  return balanceHtml(out);
}

// Chiude i tag ancora aperti a fine stringa (LIFO) e scarta le chiusure orfane:
// il risultato è sempre HTML bilanciato. Garanzia che Telegram non rigetti mai
// un messaggio per markup malformato.
export function balanceHtml(html: string): string {
  const stack: string[] = [];
  let out = '';
  let last = 0;
  const re = /<\/?(b|i|code|pre|a)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out += html.slice(last, m.index);
    const full = m[0];
    const tag = m[1];
    if (full.startsWith('</')) {
      const idx = stack.lastIndexOf(tag);
      if (idx !== -1) {
        for (let i = stack.length - 1; i > idx; i--) out += `</${stack[i]}>`;
        out += `</${tag}>`;
        stack.length = idx;
      }
      // chiusura orfana: scartata
    } else {
      out += full;
      stack.push(tag);
    }
    last = m.index + full.length;
  }
  out += html.slice(last);
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`;
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/telegram.test.ts && npm run typecheck`
Expected: all PASS (inclusi i test esistenti `mdToHtml('**bold** and \`code\`')` → `<b>bold</b> and <code>code</code>`).

- [ ] **Step 5: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat: mdToHtml v2 con balance pass (mai HTML sbilanciato, codice protetto)"
```

---

### Task 2: `promptMessage` v2 + `promptLayout` (scelte multiple mai troncate)

**Files:**
- Modify: `bot/telegram.ts` (funzione `promptMessage` esistente + nuovo `promptLayout`)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `PromptQuestion` da `../src/types.js` (già importato).
- Produces:
  - `promptMessage(questions: PromptQuestion[]): string` — invariata la firma, ora con l'elenco numerato completo delle opzioni.
  - `interface PromptOption { label: string; callback: string }`
  - `promptLayout(questions: PromptQuestion[], token: string, maxButtons?: number): { options: PromptOption[]; hint: string }` — `options` vuoto sopra il cap (solo reply col numero); `hint` adattato. Le etichette dei bottoni sono testo semplice (niente `htmlEscape`: i label dei bottoni non passano dal parse HTML di Telegram).

- [ ] **Step 1: Write the failing tests**

Append to `test/telegram.test.ts`:

```ts
describe('promptMessage v2 / promptLayout', () => {
  it('lists every option with its number and description, HTML-escaped', () => {
    const qs = [{ header: 'Lens', question: 'Pick <one>?', options: [{ label: 'a', description: 'desc <x>' }, { label: 'b' }] }];
    const out = promptMessage(qs);
    expect(out).toContain('Pick &lt;one&gt;?');
    expect(out).toContain('1. a');
    expect(out).toContain('— <i>desc &lt;x&gt;</i>');
    expect(out).toContain('2. b');
  });
  it('builds buttons under the cap with short labels and number-reply hint', () => {
    const qs = [{ question: 'q', options: [{ label: 'long label that exceeds forty chars for sure ok' }, { label: 'b' }] }];
    const { options, hint } = promptLayout(qs, 'tok1');
    expect(options).toHaveLength(2);
    expect(options[0].label).toBe('long label that exceeds forty chars for…');
    expect(options[0].callback).toBe('q:answer:tok1:0:0');
    expect(options[1].callback).toBe('q:answer:tok1:0:1');
    expect(hint).toContain('number');
  });
  it('falls back to a numbered list only above the button cap', () => {
    const options = Array.from({ length: 13 }, (_, i) => ({ label: `opt ${i}` }));
    const { options: btns, hint } = promptLayout([{ question: 'q', options }], 'tok1');
    expect(btns).toEqual([]);
    expect(hint).toContain('number');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — `promptMessage` non elenca le opzioni e `promptLayout` non esiste.

- [ ] **Step 3: Implement**

Replace `promptMessage` and add `promptLayout` (e l'interfaccia `PromptOption`) dopo di essa:

```ts
// Intestazione della domanda a scelta multipla: elenco numerato completo delle
// opzioni (mai troncato) — il reply col numero resta sempre valido.
export function promptMessage(questions: PromptQuestion[]): string {
  return questions
    .map(q => {
      const title = q.header ? `${q.header}: ${q.question}` : q.question;
      const opts = q.options
        .map((o, i) => `  ${i + 1}. ${htmlEscape(o.label)}${o.description ? ` — <i>${htmlEscape(o.description)}</i>` : ''}`)
        .join('\n');
      return `❓ <b>${htmlEscape(title)}</b>\n${opts}`;
    })
    .join('\n\n');
}

export interface PromptOption { label: string; callback: string }

// Layout dei bottoni per le domande: etichetta corta come scorciatoia sopra
// l'elenco numerato completo. Sopra il cap di opzioni niente bottoni: il reply
// col numero resta il fallback. I label dei bottoni sono testo semplice (il
// parse_mode HTML non si applica ai bottoni inline di Telegram).
export function promptLayout(questions: PromptQuestion[], token: string, maxButtons = 12): { options: PromptOption[]; hint: string } {
  const all = questions.flatMap((q, qi) =>
    q.options.map((o, oi) => ({
      label: o.label.length > 40 ? `${o.label.slice(0, 40).trimEnd()}…` : o.label,
      callback: `q:answer:${token}:${qi}:${oi}`,
    })));
  const useButtons = all.length > 0 && all.length <= maxButtons;
  return {
    options: useButtons ? all : [],
    hint: useButtons
      ? '\n\n<i>Tap an option or reply with its number.</i>'
      : '\n\n<i>Reply with the number of an option.</i>',
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/telegram.test.ts && npm run typecheck`
Expected: all PASS (il test esistente `promptMessage` che cercava `Lens` e `Pick &lt;one&gt;?` continua a passare).

- [ ] **Step 5: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat: scelte multiple con elenco numerato completo + bottoni (mai troncate)"
```

---

### Task 3: `renderHistory` v2 + `truncateAtWord` + `stopReply`

**Files:**
- Modify: `bot/telegram.ts`
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `RecentMessage` da `../src/sessions/transcript.js` (già importato), `mdToHtml`, `htmlEscape`.
- Produces:
  - `renderHistory(messages: RecentMessage[], title: string, maxChars?: number): string` — invariata la firma; cap per messaggi interi (i più vecchi scartati, mai un messaggio spezzato), singolo messaggio lungo troncato a fine parola con `… (truncated)`.
  - `truncateAtWord(s: string, max: number): string`
  - `stopReply(o: { kind: 'headless' | 'terminal'; id8: string; aborted?: boolean; status?: string; target?: string }): string`

- [ ] **Step 1: Write the failing tests**

Append to `test/telegram.test.ts` and extend the import with `truncateAtWord` and `stopReply`:

```ts
describe('renderHistory v2 / truncateAtWord', () => {
  it('caps by whole messages, never splitting one in half', () => {
    const html = renderHistory(
      [{ role: 'user', text: 'a'.repeat(200) }, { role: 'assistant', text: 'b'.repeat(200) }],
      'proj', 100);
    expect(html).toContain('(truncated)');
    expect(html).toContain('b'.repeat(60)); // il messaggio più recente c'è (troncato)
  });
  it('truncates at a late word boundary with an explicit marker', () => {
    expect(truncateAtWord('aaaa bbb ccc', 10)).toBe('aaaa bbb… (truncated)');
    expect(truncateAtWord('short', 100)).toBe('short');
  });
});

describe('stopReply', () => {
  it('reports the real outcome for headless sessions', () => {
    expect(stopReply({ kind: 'headless', id8: 'abc12345', aborted: true })).toContain('abc12345');
    expect(stopReply({ kind: 'headless', id8: 'abc', aborted: false, status: 'idle' })).toContain('status: idle');
  });
  it('reports the target for terminal sessions and the no-pane case', () => {
    expect(stopReply({ kind: 'terminal', id8: 'abc', target: 'claude:proj' })).toContain('Ctrl+C');
    expect(stopReply({ kind: 'terminal', id8: 'abc' })).toContain('no tmux');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — `truncateAtWord`/`stopReply` non esistono e `renderHistory` taglia a metà.

- [ ] **Step 3: Implement**

Replace `renderHistory` and add the two helpers after it:

```ts
// Blocco di storia (Fix 5): gli ultimi messaggi renderizzati come chat. Il cap è
// per messaggi INTERI — i più vecchi vengono scartati, mai un messaggio spezzato;
// un singolo messaggio più lungo del cap viene troncato a fine parola.
export function renderHistory(messages: RecentMessage[], title: string, maxChars = 3800): string {
  const header = `<b>Last messages · ${htmlEscape(title)}</b>`;
  let remaining = maxChars - header.length - 2;
  const body: string[] = [];
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const m = messages[i];
    const line = `${m.role === 'user' ? '🧑' : '🤖'} ${mdToHtml(m.text)}`;
    const sep = body.length ? 2 : 0;
    if (line.length + sep > remaining) {
      body.push(truncateAtWord(line, remaining - sep));
      break;
    }
    body.push(line);
    remaining -= line.length + sep;
  }
  return `${header}\n\n${body.reverse().join('\n\n')}`;
}

// Tronca preferendo un confine di parola (se cade oltre metà del budget): mai
// tagli a metà stringa, con un marcatore esplicito di troncamento.
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  const end = sp > max * 0.5 ? sp : max;
  return s.slice(0, end).trimEnd() + '… (truncated)';
}

// Risposta di /stop basata sull'esito reale (spec §3.3): mai un generico
// "Stop requested" quando non c'è nulla da fermare.
export function stopReply(o: {
  kind: 'headless' | 'terminal';
  id8: string;
  aborted?: boolean;
  status?: string;
  target?: string;
}): string {
  if (o.kind === 'headless') {
    return o.aborted
      ? `🛑 Turn aborted for session <b>${htmlEscape(o.id8)}</b>.`
      : `No turn is running for session <b>${htmlEscape(o.id8)}</b> (status: ${htmlEscape(o.status ?? 'unknown')}).`;
  }
  return o.target
    ? `🛑 Ctrl+C sent to <code>${htmlEscape(o.target)}</code> — generation interrupted.`
    : 'This terminal session has no tmux pane to interrupt.';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/telegram.test.ts && npm run typecheck`
Expected: all PASS (il test esistente di `renderHistory` continua a passare: header con `proj`, `🧑 ciao`, `<b>ok</b>`).

- [ ] **Step 5: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat: renderHistory per messaggi interi, truncateAtWord, stopReply con esito reale"
```

---

### Task 4: Timeout sui comandi tmux

**Files:**
- Modify: `src/sessions/tmux-inject.ts` (funzione `createExec`)
- Test: `test/tmux-inject.test.ts`

**Interfaces:**
- Consumes: `ExecFn` esistente.
- Produces: `createExec(opts?: { timeoutMs?: number }): ExecFn` — firma estesa (opzionale, retro-compatibile con `createExec()` senza argomenti); default 10s; allo scadere rifiuta con `tmux command timed out after <ms>ms`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` to `test/tmux-inject.test.ts`. First extend the vitest import on line 1 to include `vi`, then append the tests (il mock di `spawn` usa `vi.hoisted` perché `vi.mock` viene sollevato sopra le dichiarazioni `const`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createExec } from '../src/sessions/tmux-inject.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

function fakeChild(): any {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter() as any;
  child.stderr = new EventEmitter() as any;
  child.stdin = { write: vi.fn(), end: vi.fn() } as any;
  child.kill = vi.fn(() => { child.emit('close', null); });
  return child;
}

describe('createExec timeout', () => {
  it('resolves when the child exits before the timeout', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = createExec({ timeoutMs: 1000 })(['list-sessions']);
    child.emit('close', 0);
    await expect(p).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
  });
  it('rejects when the child never exits', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValueOnce(child);
      const p = createExec({ timeoutMs: 1000 })(['list-sessions']);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).rejects.toThrow('timed out');
      expect(child.kill).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tmux-inject.test.ts`
Expected: FAIL — `createExec()` non accetta opts e non scatta mai un timeout.

- [ ] **Step 3: Implement**

Replace `createExec` in `src/sessions/tmux-inject.ts`:

```ts
export function createExec(opts: { timeoutMs?: number } = {}): ExecFn {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return (args, o) => new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // timeout di sicurezza: un comando tmux appeso non deve stallare un handler.
    const timer = setTimeout(() => {
      reject(new Error(`tmux command timed out after ${timeoutMs}ms`));
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    if (o?.input) child.stdin.write(o.input);
    child.stdin.end();
  });
}
```

Nota: `reject` prima di `child.kill()` — così il rifiuto prevale sull'eventuale `close` successivo (che chiamerebbe `resolve` su una promise già risolta, no-op).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tmux-inject.test.ts && npm run typecheck`
Expected: all PASS (i test esistenti di `TmuxClient` con fake exec restano verdi).

- [ ] **Step 5: Commit**

```bash
git add src/sessions/tmux-inject.ts test/tmux-inject.test.ts
git commit -m "fix: timeout di sicurezza sui comandi tmux (10s di default)"
```

---

### Task 5: `activeSessionId` nel manager (persistito)

**Files:**
- Modify: `src/state.ts`, `src/sessions/manager.ts`
- Test: `test/state.test.ts`, `test/manager.test.ts`

**Interfaces:**
- Consumes: `StateFile` esistente.
- Produces:
  - `StateFile.activeSessionId?: string`
  - `SessionManager.getActive(): string | undefined`
  - `SessionManager.setActive(id: string | undefined): void` (persiste)
  - `remove(id)` azzera `activeSessionId` se coincide (esistente, modificata)

- [ ] **Step 1: Write the failing tests**

Add to `test/state.test.ts`:

```ts
it('keeps an optional activeSessionId through a round-trip', () => {
  const { store } = tmpState();
  const { state } = store.load();
  state.activeSessionId = 'abc';
  store.save(state);
  const again = store.load();
  expect(again.state.activeSessionId).toBe('abc');
});
```

Add to `test/manager.test.ts` (usa la `makeManager` esistente, che accetta `stateDir`):

```ts
it('persists the active session id across reloads', () => {
  const shared = mkdtempSync(join(tmpdir(), 'orc-mgr-'));
  const { manager } = makeManager(false, 3000, shared);
  manager.setActive('abc');
  const { manager: m2 } = makeManager(false, 3000, shared);
  expect(m2.getActive()).toBe('abc');
});
it('clears the active session id when that session is removed', () => {
  const { manager } = makeManager();
  const s = manager.createHeadless({ title: 't', projectDir: '/tmp/x' });
  manager.setActive(s.id);
  expect(manager.remove(s.id)).toBe(true);
  expect(manager.getActive()).toBeUndefined();
});
it('returns undefined when no session is active', () => {
  const { manager } = makeManager();
  expect(manager.getActive()).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/state.test.ts test/manager.test.ts`
Expected: FAIL — `state.activeSessionId` non esiste nel tipo, `getActive`/`setActive` non esistono.

- [ ] **Step 3: Implement**

In `src/state.ts`, add the optional field to `StateFile`:

```ts
export interface StateFile {
  armed: boolean;
  authorizedUserIds: number[];
  sessions: Session[];
  mirrorOffsets: Record<string, number>;
  activeSessionId?: string; // sessione selezionata nel bot (persistita tra i riavvii)
}
```

In `src/sessions/manager.ts`, add after `getState()`/`persist()`:

```ts
getActive(): string | undefined { return this.state.activeSessionId; }
setActive(id: string | undefined): void {
  if (this.state.activeSessionId === id) return;
  this.state.activeSessionId = id;
  this.persist();
}
```

In `remove(id)`, after `this.state.sessions.splice(i, 1);`, add:

```ts
if (this.state.activeSessionId === id) this.state.activeSessionId = undefined;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/state.test.ts test/manager.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts src/sessions/manager.ts test/state.test.ts test/manager.test.ts
git commit -m "feat: activeSessionId persistito nel manager (sopravvive ai riavvii)"
```

---

### Task 6: Timeout sui fetch Ollama + abort pre-modelContext nel driver

**Files:**
- Modify: `src/ollama.ts`, `src/sessions/sdk-driver.ts`
- Test: `test/ollama.test.ts`

**Interfaces:**
- Consumes: invariati.
- Produces: i tre fetch di `OllamaClient` (`hasVision`, `modelContext`, `listModels`) passano `signal: AbortSignal.timeout(10_000)`; `SdkDriver.runTurn` controlla `ac.signal.aborted` anche prima della chiamata a `modelContext`.

- [ ] **Step 1: Write the failing tests**

Add to `test/ollama.test.ts`:

```ts
it('bounds the request with an AbortSignal timeout', async () => {
  let captured: RequestInit | undefined;
  const fetchImpl: any = async (_url: string, init?: RequestInit) => { captured = init; return new Response(JSON.stringify({ capabilities: ['vision'] })); };
  const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', fetchImpl });
  await client.hasVision('m');
  expect(captured?.signal).toBeInstanceOf(AbortSignal);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ollama.test.ts`
Expected: FAIL — `captured?.signal` è `undefined`.

- [ ] **Step 3: Implement**

In `src/ollama.ts`, add `signal: AbortSignal.timeout(10_000)` a tutti e tre i fetch. Esempio per `hasVision`:

```ts
async hasVision(model: string): Promise<boolean> {
  const res = await this.fetchImpl(`${this.deps.baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(10_000), // Ollama irraggiungibile non deve stallare
  });
  ...
}
```

Stessa aggiunta a `modelContext` e `listModels` (entrambi già best-effort con try/catch).

In `src/sessions/sdk-driver.ts`, nel `try` di `runTurn`, prima della fetch del context:

```ts
const model = session.model ?? config.defaultModel;
// /stop durante la finestra di modelContext: l'abort è già scattato prima che
// query() attacchi il listener → va onorato qui (e dopo la fetch), o si perderebbe.
if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
const ctx = await this.deps.ollama.modelContext(model);
if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
```

(Il check dopo la fetch esiste già: si aggiunge solo quello prima. La modifica è difensiva e coperta dal test esistente `stop() aborts an in-flight turn` — nessun test dedicato.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ollama.test.ts test/sdk-driver.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ollama.ts src/sessions/sdk-driver.ts test/ollama.test.ts
git commit -m "fix: timeout sui fetch Ollama e abort onorato prima di modelContext"
```

---

### Task 7: Error containment nel bot (bot.catch, safe, track, timeout client)

**Files:**
- Modify: `bot/telegram.ts`

**Interfaces:**
- Consumes: esistente.
- Produces: nessun nuovo surface pubblico; interni:
  - `private safe(ctx, label, fn)` — esegue l'handler, logga le eccezioni e risponde "❌ Something went wrong…"; il bot non si ferma mai.
  - `private track(promise, label)` — aggiunge `.catch(log)` ai fire-and-forget (niente unhandled rejection).
  - `private logCatch(label)` — ritorna `(err) => console.error(label, err)`.
  - `new Bot(token, { client: { timeoutSeconds: 35 } })`.
  - `routeMessageToSession`: try/catch attorno a `injectText` con errore amichevole.
  - `authorize`/`requireArmed`: i reply fire-and-forget vengono tracciati (niente unhandled rejection).

- [ ] **Step 1: Constructor — timeout client + bot.catch**

In `bot/telegram.ts`, constructor:

```ts
constructor(private deps: BotDeps) {
  // timeout di sicurezza su ogni chiamata API Telegram (le getUpdates long-poll
  // usano 30s server-side: 35s non le taglia, ma ogni altra chiamata è limitata).
  this.bot = new Bot(deps.config.telegramBotToken, { client: { timeoutSeconds: 35 } });
  // senza bot.catch, grammy STOPPA il bot al primo errore di middleware non
  // gestito → il daemon moriva (spec §3.1). Ora logghiamo e si va avanti.
  this.bot.catch(err => { console.error('ollama-rc bot error:', (err as { error?: unknown })?.error ?? err); });
  this.register();
  this.subscribeBus();
}
```

- [ ] **Step 2: Add `safe`, `track`, `logCatch`**

Add these private methods to the `TelegramBot` class (vicino a `send`/`notify`):

```ts
// Contiene ogni errore degli handler: log + reply amichevole, mai un throw che
// risale al middleware di grammy (che senza bot.catch fermerebbe la coda).
private safe(ctx: Context, label: string, fn: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(fn).catch(err => {
    console.error(`handler ${label} failed:`, err);
    return this.send(ctx, '❌ Something went wrong. Check the daemon log.').catch(() => undefined);
  });
}

// Aggiunge il log a un'operazione fire-and-forget: niente unhandled rejection
// (in Node 22 una promise rifiutata non gestita uccide il processo).
private track(p: Promise<unknown>, label: string): void {
  void p.catch(err => console.error(`background ${label} failed:`, err));
}

private logCatch(label: string): (err: unknown) => void {
  return err => console.error(label, err);
}
```

- [ ] **Step 3: Wrap every registered handler with `safe` + reply fire-and-forget tracciati**

Replace the body of `register()` so each handler goes through `safe`, e aggiorna `authorize` e `requireArmed` perché i loro reply non restino fire-and-forget non gestiti:

```ts
private register(): void {
  const bot = this.bot;
  bot.command('start', ctx => this.safe(ctx, 'start', () => this.onStart(ctx)));
  bot.command('help', ctx => this.safe(ctx, 'help', async () => {
    if (this.authorize(ctx)) await this.send(ctx, 'Commands: /rc on|off|status · /sessions · /view · /new &lt;text&gt; · /stop · /status · /attach &lt;project&gt; · /history [id] · /delete [id] · /help');
  }));
  bot.command('rc', ctx => this.safe(ctx, 'rc', () => this.onRc(ctx)));
  bot.command('sessions', ctx => this.safe(ctx, 'sessions', () => this.onSessions(ctx)));
  bot.command('view', ctx => this.safe(ctx, 'view', () => this.onView(ctx)));
  bot.command('new', ctx => this.safe(ctx, 'new', () => this.onNew(ctx)));
  bot.command('stop', ctx => this.safe(ctx, 'stop', () => this.onStop(ctx)));
  bot.command('status', ctx => this.safe(ctx, 'status', () => this.onStatus(ctx)));
  bot.command('attach', ctx => this.safe(ctx, 'attach', () => this.onAttach(ctx)));
  bot.command('history', ctx => this.safe(ctx, 'history', () => this.onHistory(ctx)));
  bot.command('delete', ctx => this.safe(ctx, 'delete', () => this.onDelete(ctx)));
  bot.on('callback_query:data', ctx => this.safe(ctx, 'callback', () => this.onCallback(ctx)));
  bot.on('message:text', ctx => this.safe(ctx, 'message', () => this.onMessage(ctx)));
  bot.on('message:photo', ctx => this.safe(ctx, 'photo', () => this.onPhoto(ctx)));
  bot.on('message:document', ctx => this.safe(ctx, 'document', () => this.onDocument(ctx)));
}
```

In `authorize`, sostituisci `void this.send(ctx, '⛔ Not authorized...')` con `this.track(this.send(ctx, '⛔ Not authorized. Send <code>/start &lt;pairing code&gt;</code>.'), 'authorize reply')`.

In `requireArmed`, sostituisci `void this.send(ctx, '🔒 Remote control is off. Send /rc on.')` con `this.track(this.send(ctx, '🔒 Remote control is off. Send /rc on.'), 'requireArmed reply')`.

- [ ] **Step 4: `routeMessageToSession` — niente più crash su tmux giù**

Replace the terminal branch of `routeMessageToSession` (oggi senza try/catch):

```ts
} else {
  if (!session.tmuxTarget) {
    await this.send(ctx, 'This session is not running in tmux, so text can’t be injected. Start it with:\n<code>tmux new -s claude:&lt;project&gt;</code>');
    return;
  }
  try {
    await this.deps.tmux.injectText(session.tmuxTarget, text);
    this.recordInjected(session.id, text);
  } catch (e) {
    // tmux giù o pane sparito: errore amichevole, mai un throw che uccide il daemon.
    await this.send(ctx, `❌ Can't inject into <code>${htmlEscape(session.tmuxTarget)}</code>: ${htmlEscape(e instanceof Error ? e.message : String(e))}. Is tmux running?`);
  }
}
```

- [ ] **Step 5: `track()` sui fire-and-forget `runTurn` + log sui catch silenziosi**

Replace the three `void this.deps.sdk.runTurn(...)` calls (in `onNew`, `answerPrompt`, `routeMessageToSession`) with `this.track(...)`:

```ts
this.track(this.deps.sdk.runTurn(session.id, text), 'runTurn');
```

Replace the silent `.catch(() => {})` sulle send opzionali del bot con `.catch(this.logCatch('<label>'))`:
- `notify()` → `.catch(this.logCatch('notify'))`
- `start()` `setMyCommands` → `.catch(this.logCatch('setMyCommands'))`
- `answerPrompt` edit finale e `editCallbackDecision` → `.catch(this.logCatch('callback edit'))`
- handler `session.prompt` e `session.permission` send → `.catch(this.logCatch('prompt send'))` / `('permission send')`
- callback `select` history send e `del-yes`/`del-no` edit → `.catch(this.logCatch('callback send'))`

Lascia i `.catch` FUNZIONALI invariati: `forwardText` edit→`.catch(() => false)` e send→`.catch(() => undefined)`, i sink di `ToolBurstAggregator` (`edit`→false, `send`→undefined): sono fallback di logica, non ingoiano errori.

- [ ] **Step 6: Timeout sul download Telegram**

In `downloadTelegramFile`:

```ts
const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test`
Expected: all PASS. Manual check (daemon live): inviare un testo a una sessione terminale con tmux spento → reply "❌ Can't inject into … Is tmux running?", il daemon resta vivo e risponde agli altri comandi.

- [ ] **Step 8: Commit**

```bash
git add bot/telegram.ts
git commit -m "fix: error containment nel bot (bot.catch, safe, track, timeout client 35s)"
```

---

### Task 8: `activeSessionId` → manager (una sola fonte di verità)

**Files:**
- Modify: `bot/telegram.ts`

**Interfaces:**
- Consumes: `SessionManager.getActive()` / `setActive()` (Task 5).
- Produces: nessun nuovo surface; il campo privato `activeSessionId` della classe viene rimosso e ogni lettura/scrittura passa dal manager (che persiste).

- [ ] **Step 1: Rimuovere il campo**

Remove `private activeSessionId?: string;` (oggi dichiarato accanto a `lastMsg`). Nessuna inizializzazione serve: il manager è già caricato dallo state.

- [ ] **Step 2: Sostituire tutte le occorrenze**

`this.activeSessionId` → `this.deps.manager.getActive()` nelle letture e `this.deps.manager.setActive(X)` nelle scritture. Punti esatti:

1. `onSessions` → `sessionListText(list, this.deps.manager.getActive())`
2. `onNew` → `this.deps.manager.setActive(session.id);` al posto di `this.activeSessionId = session.id;`
3. `onStop` → `const active = this.deps.manager.getActive(); const s = active ? this.deps.manager.get(active) : undefined;`
4. `onStatus` → stessa sostituzione di `onStop`
5. `onAttach` → `this.deps.manager.setActive(session.id);`
6. `onHistory` → `const id = ctx.match?.toString().trim() || this.deps.manager.getActive();`
7. `onDelete` → `const id = ctx.match?.toString().trim() || this.deps.manager.getActive();`
8. callback `select` → `if (s) this.deps.manager.setActive(s.id);` e `sessionListText(this.deps.manager.list(), this.deps.manager.getActive())`
9. callback `del-yes` → rimuovere la riga `if (this.activeSessionId === parsed.id) this.activeSessionId = undefined;` (ora lo fa `manager.remove` in Task 5)
10. `routeMessageToSession` → `const session = this.deps.manager.getActive() ? this.deps.manager.get(this.deps.manager.getActive()!) : this.deps.manager.list()[0];`
11. `onPhoto` → stessa sostituzione di `routeMessageToSession`
12. `onView` → `const s = this.deps.manager.getActive() ? this.deps.manager.get(this.deps.manager.getActive()!) : undefined;`
13. `subscribeBus` (handler `session.text`, `session.prompt`, `session.tool`, `session.result`, `session.error`) → `if (e.sessionId !== this.deps.manager.getActive())` (per `session.tool`: `e.sessionId === this.deps.manager.getActive()`)

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: all PASS. Nessun riferimento residuo a `this.activeSessionId`: `grep -n "activeSessionId" bot/telegram.ts` deve mostrare solo `this.deps.manager.getActive()`/`setActive(...)`.

- [ ] **Step 4: Commit**

```bash
git add bot/telegram.ts
git commit -m "refactor: activeSessionId nel manager (persistito, una sola fonte di verità)"
```

---

### Task 9: `/stop` con esito reale + scelte multiple a testo completo

**Files:**
- Modify: `bot/telegram.ts`

**Interfaces:**
- Consumes: `stopReply` (Task 3), `promptMessage` v2 + `promptLayout` (Task 2), `SessionManager.getActive()` (Task 8).
- Produces: `onStop` risponde con lo stato reale; il handler `session.prompt` invia l'elenco numerato completo + bottoni (`promptLayout`).

- [ ] **Step 1: Rewrite `onStop`**

Replace `onStop`:

```ts
private async onStop(ctx: Context): Promise<void> {
  if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
  const active = this.deps.manager.getActive();
  const s = active ? this.deps.manager.get(active) : undefined;
  if (!s) { await this.send(ctx, 'No active session.'); return; }
  const id8 = s.id.slice(0, 8);
  if (s.kind === 'headless') {
    this.deps.permissionFlow.cancelAllForSession(s.id);
    const aborted = this.deps.sdk.stop(s.id); // abort del turno in corso
    await this.send(ctx, stopReply({ kind: 'headless', id8, aborted, status: s.status }));
  } else if (s.tmuxTarget) {
    try {
      await this.deps.tmux.sendKeys(s.tmuxTarget, 'C-c');
      await this.send(ctx, stopReply({ kind: 'terminal', id8, target: s.tmuxTarget }));
    } catch (e) {
      await this.send(ctx, `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
    }
  } else {
    await this.send(ctx, stopReply({ kind: 'terminal', id8 }));
  }
}
```

- [ ] **Step 2: Rewrite the `session.prompt` handler**

Replace the `bus.on('session.prompt', ...)` body in `subscribeBus`:

```ts
bus.on('session.prompt', ({ sessionId, questions }) => {
  if (!this.deps.manager.isArmed()) return;
  if (sessionId !== this.deps.manager.getActive()) return;
  this.toolBurst(sessionId).close();
  // Fix 2: elenco numerato completo + bottoni con etichetta corta (mai troncati).
  const token = randomUUID();
  this.pendingPrompts.set(token, { sessionId, questions, text: promptMessage(questions) });
  const { options, hint } = promptLayout(questions, token);
  if (!this.chatId) return;
  const text = promptMessage(questions) + hint;
  if (!options.length) {
    void this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'HTML' }).catch(this.logCatch('prompt send'));
    return;
  }
  const kb = new InlineKeyboard();
  for (const o of options) kb.text(o.label, o.callback).row();
  void this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'HTML', reply_markup: kb }).catch(this.logCatch('prompt send'));
});
```

Nota: i label dei bottoni sono testo semplice (nessun `htmlEscape` — il parse_mode HTML non si applica ai bottoni inline, e `htmlEscape` mostrerebbe `&lt;` letterale).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test`
Expected: all PASS. Manual check (daemon live):
- `/stop` su una sessione headless idle → "No turn is running for session … (status: idle)."
- `/stop` su una sessione con turno in corso → "🛑 Turn aborted for session …."
- Domanda a scelta multipla → messaggio con opzioni numerate per intero + bottoni; tap risponde con la label completa; reply col numero funziona; il messaggio viene editato con l'esito.

- [ ] **Step 4: Commit**

```bash
git add bot/telegram.ts
git commit -m "feat: /stop con esito reale, scelte multiple a testo completo nel messaggio"
```

---

### Task 10: Guardia `unhandledRejection` nel daemon + docs + verifica finale

**Files:**
- Modify: `src/daemon.ts`, `CHANGELOG.md`, `README.md`

**Interfaces:**
- Consumes: tutti i task precedenti.

- [ ] **Step 1: Guardia globale nel daemon**

In `src/daemon.ts`, dentro il blocco `isMain`, prima di `daemon.start()`:

```ts
if (isMain) {
  // rete di sicurezza: anche un fire-and-forget sfuggito non deve uccidere il daemon.
  process.on('unhandledRejection', err => { console.error('ollama-rc unhandledRejection:', err); });
  const daemon = createDaemon(loadConfig());
  ...
}
```

- [ ] **Step 2: CHANGELOG**

Add an entry under `[Unreleased]`:

```markdown
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
```

- [ ] **Step 3: README**

Update the two spots that changed behavior:
1. In "Usage → Multiple-choice questions": replace "one inline button per option; tap to answer" with a description of the numbered list + buttons ("a numbered list of every option (with descriptions), plus one inline button per option as a shortcut — nothing is truncated; tap or reply with the number").
2. In the command table row for `/stop`: add "reports whether a turn was actually aborted".

- [ ] **Step 4: Final verification**

Run: `npm run typecheck && npm test`
Expected: all PASS (15 file, 109+ test).

- [ ] **Step 5: Commit**

```bash
git add src/daemon.ts CHANGELOG.md README.md
git commit -m "feat: guardia unhandledRejection nel daemon; docs e changelog per la stabilizzazione"
```

---

## Self-review notes

- Spec §3.1 (error containment) → Task 7 + Task 10 (unhandledRejection).
- Spec §3.2 (timeout) → Task 4 (tmux), Task 6 (Ollama), Task 7 (client 35s + download 30s).
- Spec §3.3 (/stop) → Task 3 (`stopReply`) + Task 9 (wiring) + Task 6 (pre-abort race).
- Spec §3.4 (scelte multiple) → Task 2 (`promptMessage`/`promptLayout`) + Task 9 (wiring).
- Spec §3.5 (mdToHtml v2) → Task 1.
- Spec §3.6 (renderHistory) → Task 3.
- Spec §3.7 (persistenza activeSessionId) → Task 5 (manager) + Task 8 (bot).
- Verifica del crash originale: Task 7 Step 7 (checklist manuale con tmux spento).
