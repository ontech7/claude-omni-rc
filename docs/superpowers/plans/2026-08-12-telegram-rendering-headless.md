# Telegram rendering + headless parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/sessions` and `/diag` readable on a narrow screen, render markdown tables reliably in chat, keep the text-before-question order, and make headless sessions behave like tmux sessions (read-only tools auto-allowed) with documented limitations.

**Architecture:** Four independent tracks: (1) pure-presentation layout for the session list and diag report in `bot/telegram.ts`; (2) a rewritten table pass in `bot/render.ts` that runs before fence protection and converts pipe tables (indented, bare, fence-wrapped) to fixed-width `<pre>`; (3) an incremental text parser in `src/sessions/transcript.ts` that emits deltas for rewritten messages; (4) a `TextOrderGate` in `bot/telegram.ts` that serializes text sends per session and makes `AskUserQuestion` prompts wait for the preceding text, plus a raw-markdown buffer in `forwardText` so conversion happens on the accumulated text. (5) an auto-allow set for read-only tools in `src/sessions/sdk-driver.ts` `canUseTool`. (6) AI-GUIDE documentation.

**Tech Stack:** Node 22, TypeScript strict ESM (`tsx`), grammy, vitest. No new dependencies.

## Global Constraints

- TypeScript `strict`, ESM; relative imports carry the `.js` extension.
- No new runtime dependencies (the budget is `@anthropic-ai/claude-agent-sdk`, `grammy`, `dotenv`).
- Pure logic goes in exported top-level functions / small injected classes (like `EditThrottler`, `ToolBurstAggregator`) so it can be tested without a mocking library.
- Every dynamic fragment sent to Telegram is `htmlEscape`d; every reply goes through `splitHtmlMessage`.
- Default-deny: the ONLY permissive change in this plan is the read-only tool allowlist (spec §3.3). Bash/Edit/Write/MCP/`ExitPlanMode` still go through `PermissionFlow`.
- New comments in English; keep existing Italian comments as they are; user-facing strings and shipped docs in English.
- Conventional Commits, imperative, one concern each; commit on the working branch (`feat/readable-sessions-tables-headless`), never `main`.
- Gate before each commit: `npm run typecheck && npm test` both green.
- Constants used by tests come from the module, not hardcoded strings duplicated in tests.

---

### Task 1: Two-line layout for `/sessions` and `/diag`

**Files:**
- Modify: `bot/telegram.ts` — `sessionListText` (~line 687), `diagReport` (~line 726)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `Session` (`src/types.ts`), `DiagSnapshot`/`DiagSession` (already exported from `bot/telegram.ts`).
- Produces: `sessionListText(sessions: Session[], activeId?: string): string` and `diagReport(s: DiagSnapshot): string` with the new two-line format. `TextOrderGate` (Task 4) does not depend on these.

- [ ] **Step 1: Update the failing tests**

Replace the existing `sessionListText` test in `test/telegram.test.ts` (currently asserts `▸`) and add assertions for the new format:

```ts
it('marks the active session and shows identifying details', () => {
  const sessions = [
    { id: 'aaa', kind: 'headless', title: 't1', projectDir: '/x', model: 'deepseek-v4-flash:cloud', status: 'idle', lastActivity: '2026-08-05T12:00:00.000Z', createdAt: '' },
    { id: 'bbb', kind: 'terminal', title: 't2', projectDir: '/y', tmuxTarget: 'claude:my-branch', status: 'running', lastActivity: new Date().toISOString(), createdAt: '' },
  ] as any;
  const txt = sessionListText(sessions, 'bbb');
  expect(txt).toContain('●');                // active session: filled dot
  expect(txt).toContain('<b>t2</b>');        // active session title in bold
  expect(txt).toContain('○');                // inactive: hollow dot
  expect(txt).not.toContain('▸');
  expect(txt).toContain('running');
  expect(txt).toContain('claude:my-branch'); // terminal → tmux target on its own line
  expect(txt).toContain('🖥');               // terminal icon
  expect(txt).toContain('deepseek-v4-flash:cloud'); // headless → model
  expect(txt).toContain('🧠');               // headless icon
  expect(txt).toContain('just now');
});
```

The existing `diagReport` tests (`describe('diagReport')` ~line 924) assert only content that still appears in the new format (`my-proj`, `terminal`, `headless`, `running`, `claude-sonnet-4-5`, `— · —`, `<script>` escaping, truncation) — leave them unchanged. Add one test for the new markers right after `'lists every session…'`:

```ts
it('marks the active session and puts the detail on its own line', () => {
  const out = diagReport(snapshot);
  expect(out).toMatch(/● <b>my-proj<\/b>/);      // active session: filled dot + bold title
  expect(out).toMatch(/○/);                      // inactive: hollow dot
  expect(out).toContain('🖥');
  expect(out).toContain('🧠');
  expect(out).toMatch(/\n {2}🖥 terminal · tmux/); // second line indented
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/telegram.test.ts -t "sessionListText|diagReport"`
Expected: FAIL — the current output has `▸`, no `●`, no `<b>t2</b>`.

- [ ] **Step 3: Implement the new layout**

In `bot/telegram.ts`, replace `sessionListText`:

```ts
// Una sessione su due righe: la prima dice titolo/stato/attività, la seconda il
// target (per le terminali il tmux, per le headless il modello). Su uno schermo
// stretto una riga per sessione andava a capo e mescolava i fatti; la sessione
// attiva è marcata con ● pieno e titolo in grassetto (▸ era ambiguo).
export function sessionListText(sessions: Session[], activeId?: string): string {
  if (!sessions.length) return 'No sessions.';
  return sessions
    .map(s => {
      const active = s.id === activeId;
      const marker = active ? '●' : '○';
      const title = htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8));
      const status = htmlEscape(s.status);
      const kindIcon = s.kind === 'terminal' ? '🖥' : '🧠';
      const detail = s.kind === 'terminal'
        ? (s.tmuxTarget ? htmlEscape(s.tmuxTarget) : 'no tmux')
        : htmlEscape(s.model ?? 'model');
      const line1 = `${marker} ${active ? `<b>${title}</b>` : title} · ${status} · ${relativeTime(s.lastActivity)}`;
      return `${line1}\n  ${kindIcon} ${detail}`;
    })
    .join('\n\n');
}
```

In `diagReport`, replace the `sessions` block (the `.map` producing `• <code>id8</code> …`):

```ts
const sessions = s.sessions.length
  ? s.sessions.map(x => {
      const active = x.id === s.activeSessionId;
      const marker = active ? '●' : '○';
      const title = htmlEscape(x.title) || htmlEscape(x.id.slice(0, 8));
      const kindIcon = x.kind === 'terminal' ? '🖥' : '🧠';
      const bits = [x.kind, x.hasTmux ? 'tmux' : 'no-tmux', x.transcript ? 'transcript' : 'no-transcript'];
      const modelEffortBranch = [x.model ?? '—', x.effort ?? '—', x.branch ?? '—'].map(htmlEscape).join(' · ');
      const line1 = `${marker} ${active ? `<b>${title}</b>` : title} · ${htmlEscape(x.status)}`;
      return `${line1}\n  ${kindIcon} ${htmlEscape(bits.join(' · '))} · ${modelEffortBranch}`;
    }).join('\n\n')
  : 'no sessions tracked';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat(bot): two-line layout for /sessions and /diag with a clear active-session marker"
```

---

### Task 2: Robust markdown table rendering in `bot/render.ts`

**Files:**
- Modify: `bot/render.ts` — `mdToHtml` (~lines 16-82) and module-level table helpers
- Test: `test/render.test.ts`

**Interfaces:**
- Consumes: `htmlEscape`, `protect` (the closure inside `mdToHtml`).
- Produces: module-level helpers `isTableRow(line: string): boolean`, `isSeparator(line: string): boolean`, `renderTable(rows: string[]): string`, `formatCell(raw: string): string`, `truncateCell(raw: string, width: number): string` — all private (not exported); behavior is tested through `mdToHtml`. The `mdToHtml` signature does not change (Task 4 depends on it).

- [ ] **Step 1: Write the failing tests**

Append to the tables describe block in `test/render.test.ts` (after `'aligns tables in a pre block'`):

```ts
it('converts an indented table', () => {
  const out = mdToHtml('  | A | B |\n  |---|---|\n  | 1 | 2 |');
  expect(out).toContain('<pre>');
  expect(out).toMatch(/A\s+\|\s+B/);
  expect(out).toContain('1 | 2');
});
it('converts a table without outer pipes when a separator row is present', () => {
  const out = mdToHtml('A | B\n--- | ---\n1 | 2');
  expect(out).toContain('<pre>');
  expect(out).toMatch(/A\s+\|\s+B/);
});
it('converts a table inside a fence and consumes the fence markers', () => {
  const out = mdToHtml('```\n| A | B |\n|---|---|\n| 1 | 2 |\n```');
  expect(out).toContain('<pre>');
  expect(out).toMatch(/A\s+\|\s+B/);
  expect(out).not.toContain('<code>');       // no leftover inline-code protection
});
it('leaves a non-table fence literal', () => {
  const out = mdToHtml('```\njust | some\npipes | here\n```');
  expect(out).toContain('just | some');      // no separator row → stays literal
});
it('truncates a long cell with an ellipsis, never mid-word', () => {
  const out = mdToHtml('| Col | Long col value that exceeds the cell max |\n|---|---|\n| x | y |');
  expect(out).toContain('…');
  expect(out).not.toContain('exce');         // 'exce' was the old mid-word cut
});
it('renders bold and code inside table cells', () => {
  const out = mdToHtml('| a | b |\n|---|---|\n| **bold** | `code` |');
  expect(out).toContain('<b>bold</b>');
  expect(out).toContain('<code>code</code>');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/render.test.ts -t "indented|outer pipes|inside a fence|non-table fence|long cell|inside table cells"`
Expected: FAIL — indented/fence/bare tables are not converted today; `exce` appears instead of `…`.

- [ ] **Step 3: Implement the new table pass**

Add module-level helpers above `mdToHtml` in `bot/render.ts`:

```ts
// Riga tabellare (input già trimmato): lo stile a pipe '| A |' con o senza
// indentazione, oppure lo stile nudo 'A | B' (almeno una pipe). Lo stile nudo
// viene accettato solo se il run ha una riga separatrice — vedi renderTables.
function isTableRow(line: string): boolean {
  return /^\|.*\|\s*$/.test(line) || /^[^|]*\|.*$/.test(line);
}

// Riga separatrice: '---', ':--:', '| --- | :--: |' — la firma che distingue una
// tabella da testo qualunque con pipe sparse.
function isSeparator(line: string): boolean {
  return /^:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*$/.test(line);
}

// Tronca una cella oltre la larghezza della colonna preferendo un confine di
// parola e chiudendo con '…': mai un taglio a metà parola (dati persi).
function truncateCell(raw: string, width: number): string {
  if (raw.length <= width) return raw;
  const cut = raw.slice(0, width);
  const sp = cut.lastIndexOf(' ');
  const end = sp > width * 0.5 ? sp : width;
  return raw.slice(0, end).trimEnd() + '…';
}

// Markdown inline dentro le celle: grassetto e codice diventano tag. Il contenuto
// è già htmlEscaped (mdToHtml escapa all'inizio), quindi i tag sono sicuri, e i
// padding vengono applicati al testo NUDO prima di questo pass — i tag non
// spostano l'allineamento a larghezza fissa.
function formatCell(raw: string): string {
  return raw
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

// Allinea le righe di una tabella in un <pre> a larghezza fissa: colonne larghe
// al più CELL_MAX, celle troppo lunghe troncate con '…' (mai a metà parola).
const CELL_MAX = 48;
function renderTable(rows: string[]): string {
  const cells = rows.map(r => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
  const cols = Math.max(...cells.map(r => r.length));
  const width: number[] = [];
  for (let c = 0; c < cols; c++) {
    width[c] = Math.min(CELL_MAX, Math.max(...cells.map(r => (r[c] ?? '').length)));
  }
  return cells
    .map(r => Array.from({ length: cols }, (_, c) => {
      const raw = r[c] ?? '';
      const padded = (raw.length <= width[c] ? raw : truncateCell(raw, width[c])).padEnd(width[c]);
      return formatCell(padded);
    }).join(' | ').trimEnd())
    .join('\n');
}

// Converte i run di righe tabellari nel testo (fuori dai fence, già protetti) in
// un <pre> protetto. Un run è una tabella solo se contiene una riga separatrice e
// almeno due righe di corpo: il testo con pipe isolate non viene mai toccato.
function renderTableBlocks(text: string, protect: (c: string, kind: 'pre' | 'code', lang?: string) => string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i].trim())) {
      let j = i;
      const run: string[] = [];
      while (j < lines.length && isTableRow(lines[j].trim())) { run.push(lines[j].trim()); j++; }
      const body = run.filter(r => !isSeparator(r));
      if (run.length >= 2 && run.some(isSeparator) && body.length >= 2) {
        out.push(protect(renderTable(body), 'pre'));
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}
```

Then reorder and extend `mdToHtml`:

```ts
export function mdToHtml(text: string): string {
  const blocks: string[] = [];
  const P = String.fromCharCode(0);
  const protect = (c: string, kind: 'pre' | 'code', lang?: string): string => {
    const idx = blocks.length;
    blocks.push(
      kind === 'pre'
        ? (lang ? `<pre><code class="language-${lang}">${c}</code></pre>` : `<pre>${c}</pre>`)
        : `<code>${c}</code>`);
    return `${P}${idx}${P}`;
  };
  let out = htmlEscape(text);
  // I fence passano PRIMA delle tabelle: un fence con forma tabellare ('| … |' +
  // riga separatrice) diventa una tabella e i suoi marcatori ``` vengono consumati
  // (decisione di design: anche le tabelle-fence nella narrazione del modello si
  // leggono). Un fence con contenuto non-tabellare resta il <pre> letterale di
  // oggi — l'output di tool (log, CSV) non ha la riga separatrice e non viene
  // toccato.
  out = out.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_m, first: string, c: string) => {
    const rows = c.trimEnd().split('\n').map(l => l.trim()).filter(Boolean);
    if (rows.length >= 2 && rows.some(isSeparator) && rows.every(isTableRow)) {
      const body = rows.filter(r => !isSeparator(r));
      if (body.length >= 2) return `${protect(renderTable(body), 'pre')}\n`;
    }
    return protect(c, 'pre', /^[a-z0-9+#-]{1,20}$/.test(first) ? first : undefined);
  });
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => protect(c, 'code'));
  // Tabelle fuori dai fence: a questo punto i fence sono placeholder, quindi un
  // contenuto '| … |' dentro un fence non può più sembrare una tabella qui.
  out = renderTableBlocks(out, protect);
  out = out
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>');
  out = out.replace(/^ {2,}[-*]\s+(.+)$/gm, '  ◦ $1');
  out = out.replace(/^[-*]\s+(.+)$/gm, '• $1');
  out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  out = out.replace(/^(?:-{3,}|\*{3,})$/gm, '——————');
  out = out.replace(/(?:^&gt;\s?.*(?:\n|$))+/gm, m => {
    const body = m.replace(/^&gt;\s?/gm, '').replace(/\n$/, '');
    return `<blockquote>${body}</blockquote>\n`;
  });
  out = out.replace(/^#{1,6}\s+([^<\n]+)$/gm, '\n<b>$1</b>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(new RegExp(`${P}([0-9]+)${P}`, 'g'), (_m, i) => blocks[Number(i)]);
  return balanceHtml(out);
}
```

Note: the old table block (the `CELL_MAX = 24` regex `replace` between code protection and bold) is **removed** — replaced by `renderTableBlocks`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/render.test.ts`
Expected: PASS (new tests + all pre-existing render tests, including `'aligns tables in a pre block'` and `'never produces a pre inside a blockquote'`).

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add bot/render.ts test/render.test.ts
git commit -m "feat(render): robust tables — indented, bare, fence-wrapped, ellipsis cells, inline markdown"
```

---

### Task 3: Incremental text emission in the transcript parser

**Files:**
- Modify: `src/sessions/transcript.ts` — `TranscriptParser.consumeLine` (~lines 298-352)
- Test: `test/transcript.test.ts`

**Interfaces:**
- Consumes: `JsonBlock`, existing `TranscriptEvent` shape.
- Produces: `TranscriptParser` now emits a text event per *delta* of a growing message: for message id `m` the first text block emits whole; a later line whose text is a strict extension emits only the tail; an equal text emits nothing (dedupe, as today); a rewrite that is not an extension emits nothing. The `seenText` set is replaced by a `Map<string, string>` (`lastText`), keyed `m:${mid}#${blockIndex}`.

- [ ] **Step 1: Update/extend the failing tests**

In `test/transcript.test.ts`, the existing test `'emits assistant text once per message id'` still passes unchanged (equal text → no event). Add after it:

```ts
it('emits only the delta when the CLI rewrites a message with more text', () => {
  const p = new TranscriptParser();
  expect(p.consumeLine(textLine('m9', 'hello', null))).toEqual([{ type: 'text', role: 'assistant', text: 'hello' }]);
  expect(p.consumeLine(textLine('m9', 'hello world', null))).toEqual([{ type: 'text', role: 'assistant', text: ' world' }]);
  expect(p.consumeLine(textLine('m9', 'hello world!', null))).toEqual([{ type: 'text', role: 'assistant', text: '!' }]);
});
it('ignores a rewrite that is not an extension of the emitted text', () => {
  const p = new TranscriptParser();
  p.consumeLine(textLine('m9', 'first', null));
  expect(p.consumeLine(textLine('m9', 'other', null))).toEqual([]);
  expect(p.consumeLine(textLine('m9', 'other text', null))).toEqual([]);
  // un'estensione vera riparte dall'ultimo testo visto
  expect(p.consumeLine(textLine('m9', 'first second', null))).toEqual([{ type: 'text', role: 'assistant', text: ' second' }]);
});
it('does not re-emit an equal repeat after the message finishes', () => {
  const p = new TranscriptParser();
  p.consumeLine(textLine('m1', 'done', 'end_turn'));
  // stessa riga che torna (dedupe): testo uguale → nessun delta
  expect(p.consumeLine(textLine('m1', 'done', 'end_turn')).some(e => e.type === 'text')).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/transcript.test.ts -t "delta|not an extension|forgets a finished"`
Expected: FAIL — the current parser dedupes by message id and emits the first occurrence only (`' world'`/`'!'` never appear).

- [ ] **Step 3: Implement the incremental emission**

In `src/sessions/transcript.ts`, in `TranscriptParser`:

- Replace the `seenText` field with `lastText`:

```ts
export class TranscriptParser {
  private lastText = new Map<string, string>(); // mid#blockIdx -> ultimo testo visto
  private seenTool = new Set<string>();
  private seenError = new Set<string>();
  state: TranscriptState = 'unknown';
```

- Replace the text branch in `consumeLine` (the `if (b.type === 'text' …)` block) and give the content loop an index:

```ts
for (let bi = 0; bi < blocks.length; bi++) {
  const b = blocks[bi];
  if (!b || typeof b !== 'object') continue;
  if (b.type === 'text' && typeof b.text === 'string' && b.text) {
    // Il CLI riscrive lo stesso message id con testo via via più lungo (una
    // riga per blocco, stesso id): si emette solo il DELTA rispetto a quanto già
    // visto — lo streaming resta live e il turno arriva completo. Una tabella
    // spezzata da una riscrittura non viene più persa. Un rewrite non-estensione
    // non emette nulla per quell'id.
    const key = `m:${mid}#${bi}`;
    const prev = this.lastText.get(key) ?? '';
    if (b.text.length > prev.length && b.text.startsWith(prev)) {
      this.lastText.set(key, b.text);
      events.push({ type: 'text', role: 'assistant', text: b.text.slice(prev.length) });
    } else if (!prev) {
      this.lastText.set(key, b.text);
      events.push({ type: 'text', role: 'assistant', text: b.text });
    }
  } else if (b.type === 'tool_use' && b.name) {
    // (unchanged)
  }
}
// NB: nessuna pulizia di lastText a fine messaggio — il delta-logic deduplica da
// solo le righe uguali, e la mappa cresce come cresceva seenText (una voce per
// message id visto: limitata dai messaggi della sessione).
```

Keep the rest of `consumeLine` (tool_use/AskUserQuestion handling, `max_tokens` error, state derivation) exactly as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/transcript.test.ts`
Expected: PASS (new tests + all pre-existing parser/tail tests).

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/transcript.ts test/transcript.test.ts
git commit -m "fix(transcript): emit text deltas for rewritten messages so streamed replies arrive complete"
```

---

### Task 4: Text-before-question ordering and raw-markdown bubble accumulation

**Files:**
- Modify: `bot/telegram.ts` — `BotDeps` (add optional `bot`), constructor, `lastMsg` type, `forwardText` (~line 1076), `session.text` handler (~line 2394), `session.prompt` handler (~line 2396)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `mdToHtml`, `splitHtmlMessage` from `bot/render.ts`; `Bot` from `grammy`.
- Produces: exported `class TextOrderGate` with `record(sessionId, send): Promise<void>`, `flush(sessionId): Promise<void>`, `async waitForPrecedingText(sessionId, quietMs?, capMs?): Promise<void>`. `forwardText` now takes the **raw markdown** (`raw: string`) instead of pre-converted HTML, and `lastMsg` entries become `{ messageId, raw, at, role }`. `BotDeps` gains optional `bot?: Bot` (defaults to the real grammy `Bot`), mirroring the daemon's `overrides.bot` pattern.

- [ ] **Step 1: Write the failing tests**

Add to `test/telegram.test.ts` (import `TextOrderGate` and `TelegramBot` from `../bot/telegram.js`, plus `Bus`, `StateStore`, `SessionManager`, `PermissionFlow`, `loadConfig`):

```ts
describe('TextOrderGate', () => {
  it('serializes text sends per session; flush awaits them in order', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new TextOrderGate(() => 0, ms => new Promise<void>(r => setTimeout(r, ms)));
    const first = gate.record('s1', async () => {
      order.push('a-start');
      await new Promise<void>(r => { release = () => { order.push('a-end'); r(); }; });
    });
    void gate.record('s1', async () => { order.push('b'); });
    expect(order).toEqual(['a-start']); // b non parte prima che a finisca
    release();
    await first;
    await gate.flush('s1');
    expect(order).toEqual(['a-start', 'a-end', 'b']);
  });

  it('waitForPrecedingText returns immediately when no text is pending', async () => {
    const gate = new TextOrderGate(() => 0, ms => new Promise<void>(r => setTimeout(r, ms)));
    await gate.waitForPrecedingText('s1'); // nessun testo registrato → nessuna attesa
  });

  it('waits for a hook prompt until text goes quiet, then flushes it', async () => {
    let now = 0;
    const gate = new TextOrderGate(() => now, ms => new Promise<void>(r => setTimeout(r, ms)));
    const order: string[] = [];
    void gate.record('s1', async () => { order.push('text'); });
    const p = gate.waitForPrecedingText('s1', 300, 2000);
    now = 400; // la quiete è scattata (400 > 300ms dall'ultimo testo)
    await p;
    expect(order).toEqual(['text']);
  });

  it('caps the wait even if text never goes quiet', async () => {
    let now = 0;
    const gate = new TextOrderGate(() => now, ms => new Promise<void>(r => setTimeout(r, ms)));
    void gate.record('s1', async () => {});
    const p = gate.waitForPrecedingText('s1', 300, 500);
    now = 600; // oltre il cap
    await p;   // termina, non resta appeso
  });
});
```

Then a bot-level test for the delivery order. Add a harness near the top of `test/telegram.test.ts`:

```ts
import { TelegramBot } from '../bot/telegram.js';
import { Bus } from '../src/bus.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { PermissionFlow } from '../src/permissions.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeBot() {
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: 'test-token', WORKSPACE_DIRS: '/tmp', CLAUDE_OMNI_RC_NO_UPDATE_CHECK: '1' });
  const bus = new Bus();
  const state = new StateStore(join(mkdtempSync(join(tmpdir(), 'orc-bot-')), 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: true });
  manager.setChatId(12345);
  const permissionFlow = new PermissionFlow({ bus, config });
  const api = {
    setMyCommands: vi.fn(async () => ({ ok: true })),
    sendMessage: vi.fn(async (_chatId: number, _text: string, _opts?: unknown) => ({ message_id: 1 })),
    editMessageText: vi.fn(async () => ({ ok: true })),
    sendChatAction: vi.fn(async () => ({ ok: true })),
  };
  const fakeBot = { catch: vi.fn(), command: vi.fn(), on: vi.fn(), api } as any;
  const bot = new TelegramBot({
    config, bus, manager, permissionFlow,
    dialogFlow: {} as any, sdk: {} as any, tmux: {} as any, inbox: {} as any,
    ollama: {} as any, settingsStore: {} as any,
    bot: fakeBot,
  });
  return { bot, bus, manager, api };
}
```

And the delivery-order tests:

```ts
describe('text → question ordering', () => {
  it('delivers a table split across two text events as one converted message', async () => {
    const { bus, manager, api } = makeBot();
    const s = manager.createHeadless({ title: 't', projectDir: '/tmp/x' });
    manager.setActive(s.id);
    bus.emit({ type: 'session.text', sessionId: s.id, role: 'assistant', text: '| A | B |\n|---|---|', eventId: 'e1' });
    bus.emit({ type: 'session.text', sessionId: s.id, role: 'assistant', text: '| 1 | 2 |', eventId: 'e2' });
    // e1 apre la bolla (sendMessage); e2 viene FUSO nella stessa bolla (editMessageText)
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(api.editMessageText).toHaveBeenCalledTimes(1));
    const edited = api.editMessageText.mock.calls[0][2] as string; // il testo HTML
    expect(edited).toContain('<pre>');                              // convertito sul markdown accumulato
    expect(edited).toMatch(/1\s+\|\s+2/);
  });

  it('shows an AskUserQuestion only after the preceding text is delivered', async () => {
    const { bus, manager, api } = makeBot();
    const s = manager.createHeadless({ title: 't', projectDir: '/tmp/x' });
    manager.setActive(s.id);
    bus.emit({ type: 'session.text', sessionId: s.id, role: 'assistant', text: 'Before the question.', eventId: 'e1' });
    bus.emit({ type: 'session.prompt', sessionId: s.id, questions: [{ question: 'Pick one', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }], eventId: 'e2' });
    await vi.waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2));
    const [textMsg, questionMsg] = api.sendMessage.mock.calls.map(c => c[1] as string);
    expect(textMsg).toContain('Before the question.');
    expect(questionMsg).toContain('Pick one');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/telegram.test.ts -t "TextOrderGate|text → question ordering"`
Expected: FAIL — `TextOrderGate` does not exist yet; the table test gets two messages or raw pipes (old `forwardText` converts per-chunk); the ordering test fails because the question is sent before the text completes.

- [ ] **Step 3: Implement the ordering + raw buffer**

In `bot/telegram.ts`:

(a) Add the optional bot to the deps and use it:

```ts
export interface BotDeps {
  config: Config;
  bus: Bus;
  manager: SessionManager;
  permissionFlow: PermissionFlow;
  dialogFlow: DialogFlow;
  sdk: SdkDriver;
  tmux: TmuxClient;
  inbox: Inbox;
  ollama: OllamaClient;
  settingsStore: SettingsStore;
  bot?: Bot; // iniettabile nei test; default: il Bot grammy reale
}
```

Constructor change:

```ts
this.bot = deps.bot ?? new Bot(deps.config.telegramBotToken, { client: { timeoutSeconds: 35 } });
```

(b) Add the gate as a field and a class (module-level, before `TelegramBot`):

```ts
// Garanzia d'ordine testo→domanda: gli invii di testo per sessione sono
// serializzati su una catena, e un prompt attende la catena — più un'attesa di
// quiete per i prompt dall'hook, dove il testo è già nel transcript ma può non
// essere ancora arrivato al bus (poll). Ora e sleep iniettabili per i test,
// stesso pattern di EditThrottler/ToolBurstAggregator.
export class TextOrderGate {
  private chain = new Map<string, Promise<void>>();
  private lastTextAt = new Map<string, number>();
  constructor(
    private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = ms => new Promise<void>(r => setTimeout(r, ms)),
  ) {}

  record(sessionId: string, send: () => Promise<void>): Promise<void> {
    this.lastTextAt.set(sessionId, this.now());
    const prev = this.chain.get(sessionId) ?? Promise.resolve();
    const next = prev.then(send).catch(() => {});
    this.chain.set(sessionId, next);
    return next;
  }

  flush(sessionId: string): Promise<void> {
    return this.chain.get(sessionId) ?? Promise.resolve();
  }

  async waitForPrecedingText(sessionId: string, quietMs = 300, capMs = 2000): Promise<void> {
    const deadline = this.now() + capMs;
    while (this.now() < deadline) {
      if (this.now() - (this.lastTextAt.get(sessionId) ?? 0) > quietMs) break;
      await this.sleep(50);
    }
    await this.flush(sessionId);
  }
}
```

Add the field: `private textOrder = new TextOrderGate();`

(c) Change `lastMsg` entries to hold raw markdown:

```ts
private lastMsg = new Map<string, { messageId: number; raw: string; at: number; role: 'user' | 'assistant' }>();
```

(d) Rewrite `forwardText` to accumulate raw markdown and convert on edit:

```ts
// Converte sul testo ACCUMULATO, non pezzo per pezzo: una tabella (o qualunque
// blocco markdown) spezzata tra più eventi viene riconosciuta quando è completa.
// Il buffer tiene il markdown grezzo della bolla corrente; quando l'HTML
// convertito supera SEND_MAX_CHARS si apre un messaggio nuovo con solo il testo
// nuovo, e il buffer riparte da lì.
private async forwardText(sessionId: string, raw: string, role: 'user' | 'assistant', eventId?: string): Promise<void> {
  const chatId = this.chatId;
  if (!chatId) { log().warn('send skipped', { sessionId, kind: 'text', reason: 'no-chat-bound' }); return; }
  const last = this.lastMsg.get(sessionId);
  const now = Date.now();
  const merged = last && last.role === role ? `${last.raw}\n${raw}` : raw;
  const html = mdToHtml(merged);
  if (last && last.role === role && now - last.at < 10_000 && html.length <= SEND_MAX_CHARS) {
    const ok = await this.throttler.throttled(() =>
      this.bot.api.editMessageText(chatId, last.messageId, html, { parse_mode: 'HTML' }).then(() => true).catch(() => false));
    if (ok) {
      last.raw = merged; last.at = now;
      log().info('event delivered', { eventId, sessionId, kind: 'text', messageId: last.messageId });
      return;
    }
  }
  const freshHtml = mdToHtml(raw);
  const parts = splitHtmlMessage(freshHtml);
  const messageId = await this.sendChunked(chatId, freshHtml, {}, { eventId, sessionId });
  if (messageId !== undefined) {
    this.lastMsg.set(sessionId, { messageId, raw, at: now, role });
    log().info('event delivered', { eventId, sessionId, kind: 'text', messageId });
  }
}
```

(e) `session.text` handler — pass raw and go through the gate (replace `void this.forwardText(e.sessionId, mdToHtml(e.text), e.role, e.eventId);`):

```ts
// sia le headless che i transcript delle terminali arrivano come markdown grezzo:
// forwardText accumula e converte (vedi forwardText). La catena del gate
// serializza gli invii e permette ai prompt di attendere il testo che li precede.
this.textOrder.record(e.sessionId, () => this.forwardText(e.sessionId, e.text, e.role, e.eventId));
```

(f) `session.prompt` handler — make it `async` and wait for the text before showing (keep the `passes` gate and dedupe first, and the tool-burst collapse right after them):

```ts
bus.on('session.prompt', async ({ sessionId, questions, eventId, toolUseId, source }) => {
  if (!this.passes('prompt', sessionId, eventId).deliver) return;
  // … existing dedupe block unchanged …
  void this.toolBurst(sessionId).collapse();
  this.toolBurst(sessionId).close();
  // Il testo che precede la domanda deve arrivare PRIMA in chat. Una domanda
  // dall'hook può precedere sul bus il testo (già nel transcript ma non ancora
  // pollato): si attende la quiete. Una domanda dal transcript/headless ha già
  // il testo emesso nello stesso drain: basta attendere che sia stato inviato.
  if (sessionId === this.deps.manager.getActive()) {
    if (source === 'hook') await this.textOrder.waitForPrecedingText(sessionId);
    else await this.textOrder.flush(sessionId);
  }
  this.track(this.onSessionPrompt(sessionId, questions, eventId, source), 'prompt flow');
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS (TextOrderGate + ordering tests + all existing telegram tests).

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "fix(bot): deliver the question only after the preceding text, accumulate raw markdown per bubble"
```

---

### Task 5: Auto-allow read-only tools in headless `canUseTool`

**Files:**
- Modify: `src/sessions/sdk-driver.ts` — `canUseTool` (~lines 90-99)
- Test: `test/sdk-driver.test.ts`

**Interfaces:**
- Consumes: existing `makeDriver()` harness, `queryMock`.
- Produces: no signature changes. `canUseTool` auto-allows `AskUserQuestion`, automode sessions, and the read-only set; everything else still calls `permissionFlow.request`.

- [ ] **Step 1: Write the failing tests**

Add to `test/sdk-driver.test.ts` after the `'standard mode: canUseTool routes to the permission flow'` test:

```ts
it('standard mode: read-only tools are auto-allowed without a permission request', async () => {
  const { sdk, bus, manager } = makeDriver();
  const std = manager.createHeadless({ title: 'std', projectDir: '/tmp/s', permissionMode: 'standard' });
  const perms: unknown[] = [];
  bus.on('session.permission', e => perms.push(e));
  queryMock.mockImplementationOnce(async function* () { yield resultMsg(std.id, 'ok'); });
  await sdk.runTurn(std.id, 'x');
  const opts = queryMock.mock.calls[0][0].options;
  for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) {
    await expect(opts.canUseTool(tool, { path: '/tmp/x' }, {})).resolves.toEqual({ behavior: 'allow' });
  }
  expect(perms).toHaveLength(0);
});

it('standard mode: state-changing tools still go to the permission flow', async () => {
  const { sdk, bus, manager, permissionFlow } = makeDriver();
  const std = manager.createHeadless({ title: 'std', projectDir: '/tmp/s', permissionMode: 'standard' });
  const perms: unknown[] = [];
  bus.on('session.permission', e => perms.push(e));
  queryMock.mockImplementationOnce(async function* () { yield resultMsg(std.id, 'ok'); });
  await sdk.runTurn(std.id, 'x');
  const opts = queryMock.mock.calls[0][0].options;
  const pending = opts.canUseTool('Edit', { file_path: '/tmp/x' }, {});
  expect(perms).toHaveLength(1);
  permissionFlow.approve((perms[0] as any).permission.id);
  await expect(pending).resolves.toEqual({ behavior: 'allow' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sdk-driver.test.ts -t "read-only|state-changing"`
Expected: FAIL — `Read` in standard mode today emits a `session.permission` event (`perms` length 1).

- [ ] **Step 3: Implement the allowlist**

In `src/sessions/sdk-driver.ts`, add a module-level constant near the top:

```ts
// Tool di sola lettura che il CLI nativo autorizza senza prompt: la headless deve
// comportarsi come una sessione tmux, dove il modello non viene bloccato per
// leggere. Ogni tool che cambia stato resta sui bottoni di approvazione.
const READ_ONLY_TOOLS = new Set(['Read', 'ReadFile', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
```

And in `canUseTool`, after the `permissionMode === 'auto'` branch:

```ts
canUseTool: (toolName, input, opts) => {
  if (toolName === 'AskUserQuestion') return Promise.resolve({ behavior: 'allow' });
  if (session.permissionMode === 'auto') return Promise.resolve({ behavior: 'allow' });
  // parità col CLI nativo (tmux): i tool read-only non fanno scattare il prompt
  if (READ_ONLY_TOOLS.has(toolName)) return Promise.resolve({ behavior: 'allow' });
  return permissionFlow.request(sessionId, toolName, input as Record<string, unknown>, opts.signal);
},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/sdk-driver.test.ts`
Expected: PASS (new tests + existing `ExitPlanMode`, automode, AskUserQuestion, no-mode tests).

- [ ] **Step 5: Run the gate**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/sdk-driver.ts test/sdk-driver.test.ts
git commit -m "feat(sdk-driver): auto-allow read-only tools in headless canUseTool, matching the native CLI"
```

---

### Task 6: Document headless limitations in AI-GUIDE.md

**Files:**
- Modify: `AI-GUIDE.md` (add a "Headless sessions" subsection in the setup/usage area, in English)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Write the section**

Find the existing "use a headless session" row in the setup matrix (near line 49) and add a subsection after the usage notes (after the bullet list that ends around line 111, before "The daemon talks to the Telegram Bot API…"). Insert:

```markdown
### Headless sessions

Started from Telegram with `/new`, these run the Claude Agent SDK inside the
daemon: there is no terminal screen, and replies stream straight into the chat.

**What works:** send a message and get a reply; `/stop` aborts the turn in
progress; `/compact` and `/context`; approve or reject permissions and plans
from the buttons; answer multiple-choice questions from the buttons; attach
images and documents; per-subagent `🤖 Agent` cards with `👁 Details`.

**What differs from a tmux session:**

- **No terminal screen.** `/view` can't capture anything; the replies come to
  the chat instead.
- **Permissions.** Read-only tools (`Read`, `Grep`, `Glob`, `WebFetch`,
  `WebSearch`) are allowed without asking, like the native CLI. Tools that
  change state (`Bash`, `Edit`, `Write`, `NotebookEdit`, MCP tools) need
  Telegram approval: if nobody answers within `PERMISSION_TIMEOUT_SECONDS`
  (default 120) they are denied. For unattended work start with
  `/new --auto` or set `DEFAULT_PERMISSION_MODE=auto`.
- **A daemon restart loses the turn in progress.** The session's history
  survives (it resumes from its `claudeSessionId`), but an in-flight reply is
  aborted — re-send your message.
- **No arbitrary CLI slash commands.** Telegram intercepts `/…` as bot
  commands; only the bot's own commands (`/compact`, `/stop`, `/context`, …)
  reach the session.
```

- [ ] **Step 2: Verify the doc reads correctly**

Run: `grep -n "Headless sessions" AI-GUIDE.md`
Expected: the heading appears once. Read the surrounding lines to confirm the section sits in the usage area, not inside another code block.

- [ ] **Step 3: Run the gate**

Run: `npm run typecheck && npm test`
Expected: green (docs-only change; confirms nothing regressed).

- [ ] **Step 4: Commit**

```bash
git add AI-GUIDE.md
git commit -m "docs: headless session limitations and behavior in AI-GUIDE"
```

---

## Self-review

**Spec coverage:**
- §3.1 (two-line layout) → Task 1. ✓
- §3.2 a (incremental parser) → Task 3; b (accumulated conversion) → Task 4 (d); c (matcher + fences) → Task 2; d (cells) → Task 2; e (inline markdown) → Task 2. ✓
- §3.3 (read-only allowlist) → Task 5. ✓
- §3.4 (AI-GUIDE headless docs) → Task 6. ✓
- §3.5 (text-before-question) → Task 4 (TextOrderGate + handler wait). ✓
- §4 testing expectations map to each task's test steps. ✓

**Placeholder scan:** no TBD/TODO; every code step contains the full implementation.

**Type consistency:** `forwardText(sessionId, raw, role, eventId)` is changed in Task 4 and only called from the `session.text` handler in the same task; `lastMsg` entries use `raw` everywhere it is read/written (only `forwardText`). `TextOrderGate`'s `record/flush/waitForPrecedingText` signatures match the tests and the handler. `renderTable`/`isTableRow`/`isSeparator` are module-private, used only inside `mdToHtml`/`renderTableBlocks` in Task 2. `READ_ONLY_TOOLS` is referenced only in Task 5's `canUseTool`. `BotDeps.bot?` is consumed in the constructor in Task 4 and passed by the Task 4 harness.

**Cross-task risk:** Task 3 changes tmux text from whole blocks to deltas; Task 4's raw buffer absorbs that (deltas accumulate and convert on edit). Both land before the final gate; if a mid-plan commit of Task 3 alone made live text jittery, that is expected and resolved by Task 4.
