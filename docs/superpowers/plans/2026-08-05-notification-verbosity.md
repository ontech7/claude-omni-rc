# Notifiche meno verbose — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ridurre il rumore delle notifiche Telegram: rimuovere le notifiche di stato ("Claude is working…" / "waiting for your response"), aggregare i tool in una bubble per raffica (edit del primo messaggio), e notificare gli errori seri (`max_tokens`) delle sessioni terminali.

**Architecture:** Una classe `ToolBurstAggregator` (testabile, sink iniettati) gestisce l'aggregazione: prima push → sendMessage, push successive → editMessageText, `close()` su testo/domanda/permesso/errore. Il parser transcript (`TranscriptParser`) riconosce `stop_reason: "max_tokens"` ed emette un nuovo evento `error`; `TranscriptWatcher` lo inoltra come `session.error` (handler ❌ già esistente nel bot). Il bot perde il handler `session.updated` e la mappa `lastNotified`.

**Tech Stack:** TypeScript (strict), grammy, vitest. Test: `npm test` (`vitest run`); typecheck: `npm run typecheck` (`tsc --noEmit`).

**Spec:** `docs/superpowers/specs/2026-08-05-notification-verbosity-design.md`

## Global Constraints

- **Staging chirurgico:** la working tree ha modifiche in sospeso non correlate (feature transcript-streaming non committata: `src/sessions/transcript.ts`, `src/sessions/transcript-watcher.ts`, `test/transcript.test.ts` sono untracked; `bot/telegram.ts` e altri sono modified). **Mai** `git add -A` / `git add .`. Solo `git add` dei file esatti elencati nella task. I file untracked vengono committati per intero al loro primo commit in queste task — è corretto.
- **Stile:** commenti in italiano, come nel resto del codebase. Ogni frammento dinamico interpolato in un template HTML va passato per `htmlEscape` (`bot/telegram.ts:58`). Messaggi bot in inglese.
- **Test:** ogni task segue TDD — test che fallisce, poi implementazione minima, poi test che passa, poi commit.
- **`parse_mode: 'HTML'`** su ogni `sendMessage`/`editMessageText`, come nel resto del bot.

---

### Task 1: `TranscriptParser` rileva `max_tokens` → evento `error`

**Files:**
- Modify: `src/sessions/transcript.ts` (tipi righe 22-23; `stateFromLine` righe 141-150; `TranscriptParser` righe 159-231)
- Test: `test/transcript.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces: nuovo membro dell'unione `TranscriptEvent`: `TranscriptErrorEvent { type: 'error'; message: string }`. `TranscriptParser.state` vale `'awaiting'` dopo una riga con `stop_reason: "max_tokens"`. `peekTranscriptState`/`stateFromLine` restituiscono `'awaiting'` per `max_tokens`.

- [ ] **Step 1: scrivere i test fallenti** in `test/transcript.test.ts`, nel blocco `describe('TranscriptParser')` (aggiungere la const `maxTokensLine` in cima al file, accanto alle altre):

```ts
const maxTokensLine = JSON.stringify({
  type: 'assistant', message: { id: 'msg_9', content: [], stop_reason: 'max_tokens' },
});
```

```ts
it('emits an error event and goes awaiting on max_tokens', () => {
  const p = new TranscriptParser();
  const events = p.consumeLine(maxTokensLine);
  expect(events).toEqual([{ type: 'error', message: 'Claude hit the output limit (max_tokens). Ask it to continue.' }]);
  expect(p.state).toBe('awaiting');
  expect(p.consumeLine(maxTokensLine)).toEqual([]); // dedupe: già visto
});
it('does not emit an error for end_turn or tool_use lines', () => {
  const p = new TranscriptParser();
  const a = p.consumeLine(toolLine);
  const b = p.consumeLine(endTurn);
  expect(a.some(e => e.type === 'error')).toBe(false);
  expect(b.some(e => e.type === 'error')).toBe(false);
});
```

Nel blocco `describe('peekTranscriptState / transcriptModel')`:

```ts
it('peeks awaiting after a max_tokens line', () => {
  const dir = tmpDir();
  const file = join(dir, 's.jsonl');
  writeFileSync(file, userLine('a') + '\n' + maxTokensLine + '\n');
  expect(peekTranscriptState(file)).toBe('awaiting');
});
```

- [ ] **Step 2: eseguire i test e verificarne il fallimento**

Run: `npx vitest run test/transcript.test.ts`
Expected: FAIL — `events` non contiene alcun `{ type: 'error', … }`; `state` è `'working'` invece di `'awaiting'`.

- [ ] **Step 3: implementazione minima**

In `src/sessions/transcript.ts`:

a) Nuovo tipo + unione (dopo `TranscriptPromptEvent`, riga 22):

```ts
export interface TranscriptErrorEvent { type: 'error'; message: string }
export type TranscriptEvent = TranscriptTextEvent | TranscriptToolEvent | TranscriptPromptEvent | TranscriptErrorEvent;
```

b) `stateFromLine` (righe 144-146) — `max_tokens` è un arresto, non un "working":

```ts
if (d.type === 'assistant') {
  const stop = d.message?.stop_reason;
  return stop === 'end_turn' || stop === 'max_tokens' ? 'awaiting' : 'working';
}
```

c) `TranscriptParser`: campo + logica nel blocco assistant. Aggiungere il campo accanto a `seenTool` (riga 161):

```ts
private seenError = new Set<string>();
```

Nel blocco `if (d.type === 'assistant')`, sostituire la parte finale (righe 199-202):

```ts
      // un menu a scelta multipla lascia il CLI in attesa dell'umano a prescindere
      // dallo stop_reason (tool_use) di quella riga.
      this.state = sawPrompt ? 'awaiting' : (stop === 'end_turn' ? 'awaiting' : 'working');
      return events;
```

con:

```ts
      // stop_reason "max_tokens": il turno si è interrotto per limite di output —
      // errore serio da segnalare, una sola notifica per id messaggio.
      if (stop === 'max_tokens') {
        const key = `e:${mid}`;
        if (!this.seenError.has(key)) {
          this.seenError.add(key);
          events.push({ type: 'error', message: 'Claude hit the output limit (max_tokens). Ask it to continue.' });
        }
      }
      // un menu a scelta multipla lascia il CLI in attesa dell'umano a prescindere
      // dallo stop_reason (tool_use) di quella riga.
      this.state = sawPrompt ? 'awaiting' : (stop === 'end_turn' || stop === 'max_tokens' ? 'awaiting' : 'working');
      return events;
```

- [ ] **Step 4: eseguire i test e verificarne il passaggio**

Run: `npx vitest run test/transcript.test.ts`
Expected: PASS (tutti i test, inclusi i nuovi 3).

- [ ] **Step 5: commit**

```bash
git add src/sessions/transcript.ts test/transcript.test.ts
git commit -m "feat: detect max_tokens in transcript as a serious error"
```

---

### Task 2: `TranscriptWatcher` inoltra l'evento `error` come `session.error`

**Files:**
- Modify: `src/sessions/transcript-watcher.ts` (`emit`, righe 108-134)
- Create: `test/transcript-watcher.test.ts`

**Interfaces:**
- Consumes: `TranscriptErrorEvent` (Task 1), `Session` (esistente), `Bus` (esistente).
- Produces: sul bus, `{ type: 'session.error'; sessionId: string; message: string }` per ogni evento `error`. Nessun `setStatus('error')`: lo stato resta gestito da `applyState` (parser → `awaiting` → `awaiting-input`).

- [ ] **Step 1: scrivere il test fallente** — nuovo file `test/transcript-watcher.test.ts` (stile di `test/tmux-watcher.test.ts`: `loadConfig`, `StateStore`, `SessionManager`, accesso ai private via `as any`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { TranscriptWatcher } from '../src/sessions/transcript-watcher.js';

function makeWatcher() {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-twatch-'));
  const config = loadConfig({ STATE_DIR: dir });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const watcher = new TranscriptWatcher({
    config, manager, bus,
    ollamaModels: async () => new Set<string>(),
  });
  return { manager, watcher, bus };
}

describe('TranscriptWatcher', () => {
  it('forwards a max_tokens error event as session.error', () => {
    const { manager, watcher, bus } = makeWatcher();
    const onError = vi.fn();
    bus.on('session.error', onError);
    const s = manager.registerTerminal({ title: 'p', projectDir: '/tmp/p', tmuxTarget: 'claude:p' });
    const msg = 'Claude hit the output limit (max_tokens). Ask it to continue.';
    (watcher as any).emit(s, { type: 'error', message: msg });
    expect(onError).toHaveBeenCalledWith({ type: 'session.error', sessionId: s.id, message: msg });
  });
});
```

- [ ] **Step 2: eseguire il test e verificarne il fallimento**

Run: `npx vitest run test/transcript-watcher.test.ts`
Expected: FAIL — `onError` non è mai stato chiamato (oggi l'evento `error` finisce nel ramo `else` di `emit`, trattato come `tool_result`).

- [ ] **Step 3: implementazione minima** — in `emit`, subito dopo il blocco `if (ev.type === 'prompt') { … }` (riga 115):

```ts
    if (ev.type === 'error') {
      manager.touch(s.id);
      bus.emit({ type: 'session.error', sessionId: s.id, message: ev.message });
      return;
    }
```

- [ ] **Step 4: eseguire il test e verificarne il passaggio**

Run: `npx vitest run test/transcript-watcher.test.ts`
Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add src/sessions/transcript-watcher.ts test/transcript-watcher.test.ts
git commit -m "feat: forward transcript errors as session.error"
```

---

### Task 3: `ToolBurstAggregator` (classe testabile)

**Files:**
- Modify: `bot/telegram.ts` (dopo `EditThrottler`, riga 137)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: niente (classe autonoma, come `EditThrottler`).
- Produces: `export interface ToolBurstSink { edit(messageId: number, text: string): Promise<boolean>; send(text: string): Promise<number | undefined> }` e `export class ToolBurstAggregator { constructor(sink: ToolBurstSink, maxLen?: number); push(line: string): Promise<void>; close(): void }`.

- [ ] **Step 1: scrivere i test fallenti** — nuovo blocco `describe('ToolBurstAggregator')` in `test/telegram.test.ts`. Aggiungere `ToolBurstAggregator` all'import esistente (riga 2) e un import type a parte:

```ts
import { ToolBurstAggregator } from '../bot/telegram.js';
import type { ToolBurstSink } from '../bot/telegram.js';
```

```ts
describe('ToolBurstAggregator', () => {
  function makeAgg(maxLen = 3800) {
    const edits: { id: number; text: string }[] = [];
    const sends: string[] = [];
    let nextId = 1;
    const sink: ToolBurstSink = {
      edit: vi.fn(async (id: number, text: string) => { edits.push({ id, text }); return true; }),
      send: vi.fn(async (text: string) => { sends.push(text); return nextId++; }),
    };
    const agg = new ToolBurstAggregator(sink, maxLen);
    return { agg, sink, edits, sends };
  }
  it('sends on first push, edits on following pushes', async () => {
    const { agg, sink, edits, sends } = makeAgg();
    await agg.push('t1');
    await agg.push('t2');
    await agg.push('t3');
    expect(sends).toEqual(['t1']);
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(edits).toEqual([
      { id: 1, text: 't1\nt2' },
      { id: 1, text: 't1\nt2\nt3' },
    ]);
  });
  it('close() closes the burst: the next push starts a new bubble', async () => {
    const { agg, sink } = makeAgg();
    await agg.push('t1');
    agg.close();
    await agg.push('t2');
    expect(sink.send).toHaveBeenCalledTimes(2);
    expect(sink.edit).not.toHaveBeenCalled();
  });
  it('starts a new bubble when appending would exceed maxLen', async () => {
    const { agg, sink, edits, sends } = makeAgg(5);
    await agg.push('t1'); // send
    await agg.push('t2'); // 't1\nt2' = 5 ≤ 5 → edit
    await agg.push('t3'); // 't1\nt2\nt3' = 8 > 5 → send
    expect(sends).toEqual(['t1', 't3']);
    expect(edits).toEqual([{ id: 1, text: 't1\nt2' }]);
  });
  it('falls back to a new bubble when the edit fails', async () => {
    const { agg, sink, sends } = makeAgg();
    (sink.edit as any).mockImplementation(async () => false);
    await agg.push('t1');
    await agg.push('t2');
    expect(sends).toEqual(['t1', 't2']);
  });
});
```

- [ ] **Step 2: eseguire i test e verificarne il fallimento**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — `ToolBurstAggregator` non esiste ancora.

- [ ] **Step 3: implementazione minima** — in `bot/telegram.ts`, subito dopo la chiusura della classe `EditThrottler` (riga 137):

```ts
// Aggregazione delle notifiche tool in una bubble per raffica: il primo tool_use
// crea il messaggio, i successivi lo modificano (edit) finché la raffica è aperta.
// `close()` viene chiamato su testo/domanda/permesso/errore → la raffica successiva
// apre una bubble nuova. Cap su maxLen: oltre il limite si apre una bubble nuova.
export interface ToolBurstSink {
  edit(messageId: number, text: string): Promise<boolean>;
  send(text: string): Promise<number | undefined>;
}

export class ToolBurstAggregator {
  private open?: { messageId: number; text: string; at: number };
  private lastWasTool = false;

  constructor(private sink: ToolBurstSink, private maxLen = 3800) {}

  async push(line: string): Promise<void> {
    const open = this.open;
    if (this.lastWasTool && open) {
      const next = `${open.text}\n${line}`;
      if (next.length <= this.maxLen && await this.sink.edit(open.messageId, next)) {
        open.text = next;
        open.at = Date.now();
        return;
      }
    }
    const id = await this.sink.send(line);
    if (id !== undefined) this.open = { messageId: id, text: line, at: Date.now() };
    this.lastWasTool = true;
  }

  close(): void {
    this.open = undefined;
    this.lastWasTool = false;
  }
}
```

- [ ] **Step 4: eseguire i test e verificarne il passaggio**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS (i 4 nuovi test + quelli esistenti).

- [ ] **Step 5: commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat: ToolBurstAggregator — one bubble per tool burst"
```

---

### Task 4: Cablaggio del bot (via le notifiche di stato, push/close sui tool)

**Files:**
- Modify: `bot/telegram.ts` — campo `lastNotified` (riga 158); handler `session.updated` (righe 472-485); handler `session.tool` (righe 496-501); handler `session.text` (righe 466-471); `session.prompt` (righe 486-495); `session.permission` (righe 502-510); `session.error` (riga 512).

**Interfaces:**
- Consumes: `ToolBurstAggregator`/`ToolBurstSink` (Task 3), `EditThrottler` (esistente).
- Produces: nessuna API nuova verso l'esterno.

- [ ] **Step 1: rimuovere la mappa `lastNotified` e aggiungere `toolBursts`** (riga 158):

```ts
private lastMsg = new Map<string, { messageId: number; text: string; at: number; role: 'user' | 'assistant' }>();
private lastNotified = new Map<string, Session['status']>();
```

→

```ts
private lastMsg = new Map<string, { messageId: number; text: string; at: number; role: 'user' | 'assistant' }>();
private toolBursts = new Map<string, ToolBurstAggregator>();
```

- [ ] **Step 2: aggiungere l'helper `toolBurst(sessionId)`** — subito dopo il metodo `forwardText` (riga 204):

```ts
  // Bubble di raffica per le notifiche tool (una per sessione); il sink usa
  // l'EditThrottler condiviso e l'API del bot. `close()` è chiamato dai handler
  // di testo/domanda/permesso/errore (via `toolBurst(id).close()`).
  private toolBurst(sessionId: string): ToolBurstAggregator {
    let agg = this.toolBursts.get(sessionId);
    if (!agg) {
      agg = new ToolBurstAggregator({
        edit: async (messageId, text) => {
          const chatId = this.chatId;
          if (!chatId) return false;
          const ok = await this.throttler.throttled(() =>
            this.bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' }).then(() => true).catch(() => false));
          return ok ?? false;
        },
        send: async text => {
          const chatId = this.chatId;
          if (!chatId) return undefined;
          const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => undefined);
          return msg?.message_id;
        },
      });
      this.toolBursts.set(sessionId, agg);
    }
    return agg;
  }
```

- [ ] **Step 3: rimuovere il handler `session.updated`** (righe 472-485) — eliminare l'intero blocco commentato `// Stato della sessione terminale attiva: "al lavoro" vs "in attesa di te".` … `});`.

- [ ] **Step 4: `session.tool` → push aggregato** (righe 496-501):

```ts
    bus.on('session.tool', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.kind === 'tool_use' && e.sessionId === this.activeSessionId && e.input) {
        const line = `🔧 <code>${htmlEscape(e.toolName)}</code> — <pre>${htmlEscape(JSON.stringify(e.input).slice(0, 300))}</pre>`;
        void this.toolBurst(e.sessionId).push(line);
      }
    });
```

- [ ] **Step 5: chiudere la raffica su testo / domanda / permesso / errore**:

`session.text` (riga 468, dentro il guard `sessionId !== this.activeSessionId`):

```ts
      this.toolBurst(e.sessionId).close(); // il testo chiude la raffica di tool
```

`session.prompt` (riga 487, dopo `if (sessionId !== this.activeSessionId) return;`):

```ts
      this.toolBurst(sessionId).close();
```

`session.permission` (riga 503, dentro `if (!this.deps.manager.isArmed()) return;`):

```ts
      this.toolBurst(permission.sessionId).close();
```

`session.error` (riga 512):

```ts
    bus.on('session.error', e => {
      if (!this.deps.manager.isArmed() || e.sessionId !== this.activeSessionId) return;
      this.toolBurst(e.sessionId).close();
      this.notify(`❌ <b>${htmlEscape(e.message.slice(0, 500))}</b>`);
    });
```

- [ ] **Step 6: verificare typecheck e tutta la suite**

Run: `npm run typecheck && npm test`
Expected: typecheck senza errori; tutti i test PASS.

- [ ] **Step 7: commit**

```bash
git add bot/telegram.ts
git commit -m "feat: group tool notices per burst, drop status bubbles"
```

---

### Task 5: Documentazione

**Files:**
- Modify: `README.md` (righe 150-156)
- Modify: `CHANGELOG.md` (righe 11-17)

- [ ] **Step 1: aggiornare `README.md`** — sostituire nel bullet "Chat, not screen":

```
  markdown, your prompts echoed, tool calls as `🔧` notices, and a
  "⚠️ Claude is waiting for your response" bubble when the session is your
  turn. History is never replayed: streaming starts from the moment you select
```

con:

```
  markdown, your prompts echoed, tool calls grouped into a single `🔧` notice
  per work burst (the first call creates the bubble, the following ones update
  it). Notifications are event-driven — `❓` questions, permission buttons, `❌`
  on serious errors — with no status chatter while Claude works. History is
  never replayed: streaming starts from the moment you select
```

- [ ] **Step 2: aggiornare `CHANGELOG.md`** — sostituire nel bullet "Chat streaming for terminal sessions":

```
  prompts echoed, tool calls as `🔧` notices, and a "waiting for your response"
  bubble when it's your turn. Multiple-choice questions arrive as `❓` with the
  options (reply with the option number). `/view` still grabs the raw screen.
  History is never replayed.
```

con:

```
  prompts echoed, tool calls grouped into one `🔧` notice per work burst (the
  first call creates the bubble, later ones update it). Notifications are
  event-driven: `❓` questions with the options (reply with the option number),
  permission buttons, and a `❌` on serious errors (e.g. `max_tokens`) — no
  status chatter while Claude works. `/view` still grabs the raw screen.
  History is never replayed.
```

- [ ] **Step 3: verifica finale**

Run: `npm run typecheck && npm test`
Expected: typecheck senza errori; tutti i test PASS.

- [ ] **Step 4: commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: reflect burst-grouped tool notices and event-driven notifications"
```
