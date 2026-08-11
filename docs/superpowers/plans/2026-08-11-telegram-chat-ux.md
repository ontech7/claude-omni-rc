# UX/UI della chat Telegram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere leggibile la chat Telegram — tool call descritte a parole, Skill/MCP/subagent riconoscibili, fallimenti visibili, markdown reso bene — e separare l'attività dei subagent dalla sessione principale dietro una scheda espandibile.

**Architecture:** Tutta la presentazione esce da `bot/telegram.ts` (2512 righe) in un modulo nuovo `bot/render.ts` di sole funzioni pure, testabile senza bot. Il mescolamento dei subagent si risolve alla fonte, in `src/sessions/sdk-driver.ts`, propagando `parent_tool_use_id` sul bus e traducendo i messaggi `system` di tipo task in un evento `session.agent`; il bot instrada gli eventi con un parent verso una scheda per agent invece che nello stream principale.

**Tech Stack:** Node 22+, TypeScript strict ESM (nessuno step di build, `tsx` esegue i sorgenti), Vitest, grammY, `@anthropic-ai/claude-agent-sdk`.

**Spec di riferimento:** `docs/superpowers/specs/2026-08-11-telegram-chat-ux-design.md`
**Branch:** `feat/telegram-ux` (già creato, tre commit di docs)

## Global Constraints

- **Nessuna dipendenza runtime nuova.** Il budget è tre: `@anthropic-ai/claude-agent-sdk`, `grammy`, `dotenv`. `@grammyjs/stream` è escluso per decisione presa.
- **Import relativi con estensione `.js`** anche per i sorgenti `.ts` (`import { Bus } from './bus.js'`). Vale anche nei test.
- **Ogni frammento dinamico mandato a Telegram passa da `htmlEscape`**, e ogni invio passa da `this.send()` / `sendChunked` così `splitHtmlMessage` gestisce il limite di 4096. Entrambi i fallimenti sono silenziosi: il messaggio semplicemente non arriva.
- **`process.env` si legge solo in `loadConfig()`** (`src/config.ts`). Altrove è invisibile ai test, a `.env.example` e all'installer.
- **Stringhe user-facing e docs in inglese.** I commenti nuovi in inglese; i commenti italiani esistenti si lasciano stare.
- **Commenti spiegano il perché, non il cosa.** Se un commento esistente sembra contraddire la tua modifica, rallenta invece di cancellarlo.
- **Conventional Commits** con scope opzionale (`feat(bot):`, `fix(render):`, `test(render):`, `docs:`), imperativi, una preoccupazione per commit. Mai commit diretti su `main`.
- **Il cancello è `npm run typecheck && npm test`.** Non c'è linter, formatter, soglia di coverage né e2e.
- **Nei test niente di reale**: nessuna chiamata Telegram, nessun `tmux`, nessun `fetch` vivo, nessuna scrittura in `~/.claude-omni-rc` o `~/.claude`. Config sempre da `loadConfig({...})`, mai da `process.env`.
- **Un file di test per modulo**: `bot/render.ts` → `test/render.test.ts`. `vitest.config.ts` raccoglie solo `test/**/*.test.ts`.

## File Structure

| File | Responsabilità | Stato |
|---|---|---|
| `bot/render.ts` | **Nuovo.** Presentazione pura: escaping, markdown→HTML, bilanciamento e split dei tag, descrizione delle tool call, accorciamento dei path, rendering della scheda agent. Zero I/O, zero stato. | Task 1, 2, 3, 5, 9 |
| `test/render.test.ts` | **Nuovo.** Test del modulo sopra. | Task 1, 2, 3, 5, 9 |
| `bot/telegram.ts` | Resta il trasporto: bus, invii, throttling, flow di domande/permessi, callback. Perde ~250 righe di presentazione e tutto il percorso di summary via LLM. | Task 1, 4, 6, 7, 10 |
| `src/types.ts` | Contratto del bus: `parentToolUseId` su `session.text`/`session.tool`, nuovo evento `session.agent`. | Task 8 |
| `src/sessions/sdk-driver.ts` | Propaga `parent_tool_use_id`, traduce i messaggi `system` task in `session.agent`. | Task 8 |
| `src/ollama.ts` | Perde `summarize()`. Restano `hasVision`, `modelContext`, `listModels`. | Task 4 |
| `test/telegram.test.ts` | Perde i blocchi spostati in `render.test.ts` e quelli delle parti rimosse. | Task 1, 4 |
| `test/ollama.test.ts` | Perde i test di `summarize()`. | Task 4 |
| `test/sdk-driver.test.ts` | Guadagna i test su `parentToolUseId` e `session.agent`. | Task 8 |
| `README.md`, `AI-GUIDE.md`, `CHANGELOG.md`, `CLAUDE.md` | Documentazione allineata nello stesso commit del codice. | Task 11 |

---

### Task 1: Estrarre `bot/render.ts`

Spostamento puro, **zero cambi di comportamento**. Serve a dare una casa alle funzioni dei task successivi e a rendere `telegram.ts` maneggiabile.

**Files:**
- Create: `bot/render.ts`
- Create: `test/render.test.ts`
- Modify: `bot/telegram.ts` (rimuove le definizioni, aggiunge l'import)
- Modify: `test/telegram.test.ts` (import e blocchi spostati)

**Interfaces:**
- Consumes: niente (primo task)
- Produces: `htmlEscape(s: string): string`, `mdToHtml(text: string): string`, `balanceHtml(html: string): string`, `splitHtmlMessage(html: string, max?: number): string[]`, `truncateAtWord(s: string, max: number): string`, `SEND_MAX_CHARS: number` — tutti esportati da `bot/render.ts`.

- [ ] **Step 1: Creare `bot/render.ts` con le funzioni spostate**

Taglia da `bot/telegram.ts` e incolla in un nuovo `bot/render.ts`, **senza modificarne il corpo**, queste definizioni con i loro commenti:

- `htmlEscape` (riga 128)
- `mdToHtml` (riga 157)
- `balanceHtml` (riga 184)
- `SEND_MAX_CHARS` (riga 220) e la costante `HTML_TAG` (riga 221)
- `splitHtmlMessage` (riga 223)
- `truncateAtWord` (riga 650)

Intestazione del file nuovo:

```ts
// Presentazione pura per la chat Telegram: markdown → HTML, bilanciamento e
// split dei tag, descrizione delle tool call. Nessun I/O e nessuno stato, così
// ogni regola di formattazione si testa come input → output invece che
// attraverso il bot.
```

- [ ] **Step 2: Importare in `bot/telegram.ts`**

In cima a `bot/telegram.ts`, dopo gli import esistenti:

```ts
import { htmlEscape, mdToHtml, balanceHtml, splitHtmlMessage, truncateAtWord, SEND_MAX_CHARS } from './render.js';
```

`telegram.ts` **non** ri-esporta questi nomi: un livello di ri-export sopravvive per sempre e nasconde dove vive davvero la logica. I consumatori importano da `render.js`.

- [ ] **Step 3: Spostare i test**

Crea `test/render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mdToHtml, balanceHtml, splitHtmlMessage, truncateAtWord, htmlEscape } from '../bot/render.js';
```

Sposta dentro, invariati, i blocchi `describe` di `test/telegram.test.ts`:
- `describe('mdToHtml v2 / balanceHtml', ...)` (riga 493)
- `describe('splitHtmlMessage', ...)` (riga 865)

In `test/telegram.test.ts`: togli `splitHtmlMessage`, `mdToHtml`, `balanceHtml`, `truncateAtWord` dall'import da `../bot/telegram.js` e aggiungi `import { truncateAtWord, mdToHtml } from '../bot/render.js';` (servono ancora a `describe('renderHistory v2 / truncateAtWord')` alla riga 550 e a `describe('renderHistory')` alla riga 285).

- [ ] **Step 4: Verificare che tutto passi immutato**

```bash
npm run typecheck && npm test
```
Atteso: PASS, stesso numero di test di prima. Se un test fallisce, hai modificato un corpo di funzione: annulla e rifai lo spostamento alla lettera.

- [ ] **Step 5: Commit**

```bash
git add bot/render.ts test/render.test.ts bot/telegram.ts test/telegram.test.ts
git commit -m "refactor(render): estrai la presentazione da telegram.ts in bot/render.ts"
```

---

### Task 2: `shortenPath()`

È la funzione che elimina la maggior parte dell'illeggibilità: i path assoluti.

**Files:**
- Modify: `bot/render.ts`
- Modify: `test/render.test.ts`

**Interfaces:**
- Consumes: niente
- Produces: `shortenPath(p: string, projectDir?: string, maxLen?: number): string`

- [ ] **Step 1: Scrivere i test che falliscono**

In `test/render.test.ts`, aggiungi `shortenPath` all'import e in fondo:

```ts
describe('shortenPath', () => {
  const proj = '/Users/tizio/Progetti/app';

  it('rende relativo un path dentro il progetto', () => {
    expect(shortenPath(`${proj}/bot/telegram.ts`, proj)).toBe('bot/telegram.ts');
  });

  it('non scambia per prefisso una directory sorella', () => {
    // '/Users/tizio/Progetti/app-2' inizia per '/Users/tizio/Progetti/app'
    expect(shortenPath('/Users/tizio/Progetti/app-2/x.ts', proj)).toContain('app-2');
  });

  it('sostituisce la home con ~ fuori dal progetto', () => {
    const home = process.env.HOME ?? '/Users/tizio';
    expect(shortenPath(`${home}/altrove/nota.md`, proj)).toBe('~/altrove/nota.md');
  });

  it('lascia assoluto un path fuori da progetto e home', () => {
    expect(shortenPath('/etc/hosts', proj)).toBe('/etc/hosts');
  });

  it('elide i segmenti centrali oltre maxLen mantenendo il nome del file', () => {
    const lungo = `${proj}/` + 'segmento/'.repeat(12) + 'finale.ts';
    const out = shortenPath(lungo, proj, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toContain('…');
    expect(out.endsWith('finale.ts')).toBe(true);
  });

  it('restituisce la stringa vuota per un input vuoto', () => {
    expect(shortenPath('', proj)).toBe('');
  });

  it('funziona senza projectDir', () => {
    expect(shortenPath('/etc/hosts')).toBe('/etc/hosts');
  });
});
```

- [ ] **Step 2: Eseguire i test per vederli fallire**

```bash
npx vitest run test/render.test.ts -t shortenPath
```
Atteso: FAIL, `shortenPath is not a function`.

- [ ] **Step 3: Implementare in `bot/render.ts`**

```ts
// I path assoluti sono il singolo motivo per cui una tool call risulta
// illeggibile in chat: '/Users/tizio/Progetti/app/bot/telegram.ts' dice molto
// meno di 'bot/telegram.ts'. Il confine è il separatore, non il prefisso: senza
// il controllo su '/' una directory sorella ('app-2') verrebbe accorciata come
// se stesse dentro il progetto.
export function shortenPath(p: string, projectDir?: string, maxLen = 50): string {
  if (!p) return '';
  let out = p;
  const strip = (base: string | undefined, replacement: string): boolean => {
    if (!base) return false;
    const b = base.endsWith('/') ? base.slice(0, -1) : base;
    if (out === b) { out = replacement || '.'; return true; }
    if (out.startsWith(`${b}/`)) { out = replacement + out.slice(b.length + (replacement ? 0 : 1)); return true; }
    return false;
  };
  if (!strip(projectDir, '')) strip(process.env.HOME, '~');
  if (out.length <= maxLen) return out;
  // Elisione al centro: la coda (il nome del file) è la parte che identifica
  // la riga, la testa dà il contesto. È il centro a essere sacrificabile.
  const parts = out.split('/');
  const last = parts[parts.length - 1];
  const first = parts.length > 1 ? parts[0] : '';
  const candidate = first ? `${first}/…/${last}` : `…/${last}`;
  if (candidate.length <= maxLen) return candidate;
  return last.length <= maxLen ? last : `…${last.slice(-(maxLen - 1))}`;
}
```

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run test/render.test.ts -t shortenPath
```
Atteso: PASS (7 test).

- [ ] **Step 5: Commit**

```bash
git add bot/render.ts test/render.test.ts
git commit -m "feat(render): accorcia i path relativi al progetto o alla home"
```

---

### Task 3: `describeTool()` e `renderToolLine()`

Il catalogo deterministico che sostituisce `summarizeTool`. Qui non si tocca ancora `telegram.ts`: questo task produce le funzioni, il Task 4 le collega.

**Files:**
- Modify: `bot/render.ts`
- Modify: `test/render.test.ts`

**Interfaces:**
- Consumes: `shortenPath` (Task 2), `htmlEscape`, `truncateAtWord` (Task 1)
- Produces:
  ```ts
  export interface ToolLine { icon: string; label: string; target?: string; detail?: string; code?: string }
  export function describeTool(toolName: string, input: Record<string, unknown>, projectDir?: string): ToolLine
  export function renderToolLine(line: ToolLine): string
  ```

- [ ] **Step 1: Scrivere i test che falliscono**

Aggiungi `describeTool`, `renderToolLine` all'import di `test/render.test.ts` e in fondo:

```ts
describe('describeTool', () => {
  const proj = '/Users/tizio/Progetti/app';

  it('usa la description di Bash, non il comando', () => {
    const l = describeTool('Bash', { command: 'cd /Users/tizio/Progetti/app && npm ci', description: 'Install dependencies' }, proj);
    expect(l.label).toBe('Bash');
    expect(l.detail).toBe('Install dependencies');
    expect(l.code).toContain('npm ci');
  });

  it('ripiega sul comando se la description manca', () => {
    const l = describeTool('Bash', { command: 'ls -la' }, proj);
    expect(l.detail).toBe('ls -la');
  });

  it('accorcia il path di Read', () => {
    expect(describeTool('Read', { file_path: `${proj}/bot/telegram.ts` }, proj).target).toBe('bot/telegram.ts');
  });

  it('distingue Write da Edit', () => {
    expect(describeTool('Write', { file_path: `${proj}/a.ts` }, proj).label).toBe('Write');
    expect(describeTool('Edit', { file_path: `${proj}/a.ts` }, proj).label).toBe('Edit');
  });

  it('riporta l intervallo di righe di Read quando presente', () => {
    expect(describeTool('Read', { file_path: `${proj}/a.ts`, offset: 10, limit: 5 }, proj).detail).toBe('lines 10–14');
  });

  it('riconosce una Skill', () => {
    const l = describeTool('Skill', { skill: 'editing-the-landing-page' }, proj);
    expect(l.label).toBe('Skill');
    expect(l.target).toBe('editing-the-landing-page');
  });

  it('scompone il nome di un tool MCP', () => {
    const l = describeTool('mcp__context7__query-docs', { query: 'come si usa X' }, proj);
    expect(l.label).toBe('MCP context7');
    expect(l.target).toBe('query-docs');
    expect(l.detail).toBe('come si usa X');
  });

  it('regge un server MCP con underscore nel nome', () => {
    const l = describeTool('mcp__my_server__do_thing', {}, proj);
    expect(l.label).toBe('MCP my_server');
    expect(l.target).toBe('do_thing');
  });

  it('salta le chiavi non descrittive per il detail di un tool MCP', () => {
    expect(describeTool('mcp__ctx__q', { libraryId: '/org/p', query: 'vero intento' }, proj).detail).toBe('vero intento');
  });

  it('descrive un subagent', () => {
    const l = describeTool('Task', { subagent_type: 'Explore', description: 'trova i punti di rendering' }, proj);
    expect(l.target).toBe('Explore');
    expect(l.detail).toBe('trova i punti di rendering');
  });

  it('conta i todo e mostra la voce in corso', () => {
    const l = describeTool('TodoWrite', { todos: [
      { content: 'a', status: 'completed' },
      { content: 'guarda qui', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ] }, proj);
    expect(l.target).toBe('1/3');
    expect(l.detail).toBe('guarda qui');
  });

  it('ripiega sul primo valore stringa per un tool sconosciuto', () => {
    const l = describeTool('QualcosaDiNuovo', { foo: 'valore utile' }, proj);
    expect(l.label).toBe('QualcosaDiNuovo');
    expect(l.detail).toBe('valore utile');
  });

  it('non esplode su input vuoto', () => {
    expect(() => describeTool('Boh', {}, proj)).not.toThrow();
  });
});

describe('renderToolLine', () => {
  it('compone icona, etichetta, target e detail', () => {
    const out = renderToolLine({ icon: '📖', label: 'Read', target: 'bot/telegram.ts', detail: 'lines 1–20' });
    expect(out).toBe('📖 <b>Read</b> · <code>bot/telegram.ts</code> — lines 1–20');
  });

  it('salta i pezzi assenti', () => {
    expect(renderToolLine({ icon: '⚙️', label: 'Boh' })).toBe('⚙️ <b>Boh</b>');
  });

  it('escapa i frammenti dinamici', () => {
    const out = renderToolLine({ icon: '⚡', label: 'Bash', detail: 'a < b & c' });
    expect(out).toContain('a &lt; b &amp; c');
    expect(out).not.toContain('a < b');
  });

  it('mette il comando su una seconda riga in code', () => {
    const out = renderToolLine({ icon: '⚡', label: 'Bash', detail: 'Install', code: 'npm ci' });
    expect(out).toBe('⚡ <b>Bash</b> — Install\n<code>npm ci</code>');
  });
});
```

- [ ] **Step 2: Eseguire i test per vederli fallire**

```bash
npx vitest run test/render.test.ts -t describeTool
```
Atteso: FAIL, `describeTool is not a function`.

- [ ] **Step 3: Implementare in `bot/render.ts`**

```ts
export interface ToolLine {
  icon: string;
  label: string;     // etichetta fissa, sempre in inglese
  target?: string;   // reso dentro <code>
  detail?: string;   // testo libero, può essere nella lingua del modello
  code?: string;     // solo Bash: il comando, su una riga a parte
}

const DETAIL_MAX = 100;
const CODE_MAX = 200;

// Chiavi che identificano una risorsa invece di descrivere un intento: come
// `detail` di un tool MCP non dicono niente all'umano che legge la chat.
const OPAQUE_KEYS = new Set(['libraryid', 'id', 'token', 'apikey', 'signal', 'uuid', 'sessionid']);

function firstMeaningfulString(input: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(input)) {
    if (OPAQUE_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function str(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

// Il CLI scrive sempre un `description` sulle tool call Bash ("Install
// dependencies"): è una frase pensata per un umano, mentre `command` è il
// motivo per cui la chat era illeggibile. La description vince, il comando
// resta sotto per chi vuole il dettaglio.
export function describeTool(toolName: string, input: Record<string, unknown>, projectDir?: string): ToolLine {
  const name = toolName.toLowerCase();
  const path = (...keys: string[]): string | undefined => {
    const p = str(input, ...keys);
    return p ? shortenPath(p, projectDir) : undefined;
  };

  if (name.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const cut = rest.lastIndexOf('__');
    const server = cut === -1 ? rest : rest.slice(0, cut);
    const tool = cut === -1 ? undefined : rest.slice(cut + 2);
    return { icon: '🔌', label: `MCP ${server}`, target: tool, detail: firstMeaningfulString(input) };
  }

  switch (name) {
    case 'bash': {
      const cmd = str(input, 'command');
      return { icon: '⚡', label: 'Bash', detail: str(input, 'description') ?? cmd, code: cmd };
    }
    case 'read': case 'readfile': {
      const offset = typeof input.offset === 'number' ? input.offset : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      const range = offset !== undefined && limit !== undefined ? `lines ${offset}–${offset + limit - 1}` : undefined;
      return { icon: '📖', label: 'Read', target: path('file_path', 'path'), detail: range };
    }
    case 'write': case 'writefile':
      return { icon: '📝', label: 'Write', target: path('file_path', 'path') };
    case 'edit': case 'multiedit':
      return { icon: '✏️', label: 'Edit', target: path('file_path', 'path'), detail: input.replace_all === true ? 'replace all' : undefined };
    case 'notebookedit':
      return { icon: '📓', label: 'Notebook', target: path('notebook_path', 'path') };
    case 'glob':
      return { icon: '🔍', label: 'Glob', target: str(input, 'pattern'), detail: path('path') };
    case 'grep':
      return { icon: '🔎', label: 'Grep', target: str(input, 'pattern'), detail: path('path') };
    case 'webfetch': {
      const url = str(input, 'url');
      let host = url;
      try { if (url) host = new URL(url).hostname; } catch { /* URL malformato: resta il testo grezzo */ }
      return { icon: '🌐', label: 'Fetch', target: host, detail: str(input, 'prompt') };
    }
    case 'websearch':
      return { icon: '🔎', label: 'Search', target: str(input, 'query') };
    case 'task':
      return { icon: '🤖', label: 'Agent', target: str(input, 'subagent_type'), detail: str(input, 'description') };
    case 'skill':
      return { icon: '🧩', label: 'Skill', target: str(input, 'skill'), detail: str(input, 'args') };
    case 'slashcommand':
      return { icon: '⌨️', label: 'Command', target: str(input, 'command') };
    case 'workflow':
      return { icon: '🎛', label: 'Workflow', target: str(input, 'name'), detail: str(input, 'description') };
    case 'exitplanmode':
      return { icon: '📋', label: 'Plan' };
    case 'todowrite': case 'todoread': {
      const todos = Array.isArray(input.todos) ? input.todos as { content?: unknown; status?: unknown }[] : [];
      const done = todos.filter(t => t?.status === 'completed').length;
      const current = todos.find(t => t?.status === 'in_progress');
      return {
        icon: '📋', label: 'Todo',
        target: todos.length ? `${done}/${todos.length}` : undefined,
        detail: typeof current?.content === 'string' ? current.content : undefined,
      };
    }
    default:
      return { icon: '⚙️', label: toolName, detail: firstMeaningfulString(input) };
  }
}

export function renderToolLine(line: ToolLine): string {
  let out = `${line.icon} <b>${htmlEscape(line.label)}</b>`;
  if (line.target) out += ` · <code>${htmlEscape(truncateAtWord(line.target, DETAIL_MAX))}</code>`;
  if (line.detail) out += ` — ${htmlEscape(truncateAtWord(line.detail, DETAIL_MAX))}`;
  if (line.code) out += `\n<code>${htmlEscape(truncateAtWord(line.code, CODE_MAX))}</code>`;
  return out;
}
```

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run test/render.test.ts
```
Atteso: PASS. Se `truncateAtWord` aggiunge `… (truncated)` dentro un `<code>` e un test sulla lunghezza fallisce, è atteso: i test sopra usano stringhe corte, nessuna supera i limiti.

- [ ] **Step 5: Commit**

```bash
git add bot/render.ts test/render.test.ts
git commit -m "feat(render): catalogo deterministico per la descrizione delle tool call"
```

---

### Task 4: Collegare il catalogo e rimuovere il summarizer via LLM

**Files:**
- Modify: `bot/telegram.ts` (righe 681-717, 1284-1317, 2445-2456, campi privati 1073/1077)
- Modify: `src/ollama.ts` (rimuove `summarize`, righe 50-85)
- Modify: `test/telegram.test.ts` (rimuove `describe('summarizeTool')` riga 644 e `describe('SummarizeQueue')` riga 459)
- Modify: `test/ollama.test.ts` (rimuove i test di `summarize`)

**Interfaces:**
- Consumes: `describeTool`, `renderToolLine` (Task 3)
- Produces: nessuna API nuova. La bolla tool riceve righe già renderizzate.

- [ ] **Step 1: Rimuovere `summarizeTool` e il percorso LLM**

Da `bot/telegram.ts` cancella:
- `summarizeTool` (righe 677-717) e il suo commento
- `SummarizeQueue` (riga 989) e il tipo/classe interi
- `llmSummarize` (righe 1281-1298), `summarizeToolLine` (1300-1311), `resetSummarize` (1313-1317)
- i campi `private summarizeQueues` (1073) e `private summaryCache` (1077)
- `ollama` dalle `deps` **solo se non serve più altrove**: serve ancora (riga 2315 usa `hasVision`), quindi **lascialo**.

Ogni chiamata a `this.resetSummarize(x)` va cancellata insieme alla funzione: cerca `resetSummarize` e rimuovi le chiamate nei gestori di `session.text`, `session.prompt`, `session.permission`, `session.dialog`, `session.result`, `session.error`.

Da `src/ollama.ts` cancella `summarize()` (righe 50-85). Restano `hasVision`, `modelContext`, `listModels`.

- [ ] **Step 2: Collegare `describeTool` nel gestore `session.tool`**

In `bot/telegram.ts`, sostituisci il corpo del gestore (righe 2445-2456) con:

```ts
    bus.on('session.tool', e => {
      if (!this.passes('tool', e.sessionId, e.eventId).deliver) return;
      if (e.kind !== 'tool_use' || !e.input) return;
      this.typing.start(); // il modello sta lavorando di nuovo
      const session = this.deps.manager.get(e.sessionId);
      const line = renderToolLine(describeTool(e.toolName, e.input, session?.projectDir));
      void this.toolBurst(e.sessionId).push(line);
    });
```

Nota: `push` riceve una stringa **già HTML** — `renderToolLine` ha già fatto l'escaping dei frammenti dinamici. Il vecchio codice faceva `htmlEscape(line)` sull'intera riga perché la summary era testo grezzo; farlo ora escaperebbe i tag e mostrerebbe `&lt;b&gt;` in chat.

Aggiungi all'import da `./render.js`: `describeTool`, `renderToolLine`.

- [ ] **Step 3: Ripulire i test**

Da `test/telegram.test.ts`: cancella `describe('summarizeTool', ...)` (riga 644) e `describe('SummarizeQueue', ...)` (riga 459); togli `summarizeTool` e `SummarizeQueue` dall'import.
Da `test/ollama.test.ts`: cancella i `describe`/`it` che esercitano `summarize`.

- [ ] **Step 4: Verificare**

```bash
npm run typecheck && npm test
```
Atteso: PASS. Il typecheck è il vero controllo qui: segnala ogni riferimento rimasto alle funzioni cancellate.

- [ ] **Step 5: Commit**

```bash
git add bot/telegram.ts src/ollama.ts test/telegram.test.ts test/ollama.test.ts
git commit -m "feat(bot): descrivi le tool call col catalogo deterministico

Rimuove il summarizer via Ollama dal percorso delle tool call: costava un
timeout di 5s per chiamata e un modello locale, per un risultato meno accurato
del campo description che il CLI scrive già."
```

---

### Task 5: `mdToHtml` esteso e invariante dei tag

**I due cambi stanno nello stesso commit di proposito.** Aggiungere `<blockquote>` senza insegnarlo a `balanceHtml`/`splitHtmlMessage` fa sparire i messaggi lunghi dentro il `.catch()` dell'invio: nessun errore, nessun log, solo testo che non arriva.

**Files:**
- Modify: `bot/render.ts`
- Modify: `test/render.test.ts`

**Interfaces:**
- Consumes: `htmlEscape`, `balanceHtml`, `splitHtmlMessage` (Task 1)
- Produces: nessuna firma nuova; `mdToHtml` copre più costrutti, `HTML_TAG` e la regex di `balanceHtml` conoscono `blockquote|s|u`.

- [ ] **Step 1: Scrivere i test che falliscono**

```ts
describe('mdToHtml — costrutti aggiunti', () => {
  it('mette il linguaggio sul blocco di codice', () => {
    expect(mdToHtml('```ts\nconst a = 1\n```')).toContain('<pre><code class="language-ts">');
  });

  it('ignora un linguaggio non plausibile', () => {
    expect(mdToHtml('```non un linguaggio\nx\n```')).toContain('<pre>');
    expect(mdToHtml('```non un linguaggio\nx\n```')).not.toContain('class="language-');
  });

  it('rende le citazioni e unisce le righe consecutive', () => {
    const out = mdToHtml('> prima\n> seconda');
    expect(out).toContain('<blockquote>');
    expect((out.match(/<blockquote>/g) ?? []).length).toBe(1);
  });

  it('rende il barrato', () => {
    expect(mdToHtml('~~via~~')).toContain('<s>via</s>');
  });

  it('conserva le liste ordinate', () => {
    expect(mdToHtml('1. primo\n2. secondo')).toContain('1. primo');
  });

  it('indenta le liste annidate', () => {
    expect(mdToHtml('- a\n  - b')).toContain('◦ b');
  });

  it('non produce mai un pre dentro un blockquote', () => {
    // Telegram rifiuta la combinazione: il renderer non deve generarla.
    const out = mdToHtml('> cit\n\n```\ncodice\n```');
    expect(/<blockquote>(?:(?!<\/blockquote>)[\s\S])*<pre>/.test(out)).toBe(false);
  });

  it('allinea le tabelle in un blocco pre', () => {
    const out = mdToHtml('| tool | uso |\n|---|---|\n| Read | file |\n| Bash | comandi |');
    expect(out).toContain('<pre>');
    expect(out).not.toContain('|---|');            // la riga separatrice sparisce
    expect(out).toMatch(/tool\s+\|\s+uso/);        // colonne allineate a larghezza fissa
    expect(out).toContain('Bash');
  });

  it('stacca gli heading con una riga vuota', () => {
    expect(mdToHtml('testo\n## Titolo')).toContain('\n\n<b>Titolo</b>');
  });
});

describe('invariante dei tag su split e bilanciamento', () => {
  it('bilancia un blockquote non chiuso', () => {
    expect(balanceHtml('<blockquote>testo')).toBe('<blockquote>testo</blockquote>');
  });

  it('spezza un blockquote lungo senza perdere testo né sbilanciare i tag', () => {
    const inner = Array.from({ length: 500 }, (_, i) => `riga ${i}`).join('\n');
    const parts = splitHtmlMessage(`<blockquote>${inner}</blockquote>`);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3800);
      expect(balanceHtml(p)).toBe(p);              // ogni pezzo è già valido
      expect(p.startsWith('<blockquote>')).toBe(true); // tag riaperto a ogni chunk
    }
    expect(parts.join('')).toContain('riga 499');  // la coda non si perde
  });
});
```

- [ ] **Step 2: Eseguire i test per vederli fallire**

```bash
npx vitest run test/render.test.ts -t "costrutti aggiunti"
npx vitest run test/render.test.ts -t "invariante dei tag"
```
Atteso: FAIL su entrambi.

- [ ] **Step 3: Estendere le regex dei tag**

In `bot/render.ts`, **prima** di toccare `mdToHtml`:

```ts
// L'elenco dei tag è l'invariante di questo modulo: mdToHtml può produrre solo
// tag presenti qui, perché balanceHtml e splitHtmlMessage ragionano su questa
// stessa lista. Un tag emesso ma non elencato attraversa lo split senza essere
// riaperto: il messaggio risulta malformato, Telegram lo rifiuta e l'invio —
// che sta dentro un .catch() — lo perde in silenzio.
const TAG_NAMES = 'b|i|code|pre|a|blockquote|s|u';
const HTML_TAG = new RegExp(`</?(${TAG_NAMES})(?:\\s[^>]*)?>`, 'g');
```

In `balanceHtml`, sostituisci `const re = /<\/?(b|i|code|pre|a)(?:\s[^>]*)?>/g;` con:

```ts
  const re = new RegExp(HTML_TAG.source, 'g');
```

(una regex nuova a ogni chiamata: `HTML_TAG` è globale e condividerne `lastIndex` fra funzioni rientranti è un bug d'ordine.)

In `splitHtmlMessage`, dove usa `HTML_TAG`, sostituisci l'uso della costante globale con `const re = new RegExp(HTML_TAG.source, 'g');` e usa `re` al posto di `HTML_TAG` (incluso `re.lastIndex = 0`).

- [ ] **Step 4: Estendere `mdToHtml`**

Dentro `mdToHtml`, dopo `let out = htmlEscape(text);` e **prima** della protezione dei blocchi di codice esistente, sostituisci la riga dei blocchi con la versione che cattura il linguaggio:

```ts
  out = out.replace(/```([a-z0-9+#-]{0,20})\n?([\s\S]*?)```/g, (_m, lang: string, c: string) =>
    protect(c, 'pre', /^[a-z0-9+#-]{1,20}$/.test(lang) ? lang : undefined));
```

e aggiorna `protect`:

```ts
  const protect = (c: string, kind: 'pre' | 'code', lang?: string): string => {
    const idx = blocks.length;
    blocks.push(
      kind === 'pre'
        ? (lang ? `<pre><code class="language-${lang}">${c}</code></pre>` : `<pre>${c}</pre>`)
        : `<code>${c}</code>`);
    return `${P}${idx}${P}`;
  };
```

Dopo la riga delle liste puntate esistente, aggiungi, **in quest'ordine**:

```ts
  // Liste annidate prima di quelle piatte: la regex piatta consumerebbe anche
  // le righe indentate, appiattendo la gerarchia.
  out = out.replace(/^ {2,}[-*]\s+(.+)$/gm, '  ◦ $1');
  out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  out = out.replace(/^(?:-{3,}|\*{3,})$/gm, '——————');
  // Citazioni: righe '>' consecutive in un solo blockquote. I blocchi di codice
  // sono già al sicuro nei placeholder, quindi un <pre> non può finire dentro.
  out = out.replace(/(?:^&gt;\s?.*(?:\n|$))+/gm, m => {
    const body = m.replace(/^&gt;\s?/gm, '').replace(/\n$/, '');
    return `<blockquote>${body}</blockquote>\n`;
  });
```

Il `>` è già diventato `&gt;` per via di `htmlEscape` in cima: la regex deve cercare `&gt;`, non `>`.

Per la spaziatura degli heading, sostituisci la riga esistente degli heading con:

```ts
  out = out.replace(/^#{1,6}\s+([^<\n]+)$/gm, '\n<b>$1</b>');
```

- [ ] **Step 4b: Tabelle allineate**

Le tabelle markdown escono oggi come righe di pipe illeggibili. La conversione va **subito dopo la protezione dei blocchi di codice**, perché produce un `<pre>` che deve finire nei placeholder: così non può essere toccato dalle sostituzioni successive né finire dentro un `<blockquote>`.

```ts
  // Una tabella è leggibile su Telegram solo a larghezza fissa: <pre> è
  // l'unico contenitore che la preserva. Le colonne sono limitate perché su
  // uno schermo stretto una cella lunga manderebbe a capo tutta la griglia.
  const CELL_MAX = 24;
  out = out.replace(/(?:^\|.*\|[ \t]*\n?){2,}/gm, table => {
    const rows = table.trimEnd().split('\n')
      .map(r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
    // la riga separatrice ('---', ':--') non è dati: sparisce
    const body = rows.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c)));
    if (body.length < 2) return table;
    const cols = Math.max(...body.map(r => r.length));
    const width: number[] = [];
    for (let c = 0; c < cols; c++) {
      width[c] = Math.min(CELL_MAX, Math.max(...body.map(r => (r[c] ?? '').length)));
    }
    const rendered = body
      .map(r => Array.from({ length: cols }, (_, c) => (r[c] ?? '').slice(0, CELL_MAX).padEnd(width[c])).join(' | ').trimEnd())
      .join('\n');
    return `${protect(rendered, 'pre')}\n`;
  });
```

Va inserita **dopo** le due righe che proteggono ` ``` ` e `` ` ``, così un pipe dentro un blocco di codice è già al sicuro in un placeholder e non viene scambiato per una tabella.

- [ ] **Step 5: Eseguire i test**

```bash
npm run typecheck && npx vitest run test/render.test.ts
```
Atteso: PASS, inclusi i test di `mdToHtml v2 / balanceHtml` e `splitHtmlMessage` spostati nel Task 1 (nessuna regressione).

- [ ] **Step 6: Commit**

```bash
git add bot/render.ts test/render.test.ts
git commit -m "feat(render): estendi il markdown a citazioni, barrato, liste annidate e linguaggio dei blocchi

I tag nuovi sono aggiunti a TAG_NAMES nello stesso commit: balanceHtml e
splitHtmlMessage ragionano su quella lista, e un tag sconosciuto allo split
produce un messaggio malformato che Telegram rifiuta in silenzio."
```

---

### Task 6: Marcare i fallimenti delle tool

**Files:**
- Modify: `bot/telegram.ts` (`ToolBurstAggregator`, riga 916; gestore `session.tool`)
- Modify: `test/telegram.test.ts` (`describe('ToolBurstAggregator')`, riga 357)

**Interfaces:**
- Consumes: `renderToolLine` (Task 3)
- Produces: `ToolBurstAggregator.push(line: string, toolUseId?: string): Promise<void>` e `ToolBurstAggregator.markFailed(toolUseId: string, reason: string): Promise<void>`

- [ ] **Step 1: Scrivere i test che falliscono**

Nel `describe('ToolBurstAggregator')` esistente aggiungi:

```ts
  it('marca come fallita la riga del tool corrispondente', async () => {
    const edits: string[] = [];
    const agg = new ToolBurstAggregator({
      edit: async (_id, text) => { edits.push(text); return true; },
      send: async () => 1,
    });
    await agg.push('📖 <b>Read</b>', 'tu-1');
    await agg.push('⚡ <b>Bash</b>', 'tu-2');
    await agg.markFailed('tu-2', 'command not found');
    const last = edits[edits.length - 1];
    expect(last).toContain('❌ ⚡ <b>Bash</b>');
    expect(last).toContain('command not found');
    expect(last).toContain('📖 <b>Read</b>');   // la riga sana resta intatta
    expect(last).not.toContain('❌ 📖');
  });

  it('ignora un fallimento per un tool che non è nella bolla', async () => {
    const agg = new ToolBurstAggregator({ edit: async () => true, send: async () => 1 });
    await agg.push('📖 <b>Read</b>', 'tu-1');
    await expect(agg.markFailed('sconosciuto', 'boom')).resolves.toBeUndefined();
  });

  it('ignora un fallimento dopo la chiusura della bolla', async () => {
    let edited = false;
    const agg = new ToolBurstAggregator({
      edit: async () => { edited = true; return true; },
      send: async () => 1,
    });
    await agg.push('⚡ <b>Bash</b>', 'tu-1');
    agg.close();
    await agg.markFailed('tu-1', 'boom');
    expect(edited).toBe(false); // riaprire romperebbe l'ordine cronologico
  });
```

- [ ] **Step 2: Eseguire i test per vederli fallire**

```bash
npx vitest run test/telegram.test.ts -t ToolBurstAggregator
```
Atteso: FAIL, `agg.markFailed is not a function`.

- [ ] **Step 3: Implementare in `ToolBurstAggregator`**

Aggiungi il campo e cambia `push`/`pushNow`:

```ts
  // toolUseId → indice della riga dentro la bolla aperta: serve a riscrivere
  // in place la riga giusta quando arriva il suo tool_result fallito.
  private lineIds: (string | undefined)[] = [];
  private lines: string[] = [];
```

In `push(line, toolUseId)` propaga l'id a `pushNow`. In `pushNow`, quando la riga viene aggiunta alla bolla aperta, fai `this.lines.push(line); this.lineIds.push(toolUseId);`; quando invece apre una bolla nuova, reimposta `this.lines = [line]; this.lineIds = [toolUseId];`. Il testo della bolla diventa `this.lines.join('\n\n')` (equivalente al comportamento attuale).

```ts
  // Solo i fallimenti sono segnalati: l'EditThrottler è a 1 op/s per chat e
  // marcare ogni successo raddoppierebbe le chiamate per un'informazione che
  // l'assenza di ❌ già dà.
  async markFailed(toolUseId: string, reason: string): Promise<void> {
    const open = this.open;
    if (!open) return;                       // bolla chiusa: non si riapre
    const i = this.lineIds.indexOf(toolUseId);
    if (i === -1) return;
    if (this.lines[i].startsWith('❌ ')) return; // già marcata
    const short = reason.split('\n').find(l => l.trim())?.slice(0, 100) ?? '';
    this.lines[i] = `❌ ${this.lines[i]}${short ? `\n<i>${htmlEscape(short)}</i>` : ''}`;
    const next = this.lines.join('\n\n');
    if (next.length <= this.maxLen && await this.sink.edit(open.messageId, next)) {
      open.text = next;
    }
  }
```

`close()` azzera anche `this.lines` e `this.lineIds`.

`ToolBurstAggregator` usa `htmlEscape`: importalo da `./render.js` se non è già importato in `telegram.ts`.

- [ ] **Step 4: Collegare il `tool_result` nel gestore del bus**

Nel gestore `session.tool` (scritto al Task 4), la push del `tool_use` deve ora **passare l'id**, altrimenti `markFailed` non troverà mai la riga da marcare:

```ts
      void this.toolBurst(e.sessionId).push(line, e.toolUseId);
```

E aggiungi prima del `return` sul kind:

```ts
      if (e.kind === 'tool_result') {
        if (e.isError && e.toolUseId) {
          const text = typeof e.result === 'string' ? e.result : JSON.stringify(e.result ?? '');
          void this.toolBurst(e.sessionId).markFailed(e.toolUseId, text);
        }
        return;
      }
```

- [ ] **Step 5: Eseguire i test**

```bash
npm run typecheck && npm test
```
Atteso: PASS.

- [ ] **Step 6: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat(bot): segnala in chat le tool call fallite"
```

---

### Task 7: Igiene dei messaggi

**Files:**
- Modify: `bot/telegram.ts` (sink della bolla tool ~1247-1275, `sendChunked`/`send` ~1127-1145)
- Modify: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `ToolBurstAggregator` (Task 6)
- Produces: `ToolBurstAggregator.collapse(): Promise<void>`

- [ ] **Step 1: Silenziare le bolle tool e togliere le anteprime**

Nel sink di `toolBurst()`, aggiungi le opzioni alle due chiamate API:

```ts
          this.bot.api.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            disable_notification: true,           // una Read non deve far vibrare il telefono
            link_preview_options: { is_disabled: true },
          })
```

e su `editMessageText` del sink solo `link_preview_options` (`disable_notification` non si applica a un edit).

Nel percorso del testo del modello (`sendChunked` e `send`), aggiungi `link_preview_options: { is_disabled: true }` — **non** `disable_notification`: la risposta del modello è esattamente l'evento che deve notificare.

- [ ] **Step 1b: Marcatore di continuazione sui messaggi spezzati**

Una risposta lunga arriva come più messaggi e non si capisce che sono lo stesso discorso. In `sendChunked` e `send`, dove il risultato di `splitHtmlMessage(text)` viene iterato, quando le parti sono più di una accoda a ciascuna il proprio indice:

```ts
    const parts = splitHtmlMessage(text);
    // Con una parte sola il marcatore sarebbe solo rumore.
    const label = (i: number): string => (parts.length > 1 ? `\n<i>(${i + 1}/${parts.length})</i>` : '');
```

e invia `parts[i] + label(i)` invece di `parts[i]`. Il marcatore va **dopo** lo split, mai prima: aggiungerlo al testo prima di spezzarlo altererebbe il conteggio dei caratteri su cui `splitHtmlMessage` decide i tagli.

Test in `test/telegram.test.ts`:

```ts
describe('marcatore di continuazione', () => {
  it('non compare con una parte sola', () => {
    const parts = splitHtmlMessage('corto');
    expect(parts.length).toBe(1);
  });

  it('lo spazio del marcatore non fa sforare il limite di Telegram', () => {
    const parts = splitHtmlMessage('x'.repeat(12_000));
    for (let i = 0; i < parts.length; i++) {
      const withLabel = `${parts[i]}\n<i>(${i + 1}/${parts.length})</i>`;
      expect(withLabel.length).toBeLessThan(4096);
    }
  });
});
```

(importa `splitHtmlMessage` da `../bot/render.js` in `test/telegram.test.ts` se non c'è già.)

- [ ] **Step 2: Scrivere il test del collasso**

```ts
  it('collassa la bolla in un blockquote espandibile con il conteggio', async () => {
    const edits: string[] = [];
    const agg = new ToolBurstAggregator({
      edit: async (_id, t) => { edits.push(t); return true; },
      send: async () => 1,
    });
    await agg.push('📖 <b>Read</b>', 'a');
    await agg.push('⚡ <b>Bash</b>', 'b');
    await agg.collapse();
    const last = edits[edits.length - 1];
    expect(last).toContain('<blockquote expandable>');
    expect(last).toContain('2 steps');
    expect(last).toContain('📖 <b>Read</b>');
  });

  it('non collassa una bolla con una riga sola', async () => {
    const edits: string[] = [];
    const agg = new ToolBurstAggregator({
      edit: async (_id, t) => { edits.push(t); return true; },
      send: async () => 1,
    });
    await agg.push('📖 <b>Read</b>', 'a');
    await agg.collapse();
    expect(edits.some(e => e.includes('<blockquote'))).toBe(false);
  });
```

- [ ] **Step 3: Eseguire i test per vederli fallire**

```bash
npx vitest run test/telegram.test.ts -t collassa
```
Atteso: FAIL, `agg.collapse is not a function`.

- [ ] **Step 4: Implementare `collapse()`**

```ts
  // A fine turno la raffica diventa un blocco richiudibile: resta consultabile
  // ma smette di occupare lo schermo nello storico. Con una riga sola il
  // blockquote costerebbe un edit senza guadagno.
  async collapse(): Promise<void> {
    const open = this.open;
    if (!open || this.lines.length < 2) return;
    const body = `▸ <b>${this.lines.length} steps</b>\n<blockquote expandable>${this.lines.join('\n\n')}</blockquote>`;
    if (body.length <= this.maxLen) await this.sink.edit(open.messageId, body);
  }
```

Chiama `void this.toolBurst(sessionId).collapse()` **prima** di ogni `.close()` esistente nei gestori di `session.text`, `session.prompt`, `session.permission`, `session.dialog`, `session.result`, `session.error`.

- [ ] **Step 5: Eseguire i test**

```bash
npm run typecheck && npm test
```
Atteso: PASS.

- [ ] **Step 6: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat(bot): bolle tool silenziose, senza anteprime e richiudibili a fine turno"
```

---

### Task 8: Contratto del bus e `sdk-driver` per i subagent

**Files:**
- Modify: `src/types.ts` (righe 55-87)
- Modify: `src/sessions/sdk-driver.ts` (righe 107-175)
- Modify: `test/sdk-driver.test.ts`

**Interfaces:**
- Consumes: niente
- Produces: campo `parentToolUseId?: string` su `session.text` e `session.tool`; evento `session.agent` (forma esatta nello Step 1).

- [ ] **Step 1: Estendere il contratto in `src/types.ts`**

Aggiungi `parentToolUseId?: string` a `session.text` e a `session.tool`, con questo commento sopra il primo:

```ts
      // Non-null ⇒ l'evento viene da un subagent, e il valore è l'id della
      // tool_use Task che l'ha generato. Senza questo campo il bot non può
      // distinguere l'attività di un subagent da quella della sessione
      // principale, e le due si mescolano in un'unica chat lineare.
      parentToolUseId?: string;
```

e il nuovo evento:

```ts
  | {
      type: 'session.agent';
      sessionId: string;
      taskId: string;
      toolUseId?: string;   // la tool_use Task: chiave di correlazione con parentToolUseId
      phase: 'started' | 'progress' | 'done';
      subagentType?: string;
      description?: string;
      toolUses?: number;
      durationMs?: number;
      lastToolName?: string;
      status?: 'completed' | 'failed' | 'killed';
      error?: string;
      eventId?: string;
    }
```

- [ ] **Step 2: Scrivere i test che falliscono**

**Prima**, in `makeDriver()` (riga 19) aggiungi `'session.agent'` alla lista dei tipi sottoscritti, altrimenti gli eventi nuovi non finiscono in `events` e ogni test sotto fallisce per il motivo sbagliato:

```ts
  for (const t of ['session.text', 'session.tool', 'session.result', 'session.error', 'session.updated', 'session.agent'] as const) {
```

Poi, dentro `describe('SdkDriver')`, aggiungi:

```ts
  it('propaga parent_tool_use_id sugli eventi di un subagent', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: 'assistant', uuid: 'u', session_id: session.id,
        message: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'tu-9', name: 'Read', input: { file_path: '/a.ts' } }] },
        parent_tool_use_id: 'task-tool-1',
      };
      yield resultMsg(session.id, 'done');
    });
    await sdk.runTurn(session.id, 'vai');
    const tools = events.filter(e => (e as any).type === 'session.tool');
    expect((tools[0] as any).parentToolUseId).toBe('task-tool-1');
  });

  it('lascia parentToolUseId non impostato per la sessione principale', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield assistantText(session.id, 'ciao');
      yield resultMsg(session.id, 'done');
    });
    await sdk.runTurn(session.id, 'vai');
    const texts = events.filter(e => (e as any).type === 'session.text');
    expect((texts[0] as any).parentToolUseId).toBeUndefined();
  });

  it('traduce task_started in session.agent', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: 'system', subtype: 'task_started', uuid: 'u', session_id: session.id,
        task_id: 't1', tool_use_id: 'task-tool-1',
        description: 'trova i punti di rendering', subagent_type: 'Explore',
      };
      yield resultMsg(session.id, 'done');
    });
    await sdk.runTurn(session.id, 'vai');
    const agents = events.filter(e => (e as any).type === 'session.agent');
    expect(agents[0]).toMatchObject({ phase: 'started', taskId: 't1', toolUseId: 'task-tool-1', subagentType: 'Explore' });
  });

  it('porta i contatori di task_progress', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: 'system', subtype: 'task_progress', uuid: 'u', session_id: session.id,
        task_id: 't1', tool_use_id: 'task-tool-1', description: 'd',
        usage: { total_tokens: 10, tool_uses: 7, duration_ms: 42_000 }, last_tool_name: 'Grep',
      };
      yield resultMsg(session.id, 'done');
    });
    await sdk.runTurn(session.id, 'vai');
    const agents = events.filter(e => (e as any).type === 'session.agent');
    expect(agents[0]).toMatchObject({ phase: 'progress', toolUses: 7, durationMs: 42_000, lastToolName: 'Grep' });
  });

  it('traduce task_updated completato in phase done', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield { type: 'system', subtype: 'task_updated', uuid: 'u', session_id: session.id, task_id: 't1', patch: { status: 'completed' } };
      yield resultMsg(session.id, 'done');
    });
    await sdk.runTurn(session.id, 'vai');
    const agents = events.filter(e => (e as any).type === 'session.agent');
    expect(agents[0]).toMatchObject({ phase: 'done', status: 'completed' });
  });

  it('non emette session.agent per uno status intermedio', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield { type: 'system', subtype: 'task_updated', uuid: 'u', session_id: session.id, task_id: 't1', patch: { status: 'running' } };
      yield resultMsg(session.id, 'done');
    });
    await sdk.runTurn(session.id, 'vai');
    expect(events.some(e => (e as any).type === 'session.agent')).toBe(false);
  });
```

- [ ] **Step 3: Eseguire i test per vederli fallire**

```bash
npx vitest run test/sdk-driver.test.ts -t parent_tool_use_id
```
Atteso: FAIL, `parentToolUseId` è `undefined`.

- [ ] **Step 4: Implementare in `sdk-driver.ts`**

Nel ciclo `for await (const msg of stream)`, all'inizio:

```ts
        // L'SDK marca con parent_tool_use_id ogni messaggio prodotto da un
        // subagent, e per default ne emette già i blocchi tool_use/tool_result.
        // Propagarlo è ciò che permette al bot di non mescolarli allo stream
        // principale; ignorarlo era la causa del mescolamento.
        const parentToolUseId = ('parent_tool_use_id' in msg && msg.parent_tool_use_id) ? msg.parent_tool_use_id : undefined;
```

Aggiungi `parentToolUseId` agli oggetti emessi per `session.text` (riga 120) e per entrambi i `session.tool` (righe 141 e 156).

Aggiungi, prima del ramo `msg.type === 'result'`:

```ts
        } else if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_progress' || msg.subtype === 'task_updated')) {
          const eventId = newEventId();
          if (msg.subtype === 'task_updated') {
            const status = msg.patch?.status;
            // Solo gli stati terminali chiudono la scheda: 'running'/'pending'/
            // 'paused' non aggiungono niente a quello che task_progress già dice.
            if (status !== 'completed' && status !== 'failed' && status !== 'killed') continue;
            bus.emit({
              type: 'session.agent', sessionId, taskId: msg.task_id, phase: 'done',
              status, error: msg.patch?.error, eventId,
            });
          } else if (msg.subtype === 'task_started') {
            bus.emit({
              type: 'session.agent', sessionId, taskId: msg.task_id, toolUseId: msg.tool_use_id,
              phase: 'started', subagentType: msg.subagent_type, description: msg.description, eventId,
            });
          } else {
            bus.emit({
              type: 'session.agent', sessionId, taskId: msg.task_id, toolUseId: msg.tool_use_id,
              phase: 'progress', subagentType: msg.subagent_type, description: msg.description,
              toolUses: msg.usage?.tool_uses, durationMs: msg.usage?.duration_ms,
              lastToolName: msg.last_tool_name, eventId,
            });
          }
          log().debug('event emitted', { eventId, sessionId, source: 'sdk', kind: 'agent', taskId: msg.task_id, phase: msg.subtype });
```

Se il typecheck si lamenta della union `SDKMessage`, restringi con un cast locale sul solo campo letto invece di allargare i tipi pubblici.

- [ ] **Step 5: Eseguire i test**

```bash
npm run typecheck && npm test
```
Atteso: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/sessions/sdk-driver.ts test/sdk-driver.test.ts
git commit -m "feat(sessions): propaga parent_tool_use_id ed emetti session.agent

L'attività dei subagent finiva sul bus identica a quella della sessione
principale perché il driver ignorava parent_tool_use_id."
```

---

### Task 9: Rendering della scheda agent (puro)

**Files:**
- Modify: `bot/render.ts`
- Modify: `test/render.test.ts`

**Interfaces:**
- Consumes: `htmlEscape`, `truncateAtWord` (Task 1)
- Produces:
  ```ts
  export interface AgentCard {
    subagentType?: string; description?: string; lines: string[]; expanded: boolean;
    toolUses?: number; durationMs?: number; lastToolName?: string;
    status?: 'running' | 'completed' | 'failed' | 'killed'; error?: string;
  }
  export function renderAgentCard(card: AgentCard): string
  export function formatDuration(ms: number): string
  ```

- [ ] **Step 1: Scrivere i test che falliscono**

```ts
describe('renderAgentCard', () => {
  const base = { subagentType: 'Explore', description: 'trova i punti di rendering', lines: ['📖 <b>Read</b>'], expanded: false, status: 'running' as const };

  it('collassata mostra tipo, descrizione e avanzamento senza i dettagli', () => {
    const out = renderAgentCard({ ...base, toolUses: 7, durationMs: 42_000, lastToolName: 'Grep' });
    expect(out).toContain('Explore');
    expect(out).toContain('trova i punti di rendering');
    expect(out).toContain('7 steps');
    expect(out).toContain('42s');
    expect(out).toContain('Grep');
    expect(out).not.toContain('<blockquote');
  });

  it('espansa include le righe in un blockquote', () => {
    const out = renderAgentCard({ ...base, expanded: true });
    expect(out).toContain('<blockquote expandable>');
    expect(out).toContain('📖 <b>Read</b>');
  });

  it('conclusa con successo mostra la spunta', () => {
    expect(renderAgentCard({ ...base, status: 'completed' })).toContain('✅');
  });

  it('fallita mostra l errore', () => {
    const out = renderAgentCard({ ...base, status: 'failed', error: 'boom' });
    expect(out).toContain('❌');
    expect(out).toContain('boom');
  });

  it('espansa senza righe non produce un blockquote vuoto', () => {
    const out = renderAgentCard({ ...base, lines: [], expanded: true });
    expect(out).not.toContain('<blockquote');
  });

  it('escapa la descrizione', () => {
    expect(renderAgentCard({ ...base, description: 'a < b' })).toContain('a &lt; b');
  });
});

describe('formatDuration', () => {
  it('sotto il minuto usa i secondi', () => expect(formatDuration(42_000)).toBe('42s'));
  it('sopra il minuto usa minuti e secondi', () => expect(formatDuration(100_000)).toBe('1m 40s'));
  it('zero è 0s', () => expect(formatDuration(0)).toBe('0s'));
});
```

- [ ] **Step 2: Eseguire i test per vederli fallire**

```bash
npx vitest run test/render.test.ts -t renderAgentCard
```
Atteso: FAIL.

- [ ] **Step 3: Implementare in `bot/render.ts`**

```ts
export interface AgentCard {
  subagentType?: string;
  description?: string;
  lines: string[];
  expanded: boolean;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
  status?: 'running' | 'completed' | 'failed' | 'killed';
  error?: string;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Una chat lineare non ha pannelli: la scheda è l'unico posto dove l'attività
// di un subagent può stare senza mescolarsi al resto. Collassata dice solo che
// lavora e quanto ha fatto; i dettagli restano a un tap di distanza.
export function renderAgentCard(card: AgentCard): string {
  const icon = card.status === 'completed' ? '✅' : card.status === 'failed' || card.status === 'killed' ? '❌' : '⏳';
  const who = card.subagentType ? ` · <code>${htmlEscape(card.subagentType)}</code>` : '';
  const what = card.description ? ` — ${htmlEscape(truncateAtWord(card.description, 100))}` : '';
  const bits: string[] = [];
  if (card.toolUses !== undefined) bits.push(`${card.toolUses} steps`);
  if (card.durationMs !== undefined) bits.push(formatDuration(card.durationMs));
  if (card.status === 'running' && card.lastToolName) bits.push(htmlEscape(card.lastToolName));
  if (card.error) bits.push(htmlEscape(truncateAtWord(card.error, 100)));
  let out = `🤖 <b>Agent</b>${who}${what}\n${icon} ${bits.join(' · ') || '…'}`;
  if (card.expanded && card.lines.length) out += `\n<blockquote expandable>${card.lines.join('\n\n')}</blockquote>`;
  return out;
}
```

- [ ] **Step 4: Eseguire i test**

```bash
npx vitest run test/render.test.ts
```
Atteso: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/render.ts test/render.test.ts
git commit -m "feat(render): scheda di avanzamento per i subagent"
```

---

### Task 10: Instradare i subagent nella scheda

**Files:**
- Modify: `bot/telegram.ts` (`parseCallbackData` righe 89-123, `subscribeBus`, `onCallback`)
- Modify: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `renderAgentCard`, `AgentCard` (Task 9); evento `session.agent` (Task 8)
- Produces: azione `agent-toggle` in `CallbackData`

- [ ] **Step 1: Scrivere i test del callback e del routing**

```ts
describe('parseCallbackData per le schede agent', () => {
  it('riconosce il toggle', () => {
    expect(parseCallbackData('agent:toggle:t-1')).toEqual({ action: 'agent-toggle', id: 't-1' });
  });

  it('il callback_data resta sotto i 64 byte con un uuid', () => {
    const d = `agent:toggle:${'0e572638-6992-4a0b-b552-8293c5cd7195'}`;
    expect(Buffer.byteLength(d, 'utf8')).toBeLessThanOrEqual(64);
    expect(parseCallbackData(d).action).toBe('agent-toggle');
  });
});
```

- [ ] **Step 2: Eseguire i test per vederli fallire**

```bash
npx vitest run test/telegram.test.ts -t "schede agent"
```
Atteso: FAIL, `bad callback data`.

- [ ] **Step 3: Estendere `parseCallbackData`**

Aggiungi `'agent-toggle'` alla union di `CallbackData['action']` e, nel ramo `parts.length === 3`:

```ts
    if (ns === 'agent' && action === 'toggle' && id) return { action: 'agent-toggle', id };
```

- [ ] **Step 4: Implementare il registro delle schede**

In `TelegramBot` aggiungi:

```ts
  // Una scheda per subagent, indicizzata per toolUseId della tool_use Task —
  // la stessa chiave che gli eventi del subagent portano in parentToolUseId.
  private agentCards = new Map<string, { messageId?: number; taskId: string; card: AgentCard }>();
  // Eventi di un subagent arrivati prima del task_started che crea la scheda.
  private orphanAgentLines = new Map<string, string[]>();
```

Nel gestore `session.tool` (Task 4/6), **prima** di ogni altra cosa dopo il gate:

```ts
      if (e.parentToolUseId) {
        // Attività di un subagent: non entra nello stream principale né nella
        // bolla tool, va nella sua scheda.
        if (e.kind === 'tool_use' && e.input) {
          const session = this.deps.manager.get(e.sessionId);
          const line = renderToolLine(describeTool(e.toolName, e.input, session?.projectDir));
          const entry = this.agentCards.get(e.parentToolUseId);
          if (entry) { entry.card.lines.push(line); void this.refreshAgentCard(e.parentToolUseId); }
          else {
            const buf = this.orphanAgentLines.get(e.parentToolUseId) ?? [];
            buf.push(line);
            this.orphanAgentLines.set(e.parentToolUseId, buf);
          }
        }
        return;
      }
```

In cima al gestore `session.text`, subito dopo il gate:

```ts
      // Testo di un subagent: se la sua scheda esiste, resta lì. Se NON esiste
      // (tool_use_id assente, o task_started mai arrivato) l'evento prosegue
      // verso lo stream principale invece di sparire: perdere l'ordinamento è
      // meglio che perdere visibilità.
      if (e.parentToolUseId && this.agentCards.has(e.parentToolUseId)) return;
```

Gestore nuovo:

```ts
    bus.on('session.agent', e => {
      if (!this.passes('tool', e.sessionId, e.eventId).deliver) return;
      const key = e.toolUseId ?? e.taskId;
      if (e.phase === 'started') {
        const card: AgentCard = {
          subagentType: e.subagentType, description: e.description,
          lines: this.orphanAgentLines.get(key) ?? [], expanded: false, status: 'running',
        };
        this.orphanAgentLines.delete(key);
        this.agentCards.set(key, { taskId: e.taskId, card });
        void this.refreshAgentCard(key);
        return;
      }
      const entry = this.agentCards.get(key);
      if (!entry) return;
      if (e.phase === 'progress') {
        entry.card.toolUses = e.toolUses ?? entry.card.toolUses;
        entry.card.durationMs = e.durationMs ?? entry.card.durationMs;
        entry.card.lastToolName = e.lastToolName ?? entry.card.lastToolName;
      } else {
        entry.card.status = e.status ?? 'completed';
        entry.card.error = e.error;
      }
      void this.refreshAgentCard(key);
    });
```

Aggiungi il tipo del registro (`lastText` serve a saltare gli edit inutili) e i due metodi:

```ts
  private agentCards = new Map<string, { messageId?: number; taskId: string; card: AgentCard; lastText?: string }>();

  private agentKeyboard(key: string, expanded: boolean): InlineKeyboard {
    return new InlineKeyboard().text(expanded ? '🙈 Hide' : '👁 Details', `agent:toggle:${key}`);
  }

  // task_progress può arrivare molto spesso: l'EditThrottler è a 1 op/s per
  // chat, quindi una scheda che si ridisegna identica ruberebbe il turno al
  // testo del modello. L'edit parte solo se il testo è davvero cambiato.
  private async refreshAgentCard(key: string): Promise<void> {
    const entry = this.agentCards.get(key);
    const chatId = this.chatId;
    if (!entry) return;
    if (!chatId) { log().warn('send skipped', { kind: 'agent', reason: 'no-chat-bound' }); return; }
    const text = renderAgentCard(entry.card);
    if (text === entry.lastText) return;
    const opts = {
      parse_mode: 'HTML' as const,
      link_preview_options: { is_disabled: true },
      reply_markup: this.agentKeyboard(key, entry.card.expanded),
    };
    if (entry.messageId === undefined) {
      const msg = await this.throttler.throttled(() =>
        this.bot.api.sendMessage(chatId, text, { ...opts, disable_notification: true })
          .catch(err => { log().error('agent card send failed', { kind: 'agent', err }); return undefined; }));
      if (msg?.message_id !== undefined) { entry.messageId = msg.message_id; entry.lastText = text; }
      return;
    }
    const ok = await this.throttler.throttled(() =>
      this.bot.api.editMessageText(chatId, entry.messageId!, text, opts)
        .then(() => true)
        .catch(err => { log().error('agent card edit failed', { kind: 'agent', err }); return false; }));
    if (ok) entry.lastText = text;
  }
```

In `onCallback`, il caso `agent-toggle`:

```ts
      case 'agent-toggle': {
        const entry = this.agentCards.get(data.id);
        if (entry) { entry.card.expanded = !entry.card.expanded; await this.refreshAgentCard(data.id); }
        await ctx.answerCallbackQuery();
        return;
      }
```

Aggiungi `renderAgentCard` all'import da `./render.js` e `import type { AgentCard } from './render.js';`.

A fine turno (gestori `session.result` e `session.error`), chiudi le schede rimaste aperte:

```ts
    // Un task_updated che non arriva mai lascerebbe la scheda in "⏳" per
    // sempre: a fine turno ogni scheda ancora in corso è interrotta.
    for (const [key, entry] of this.agentCards) {
      if (entry.card.status === 'running') { entry.card.status = 'killed'; void this.refreshAgentCard(key); }
    }
    this.agentCards.clear();
    this.orphanAgentLines.clear();
```

- [ ] **Step 5: Eseguire i test**

```bash
npm run typecheck && npm test
```
Atteso: PASS.

- [ ] **Step 6: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat(bot): scheda per subagent con dettagli a richiesta

Gli eventi con parentToolUseId non entrano più nello stream principale. Un
parent senza scheda ricade nello stream invece di sparire: perdere
l'ordinamento è meglio che perdere visibilità."
```

---

### Task 11: Documentazione

`CLAUDE.md`: "Docs ship in the same commit as the code. Stale docs here are wrong docs."

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `AI-GUIDE.md`, `CLAUDE.md`

- [ ] **Step 1: `CHANGELOG.md`**

Voce nuova in cima, nello stile delle esistenti: tool call descritte a parole con Skill/MCP/subagent riconoscibili, path accorciati, fallimenti segnalati, markdown esteso, bolle tool silenziose e richiudibili, scheda per subagent con dettagli a richiesta. Nota la rimozione del summarizer via Ollama come cambio di comportamento.

- [ ] **Step 2: `CLAUDE.md`**

Nella tabella "Map" aggiungi la riga:

```
| `bot/render.ts` | presentazione pura: markdown→HTML, split dei tag, descrizione delle tool call, scheda agent |
```

e aggiorna la descrizione di `bot/telegram.ts` (non è più "~2000 lines" e non contiene più la presentazione).

- [ ] **Step 3: `README.md` e `AI-GUIDE.md`**

Trova i punti da aggiornare invece di rileggere tutto:

```bash
rtk proxy grep -n "⚙️\|summariz\|Ollama.*summary\|tool call" README.md AI-GUIDE.md
```

Per ogni occorrenza: sostituisci gli esempi di output vecchio (`⚙️` più JSON o comando nudo) col formato nuovo (`📖 Read · bot/telegram.ts`), togli ogni riferimento alla summary via Ollama — che non esiste più — e aggiungi tre righe che documentano la scheda subagent: cosa mostra collassata, il bottone `👁 Details`, e il limite dichiarato (schede solo per le sessioni **headless**; per le terminali resta la sola riga `🤖 Agent`).

- [ ] **Step 4: Verifica finale**

```bash
npm run typecheck && npm test
git diff main --stat
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md AI-GUIDE.md CLAUDE.md
git commit -m "docs: allinea la documentazione alla nuova resa della chat Telegram"
```

---

## Cosa non è verificabile in CI

Da dichiarare esplicitamente al termine, senza dire "fatto" su un'assunzione: CI non ha token bot, né tmux, né telefono. **Non** sono verificati automaticamente: la resa reale su Telegram (evidenziazione della sintassi, `blockquote expandable`, comportamento delle notifiche), il toggle della scheda agent su un client vero, e il percorso subagent end-to-end con un `Task` reale. Servono un daemon vivo e un telefono.
