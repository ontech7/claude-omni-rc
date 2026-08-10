# Osservabilità del remote control — Piano di implementazione (Fase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dare al daemon un log strutturato, un'identità per ogni evento diretto a Telegram e un comando `/diag`, così che un messaggio che non arriva lasci una traccia con il motivo invece di sparire in silenzio.

**Architecture:** Un `Logger` scrive righe JSON su un file dedicato (`<STATE_DIR>/logs/daemon.jsonl`) tramite descrittore, con livelli e rotazione a dimensione, e tiene in memoria un anello degli ultimi errori per `/diag`. Ogni evento che nasce da una riga di transcript o dall'SDK riceve un `eventId` che porta con sé sul bus. Le guardie che oggi scartano in silenzio dentro il bot vengono estratte in una funzione pura `gateSessionEvent`, testabile, che restituisce il motivo dello scarto: il motivo viene registrato. Nessun comportamento cambia — è una fase puramente osservativa, e serve a confermare la causa esatta del caso descritto in §2.1 della spec prima di riscrivere il percorso di consegna nella Fase 2.

**Tech Stack:** TypeScript strict, ESM, Node 22+, vitest. Nessuna nuova dipendenza.

## Global Constraints

- Node.js >= 22 (`engines` in `package.json`); nessuna nuova dipendenza runtime o di sviluppo.
- TypeScript `strict: true`, `noEmit: true`, `moduleResolution: bundler`: ogni import interno usa l'estensione `.js` (`./log.js`), anche se il file sorgente è `.ts`.
- I test vivono in `test/<nome>.test.ts` e usano `describe` / `it` / `expect` da `vitest`; si importano da `../src/<nome>.js`.
- I commenti nel codice sono in italiano e spiegano il *perché*, come nel resto del repository.
- Nessun cambiamento di comportamento osservabile dall'utente in questa fase, salvo il nuovo comando `/diag` e i file di log: quello che oggi viene consegnato deve continuare a esserlo, e quello che oggi viene scartato deve continuare a esserlo — soltanto, ora lascia traccia.
- Il logging non deve mai poter uccidere il daemon: ogni operazione di I/O sul log è racchiusa in try/catch e in caso di errore il logger degrada a silenzioso.
- Il file di log dell'utente è `~/.claude-omni-rc/logs/daemon.jsonl` e affianca (non sostituisce) `daemon.log` / `daemon.err.log`, che restano quelli di launchd.
- Verifica finale di ogni task: `npm run typecheck && npm test` verdi.

## Struttura dei file

| File | Responsabilità |
|---|---|
| `src/log.ts` *(nuovo)* | livelli, serializzazione JSON, scrittura su descrittore, rotazione, anello degli ultimi errori, istanza corrente del processo |
| `test/log.test.ts` *(nuovo)* | comportamento del logger, inclusi rotazione, errori serializzati e campi circolari |
| `src/config.ts` | lettura di `LOG_LEVEL`, `LOG_FILE`, `LOG_MAX_BYTES`, `LOG_KEEP` |
| `src/daemon.ts` | inizializzazione del logger all'avvio, riga di avvio, sostituzione dei `console.error` |
| `src/types.ts` | `eventId` opzionale sugli eventi del bus diretti a Telegram |
| `src/bus.ts` | `newEventId()` — identità di un evento |
| `src/sessions/transcript-watcher.ts` | assegna l'`eventId` agli eventi che nascono da una riga di transcript e registra ciò che emette |
| `src/sessions/sdk-driver.ts` | assegna l'`eventId` agli eventi che nascono dall'SDK |
| `bot/telegram.ts` | `gateSessionEvent` (pura), registrazione di consegne e scarti, `diagReport` (pura), comando `/diag` |
| `test/telegram.test.ts` | test di `gateSessionEvent` e `diagReport` |

---

### Task 1: Logger strutturato

**Files:**
- Create: `src/log.ts`
- Test: `test/log.test.ts`

**Interfaces:**
- Consumes: niente (primo task).
- Produces:
  - `type LogLevel = 'error' | 'warn' | 'info' | 'debug'`
  - `const LOG_LEVELS: LogLevel[]`
  - `interface LogFields { [key: string]: unknown }`
  - `interface LoggerOptions { file?: string; level?: LogLevel; maxBytes?: number; keep?: number; now?: () => number; stderr?: (line: string) => void }`
  - `class LogSink` (costruttore `new LogSink(opts: LoggerOptions)`)
  - `class Logger` (costruttore `new Logger(sink: LogSink, bound?: LogFields)`), metodi `error(msg: string, fields?: LogFields): void`, `warn`, `info`, `debug`, `child(fields: LogFields): Logger`, `recentErrors(): string[]`, `close(): void`
  - `function createLogger(opts?: LoggerOptions): Logger`
  - `function initLogger(opts: LoggerOptions): Logger`
  - `function log(): Logger`
  - `function serializeRecord(ts: number, level: LogLevel, msg: string, fields: LogFields): string`

- [ ] **Step 1: Write the failing test**

Create `test/log.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, serializeRecord, LOG_LEVELS } from '../src/log.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'omni-log-'));
}

function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('LOG_LEVELS', () => {
  it('lists the levels from the most to the least severe', () => {
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug']);
  });
});

describe('serializeRecord', () => {
  it('produces one JSON line with timestamp, level, message and fields', () => {
    const line = serializeRecord(0, 'info', 'delivered', { sessionId: 'abc', eventId: 'e1' });
    expect(line.endsWith('\n')).toBe(true);
    const rec = JSON.parse(line);
    expect(rec).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'delivered',
      sessionId: 'abc',
      eventId: 'e1',
    });
  });

  it('expands an Error field into name, message and stack', () => {
    const rec = JSON.parse(serializeRecord(0, 'error', 'send failed', { err: new TypeError('boom') }));
    expect(rec.err.name).toBe('TypeError');
    expect(rec.err.message).toBe('boom');
    expect(typeof rec.err.stack).toBe('string');
  });

  it('degrades to a marker instead of throwing on a circular field', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const rec = JSON.parse(serializeRecord(0, 'warn', 'weird', { payload: circular }));
    expect(rec.msg).toBe('weird');
    expect(rec.unserializable).toBe(true);
  });
});

describe('Logger', () => {
  it('writes a JSON line per record to the configured file', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger = createLogger({ file, level: 'info', stderr: () => {} });
    logger.info('daemon starting', { pid: 1 });
    logger.close();
    expect(lines(file)).toEqual([
      expect.objectContaining({ level: 'info', msg: 'daemon starting', pid: 1 }),
    ]);
  });

  it('drops records below the configured level', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger = createLogger({ file, level: 'warn', stderr: () => {} });
    logger.debug('noisy');
    logger.info('chatty');
    logger.warn('kept');
    logger.close();
    expect(lines(file).map(r => r.msg)).toEqual(['kept']);
  });

  it('merges the fields bound with child() into every record', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger = createLogger({ file, level: 'info', stderr: () => {} });
    logger.child({ sessionId: 's1' }).info('event', { eventId: 'e1' });
    logger.close();
    expect(lines(file)[0]).toEqual(expect.objectContaining({ sessionId: 's1', eventId: 'e1' }));
  });

  it('mirrors error records to stderr so daemon.err.log stays a canary', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const seen: string[] = [];
    const logger = createLogger({ file, level: 'info', stderr: l => seen.push(l) });
    logger.info('quiet');
    logger.error('loud');
    logger.close();
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0]).msg).toBe('loud');
  });

  it('rotates past maxBytes and keeps at most `keep` older files', () => {
    const dir = tmpDir();
    const file = join(dir, 'daemon.jsonl');
    // maxBytes minuscolo: ogni riga supera la soglia e forza una rotazione.
    const logger = createLogger({ file, level: 'info', maxBytes: 80, keep: 2, stderr: () => {} });
    for (let i = 0; i < 6; i++) logger.info(`record-${i}`, { padding: 'x'.repeat(40) });
    logger.close();
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false); // oltre `keep` non si accumula
  });

  it('keeps recentErrors() for /diag, most recent last, capped', () => {
    const file = join(tmpDir(), 'daemon.jsonl');
    const logger = createLogger({ file, level: 'info', stderr: () => {} });
    logger.info('not an error');
    logger.warn('first');
    logger.error('second');
    const recent = logger.recentErrors();
    logger.close();
    expect(recent).toHaveLength(2);
    expect(JSON.parse(recent[0]).msg).toBe('first');
    expect(JSON.parse(recent[1]).msg).toBe('second');
  });

  it('stays silent instead of throwing when the log file cannot be opened', () => {
    const dir = tmpDir();
    const blocker = join(dir, 'logs');
    writeFileSync(blocker, 'not a directory'); // mkdir sotto un file fallisce
    const logger = createLogger({ file: join(blocker, 'daemon.jsonl'), level: 'info', stderr: () => {} });
    expect(() => logger.info('survives')).not.toThrow();
    logger.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/log.test.ts`
Expected: FAIL — `Failed to load ../src/log.js` (il modulo non esiste ancora).

- [ ] **Step 3: Write the implementation**

Create `src/log.ts`:

```ts
import { openSync, writeSync, closeSync, fstatSync, mkdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// Log strutturato del daemon: una riga JSON per record, su un file dedicato
// (`<STATE_DIR>/logs/daemon.jsonl`) che affianca daemon.log/daemon.err.log di
// launchd. Scrittura diretta sul descrittore: il file deve essere leggibile
// MENTRE le cose accadono, non dopo.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
export const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export interface LogFields { [key: string]: unknown }

export interface LoggerOptions {
  file?: string;              // assente → solo stderr per gli errori
  level?: LogLevel;           // default 'info'
  maxBytes?: number;          // default 5 MB
  keep?: number;              // quanti file ruotati conservare, default 3
  now?: () => number;         // orologio iniettabile per i test
  stderr?: (line: string) => void;
}

// Quanti record error/warn tenere in memoria per /diag: abbastanza da spiegare
// un incidente appena successo, non tanti da pesare.
const RECENT_MAX = 20;

const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_KEEP = 3;

// Una riga JSON per record. Gli Error vanno espansi a mano: JSON.stringify di un
// Error produce `{}` e il messaggio dell'errore andrebbe perso — che è
// esattamente il tipo di silenzio che questo modulo esiste per eliminare.
export function serializeRecord(ts: number, level: LogLevel, msg: string, fields: LogFields): string {
  const iso = new Date(ts).toISOString();
  const rec: Record<string, unknown> = { ts: iso, level, msg };
  for (const [k, v] of Object.entries(fields)) {
    rec[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  try {
    return JSON.stringify(rec) + '\n';
  } catch {
    // campo circolare o non serializzabile: meglio un record ridotto che nessun record.
    return JSON.stringify({ ts: iso, level, msg, unserializable: true }) + '\n';
  }
}

// Possiede il descrittore, la rotazione e l'anello degli errori recenti. È
// condiviso tra un Logger e i suoi child: i campi legati cambiano, la
// destinazione no.
export class LogSink {
  private fd?: number;
  private size = 0;
  private recent: string[] = [];
  private readonly file?: string;
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly stderr: (line: string) => void;
  readonly level: LogLevel;
  readonly now: () => number;

  constructor(opts: LoggerOptions = {}) {
    this.file = opts.file;
    this.level = opts.level ?? 'info';
    this.maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES);
    this.keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
    this.now = opts.now ?? Date.now;
    this.stderr = opts.stderr ?? ((line: string) => { process.stderr.write(line); });
    this.open();
  }

  private open(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.fd = openSync(this.file, 'a');
      this.size = fstatSync(this.fd).size;
    } catch {
      // Un log che non si apre non deve impedire al daemon di partire: si
      // degrada a silenzioso (gli error restano comunque su stderr).
      this.fd = undefined;
    }
  }

  private rotate(): void {
    if (!this.file) return;
    if (this.fd !== undefined) {
      try { closeSync(this.fd); } catch { /* già chiuso */ }
      this.fd = undefined;
    }
    const oldest = `${this.file}.${this.keep}`;
    if (existsSync(oldest)) { try { unlinkSync(oldest); } catch { /* niente da fare */ } }
    for (let i = this.keep - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      if (existsSync(from)) { try { renameSync(from, `${this.file}.${i + 1}`); } catch { /* niente da fare */ } }
    }
    try { renameSync(this.file, `${this.file}.1`); } catch { /* niente da fare */ }
    this.open();
  }

  write(level: LogLevel, msg: string, fields: LogFields): void {
    if (RANK[level] > RANK[this.level]) return;
    const line = serializeRecord(this.now(), level, msg, fields);
    if (RANK[level] <= RANK.warn) {
      this.recent.push(line.trimEnd());
      if (this.recent.length > RECENT_MAX) this.recent.shift();
    }
    if (level === 'error') this.stderr(line);
    if (this.fd === undefined) return;
    if (this.size + line.length > this.maxBytes) this.rotate();
    if (this.fd === undefined) return;
    try {
      writeSync(this.fd, line);
      this.size += line.length;
    } catch {
      // disco pieno o descrittore invalidato: il daemon continua a funzionare.
    }
  }

  recentErrors(): string[] {
    return [...this.recent];
  }

  close(): void {
    if (this.fd === undefined) return;
    try { closeSync(this.fd); } catch { /* già chiuso */ }
    this.fd = undefined;
  }
}

export class Logger {
  constructor(private sink: LogSink, private bound: LogFields = {}) {}

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    this.sink.write(level, msg, fields ? { ...this.bound, ...fields } : this.bound);
  }

  error(msg: string, fields?: LogFields): void { this.write('error', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.write('warn', msg, fields); }
  info(msg: string, fields?: LogFields): void { this.write('info', msg, fields); }
  debug(msg: string, fields?: LogFields): void { this.write('debug', msg, fields); }

  // Campi legati una volta e ripetuti su ogni record (es. la sessione).
  child(fields: LogFields): Logger {
    return new Logger(this.sink, { ...this.bound, ...fields });
  }

  recentErrors(): string[] { return this.sink.recentErrors(); }
  close(): void { this.sink.close(); }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new Logger(new LogSink(opts));
}

// Istanza del processo. Finché initLogger non viene chiamato dal daemon, esiste
// comunque un logger: scrive solo gli errori su stderr, così nessun modulo deve
// difendersi da un logger assente.
let current = createLogger();

export function initLogger(opts: LoggerOptions): Logger {
  current.close();
  current = createLogger(opts);
  return current;
}

// Funzione e non costante: i moduli che la importano devono vedere l'istanza
// corrente anche se initLogger viene chiamato dopo l'import.
export function log(): Logger {
  return current;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/log.test.ts`
Expected: PASS, 11 test.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/log.ts test/log.test.ts
git commit -m "feat(log): logger strutturato con livelli, rotazione e anello degli errori"
```

---

### Task 2: Configurazione del log

**Files:**
- Modify: `src/config.ts:4-30` (interfaccia `Config`), `src/config.ts:45-68` (`loadConfig`)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `LogLevel`, `LOG_LEVELS` da `src/log.ts` (Task 1).
- Produces: quattro campi nuovi su `Config` — `logLevel: LogLevel`, `logFile: string`, `logMaxBytes: number`, `logKeep: number`.

- [ ] **Step 1: Write the failing test**

Aggiungi in fondo a `test/config.test.ts`, prima della chiusura del file:

```ts
describe('loadConfig — logging', () => {
  it('defaults to info level and a jsonl file under the state dir', () => {
    const c = loadConfig({});
    expect(c.logLevel).toBe('info');
    expect(c.logFile).toBe(`${process.env.HOME}/.claude-omni-rc/logs/daemon.jsonl`);
    expect(c.logMaxBytes).toBe(5_000_000);
    expect(c.logKeep).toBe(3);
  });
  it('follows STATE_DIR', () => {
    expect(loadConfig({ STATE_DIR: '/tmp/orc' }).logFile).toBe('/tmp/orc/logs/daemon.jsonl');
  });
  it('parses overrides', () => {
    const c = loadConfig({ LOG_LEVEL: 'debug', LOG_FILE: '/tmp/x.jsonl', LOG_MAX_BYTES: '1000', LOG_KEEP: '5' });
    expect(c.logLevel).toBe('debug');
    expect(c.logFile).toBe('/tmp/x.jsonl');
    expect(c.logMaxBytes).toBe(1000);
    expect(c.logKeep).toBe(5);
  });
  it('ignores a bogus level and stays on info', () => {
    expect(loadConfig({ LOG_LEVEL: 'chatty' }).logLevel).toBe('info');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `expected undefined to be 'info'`.

- [ ] **Step 3: Write the implementation**

In `src/config.ts`, aggiungi l'import in testa al file:

```ts
import { LOG_LEVELS, type LogLevel } from './log.js';
```

Aggiungi i campi in fondo all'interfaccia `Config` (dopo `noUpdateCheck`):

```ts
  // Log strutturato (vedi src/log.ts). Il file affianca daemon.log/daemon.err.log
  // di launchd: quelli restano l'output grezzo del processo, questo è il tracciato
  // leggibile a macchina degli eventi.
  logLevel: LogLevel;
  logFile: string;
  logMaxBytes: number;
  logKeep: number;
```

Aggiungi l'helper sotto `parseNum`:

```ts
function parseLevel(env: NodeJS.ProcessEnv, key: string, fallback: LogLevel): LogLevel {
  const raw = (env[key] ?? '').trim().toLowerCase();
  return (LOG_LEVELS as string[]).includes(raw) ? (raw as LogLevel) : fallback;
}
```

Aggiungi i campi in fondo all'oggetto restituito da `loadConfig`, dopo `noUpdateCheck`:

```ts
    logLevel: parseLevel(env, 'LOG_LEVEL', 'info'),
    logFile: expandHome(env.LOG_FILE ?? join(stateDir, 'logs', 'daemon.jsonl')),
    logMaxBytes: parseNum(env, 'LOG_MAX_BYTES', 5_000_000),
    logKeep: parseNum(env, 'LOG_KEEP', 3),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/config.ts test/config.test.ts
git commit -m "feat(config): livello, percorso, dimensione e rotazione del log"
```

---

### Task 3: Cablaggio nel daemon

**Files:**
- Modify: `src/daemon.ts:21-53` (inizializzazione), `src/daemon.ts:58-65` (`runUpdateCheck`), `src/daemon.ts:93-104` (avvio come processo principale)
- Test: `test/daemon.test.ts`

**Interfaces:**
- Consumes: `initLogger`, `log` da `src/log.ts` (Task 1); `Config.logLevel` / `logFile` / `logMaxBytes` / `logKeep` (Task 2).
- Produces: dal termine di questo task, ogni modulo può chiamare `log()` e ottenere il logger configurato del daemon.

- [ ] **Step 1: Write the failing test**

Aggiungi in `test/daemon.test.ts`, dentro `describe('createDaemon', ...)`:

```ts
  it('writes a startup record to the configured structured log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-daemon-log-'));
    const config = loadConfig({
      STATE_DIR: dir,
      API_PORT: '0',
      TELEGRAM_BOT_TOKEN: 't',
      CLAUDE_OMNI_RC_NO_UPDATE_CHECK: '1',
    });
    const bot = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), notify: vi.fn() };
    const daemon = createDaemon(config, { bot: bot as any });
    await daemon.start();
    await daemon.stop();
    const file = join(dir, 'logs', 'daemon.jsonl');
    expect(existsSync(file)).toBe(true);
    const records = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const startup = records.find(r => r.msg === 'daemon starting');
    expect(startup).toBeDefined();
    expect(startup.level).toBe('info');
    expect(startup.pid).toBe(process.pid);
    expect(typeof startup.version).toBe('string');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon.test.ts`
Expected: FAIL — `expected false to be true` (il file `logs/daemon.jsonl` non esiste).

- [ ] **Step 3: Write the implementation**

In `src/daemon.ts`, aggiungi l'import accanto agli altri:

```ts
import { initLogger, log } from './log.js';
```

Come **prima** istruzione dentro `createDaemon`, sopra `const state = new StateStore(...)`:

```ts
  // Prima di ogni altra cosa: da qui in poi qualunque modulo può chiamare log()
  // e finire nel file configurato, incluso ciò che fallisce durante il cablaggio.
  initLogger({
    file: config.logFile,
    level: config.logLevel,
    maxBytes: config.logMaxBytes,
    keep: config.logKeep,
  });
  log().info('daemon starting', {
    version: CURRENT_VERSION,
    pid: process.pid,
    apiPort: config.apiPort,
    armedOnStart: config.armedOnStart,
    stateDir: config.stateDir,
  });
```

In `runUpdateCheck`, sostituisci `console.error(message);` con:

```ts
    log().info('update available', { latest, current: CURRENT_VERSION });
```

In `stop()`, come ultima istruzione dopo `manager.persist();`:

```ts
      log().info('daemon stopped');
```

Nel blocco `isMain`, sostituisci i due `console.error`:

```ts
  process.on('unhandledRejection', err => { log().error('unhandledRejection', { err }); });
```

```ts
  daemon.start().catch(err => { log().error('daemon start failed', { err }); process.exit(1); });
```

Nota: `log()` nel blocco `isMain` va importato in cima al file insieme a `initLogger` — è lo stesso import già aggiunto sopra.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon.test.ts`
Expected: PASS, 3 test.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/daemon.ts test/daemon.test.ts
git commit -m "feat(daemon): inizializza il log strutturato e registra avvio, arresto e rifiuti non gestiti"
```

---

### Task 4: Identità degli eventi

**Files:**
- Modify: `src/bus.ts` (aggiunta di `newEventId`), `src/types.ts:52-69` (`BusEvent`), `src/sessions/transcript-watcher.ts:141-178` (metodo `emit`), `src/sessions/sdk-driver.ts:100-130` (emissione degli eventi dallo stream SDK)
- Test: `test/bus.test.ts`, `test/transcript-watcher.test.ts`

**Interfaces:**
- Consumes: `log` da `src/log.ts` (Task 1).
- Produces:
  - `function newEventId(): string` in `src/bus.ts` — stringa di 8 caratteri esadecimali.
  - `eventId?: string` su `session.text`, `session.prompt`, `session.tool`, `session.error` in `BusEvent`.

- [ ] **Step 1: Write the failing test**

Aggiungi in `test/bus.test.ts`:

```ts
import { newEventId } from '../src/bus.js';

describe('newEventId', () => {
  it('returns a short hex id', () => {
    expect(newEventId()).toMatch(/^[0-9a-f]{8}$/);
  });
  it('does not repeat across calls', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newEventId()));
    expect(ids.size).toBe(200);
  });
});
```

Aggiungi in `test/transcript-watcher.test.ts`, come nuovo blocco in fondo al file. Riusa l'helper `makeWatcher()` già presente in cima al file (righe 12-20) e il modo in cui il test esistente invoca il metodo privato, `(watcher as any).emit(s, ev)`:

```ts
describe('TranscriptWatcher — identità degli eventi', () => {
  it('stamps every emitted event with an eventId', () => {
    const { manager, watcher, bus } = makeWatcher();
    const seen: unknown[] = [];
    bus.on('session.text', e => seen.push(e.eventId));
    bus.on('session.prompt', e => seen.push(e.eventId));
    const s = manager.registerTerminal({ title: 'p', projectDir: '/tmp/p', tmuxTarget: 'claude:p' });
    (watcher as any).emit(s, { type: 'text', role: 'assistant', text: 'ciao' });
    (watcher as any).emit(s, { type: 'prompt', questions: [{ question: 'q', options: [{ label: 'a' }] }] });
    expect(seen).toHaveLength(2);
    for (const id of seen) expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('gives a different id to each event', () => {
    const { manager, watcher, bus } = makeWatcher();
    const ids: unknown[] = [];
    bus.on('session.text', e => ids.push(e.eventId));
    const s = manager.registerTerminal({ title: 'p', projectDir: '/tmp/p', tmuxTarget: 'claude:p' });
    (watcher as any).emit(s, { type: 'text', role: 'assistant', text: 'uno' });
    (watcher as any).emit(s, { type: 'text', role: 'assistant', text: 'due' });
    expect(ids[0]).not.toBe(ids[1]);
  });
});
```

**Aggiorna anche le asserzioni esistenti**, che oggi confrontano l'evento *per intero* e falliranno con il campo in più. Sono tre, tutte in `test/transcript-watcher.test.ts` (righe 31, 75, 130):

```ts
// riga 31 — da:
expect(onError).toHaveBeenCalledWith({ type: 'session.error', sessionId: s.id, message: msg });
// a:
expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.error', sessionId: s.id, message: msg }));
```

```ts
// righe 75 e 130 — da:
expect(onText).toHaveBeenCalledWith({ type: 'session.text', sessionId: s.id, role: 'assistant', text: 'ciao' });
// a:
expect(onText).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.text', sessionId: s.id, role: 'assistant', text: 'ciao' }));
```

`test/manager.test.ts:26` asserisce allo stesso modo su `session.updated`, che **non** riceve `eventId` (non è un evento diretto a Telegram): va lasciato com'è.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bus.test.ts test/transcript-watcher.test.ts`
Expected: FAIL — `newEventId is not a function` e, nel watcher, `expected [] to have a length of 1`.

- [ ] **Step 3: Write the implementation**

In `src/bus.ts`, aggiungi in testa al file:

```ts
import { randomBytes } from 'node:crypto';

// Identità di un evento diretto a Telegram: lo accompagna dalla riga di
// transcript (o dallo stream dell'SDK) fino al messaggio consegnato, così un
// evento che non arriva si può cercare nel log invece di essere dedotto.
export function newEventId(): string {
  return randomBytes(4).toString('hex');
}
```

In `src/types.ts`, aggiungi il campo ai quattro membri di `BusEvent` che finiscono in chat:

```ts
  | { type: 'session.text'; sessionId: string; role: 'user' | 'assistant'; text: string; eventId?: string }
  | { type: 'session.prompt'; sessionId: string; questions: PromptQuestion[]; eventId?: string }
  | {
      type: 'session.tool';
      sessionId: string;
      toolName: string;
      kind: 'tool_use' | 'tool_result';
      toolUseId?: string;
      input?: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
      eventId?: string;
    }
  | { type: 'session.error'; sessionId: string; message: string; eventId?: string }
```

In `src/sessions/transcript-watcher.ts`, aggiungi gli import:

```ts
import { newEventId } from '../bus.js';
import { log } from '../log.js';
```

e riscrivi il metodo `emit` (attualmente alle righe 141-178) così che ogni ramo generi l'id, lo passi sull'evento e lo registri:

```ts
  private emit(s: Session, ev: TranscriptEvent): void {
    const { bus, manager } = this.deps;
    const eventId = newEventId();
    manager.touch(s.id);
    if (ev.type === 'prompt') {
      manager.setStatus(s.id, 'awaiting-input');
      log().info('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'prompt', questions: ev.questions.length });
      bus.emit({ type: 'session.prompt', sessionId: s.id, questions: ev.questions, eventId });
      return;
    }
    if (ev.type === 'error') {
      log().warn('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'error', message: ev.message });
      bus.emit({ type: 'session.error', sessionId: s.id, message: ev.message, eventId });
      return;
    }
    if (ev.type === 'text') {
      log().info('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'text', role: ev.role, chars: ev.text.length });
      bus.emit({ type: 'session.text', sessionId: s.id, role: ev.role, text: ev.text, eventId });
      return;
    }
    manager.setStatus(s.id, 'running');
    if (ev.kind === 'tool_use') {
      log().info('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'tool_use', toolName: ev.name, toolUseId: ev.id });
      bus.emit({
        type: 'session.tool', sessionId: s.id, toolName: ev.name, kind: 'tool_use',
        toolUseId: ev.id, input: (ev.input ?? {}) as Record<string, unknown>, eventId,
      });
      return;
    }
    log().debug('event emitted', { eventId, sessionId: s.id, source: 'transcript', kind: 'tool_result', toolName: ev.name, toolUseId: ev.id, isError: ev.isError });
    bus.emit({
      type: 'session.tool', sessionId: s.id, toolName: ev.name, kind: 'tool_result',
      toolUseId: ev.id, result: ev.result, isError: ev.isError, eventId,
    });
  }
```

> Attenzione: la versione originale chiama `manager.touch(s.id)` dentro ogni ramo. Qui è stata sollevata una sola volta in testa, prima dello smistamento: il comportamento è identico (tutti i rami la chiamavano) ed evita la ripetizione.

In `src/sessions/sdk-driver.ts`, aggiungi gli import:

```ts
import { newEventId } from '../bus.js';
import { log } from '../log.js';
```

Poi, per **ogni** `bus.emit({ type: 'session.text' ... })`, `bus.emit({ type: 'session.prompt' ... })`, `bus.emit({ type: 'session.tool' ... })` e `bus.emit({ type: 'session.error' ... })` presente nel file, applica lo stesso schema: genera `const eventId = newEventId();` immediatamente prima dell'emissione, aggiungi `eventId` all'oggetto emesso, e fai precedere l'emissione da

```ts
log().info('event emitted', { eventId, sessionId, source: 'sdk', kind: '<il tipo, es. text>' });
```

usando `log().debug` per i `tool_result` e `log().warn` per gli errori, coerentemente con il watcher.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bus.test.ts test/transcript-watcher.test.ts test/sdk-driver.test.ts`
Expected: PASS, incluse le tre asserzioni riscritte con `expect.objectContaining` allo Step 1.

Se `test/sdk-driver.test.ts` fallisce, è per la stessa ragione: cerca le asserzioni che confrontano un evento del bus per intero e passale a `expect.objectContaining` con gli stessi campi. Non aggiungere `eventId` alle attese: il valore è casuale e l'unica cosa che conta è che ci sia.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/bus.ts src/types.ts src/sessions/transcript-watcher.ts src/sessions/sdk-driver.ts test/bus.test.ts test/transcript-watcher.test.ts
git commit -m "feat(bus): identità degli eventi e registrazione al punto di emissione"
```

---

### Task 5: Gate di consegna esplicito

Questo è il task che produce l'evidenza: al termine, ogni evento che non arriva su Telegram lascia nel log una riga con il **motivo**.

**Files:**
- Modify: `bot/telegram.ts` (nuove funzioni pure vicino a `narrationPlan`, riga ~540; gestori del bus alle righe ~1899-2000)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `log` da `src/log.ts` (Task 1); `eventId` sugli eventi del bus (Task 4).
- Produces:
  - `type DropReason = 'not-armed' | 'no-chat-bound' | 'not-active-session' | 'injected-echo'`
  - `type DeliveryGate = { deliver: true } | { deliver: false; reason: DropReason }`
  - `interface GateInput { kind: GateKind; armed: boolean; sessionId: string; activeSessionId?: string; isInjectedEcho?: boolean }`
  - `type GateKind = 'text' | 'tool' | 'error' | 'result' | 'prompt' | 'permission' | 'dialog'`
  - `function gateSessionEvent(input: GateInput): DeliveryGate`

- [ ] **Step 1: Write the failing test**

Aggiungi `gateSessionEvent` alla lista di import in testa a `test/telegram.test.ts`, poi aggiungi il blocco:

```ts
describe('gateSessionEvent', () => {
  const base = { kind: 'text' as const, armed: true, sessionId: 's1', activeSessionId: 's1' };

  it('delivers a text event for the selected session', () => {
    expect(gateSessionEvent(base)).toEqual({ deliver: true });
  });

  it('drops everything while disarmed, whatever the kind', () => {
    for (const kind of ['text', 'tool', 'error', 'result', 'prompt', 'permission', 'dialog'] as const) {
      expect(gateSessionEvent({ ...base, kind, armed: false })).toEqual({ deliver: false, reason: 'not-armed' });
    }
  });

  it('drops stream events belonging to a session that is not selected', () => {
    expect(gateSessionEvent({ ...base, sessionId: 's2' }))
      .toEqual({ deliver: false, reason: 'not-active-session' });
  });

  it('never drops a blocking interaction for being unselected — it would wedge that session', () => {
    for (const kind of ['prompt', 'permission', 'dialog'] as const) {
      expect(gateSessionEvent({ ...base, kind, sessionId: 's2' })).toEqual({ deliver: true });
    }
  });

  it('drops the echo of text the bot itself injected', () => {
    expect(gateSessionEvent({ ...base, isInjectedEcho: true }))
      .toEqual({ deliver: false, reason: 'injected-echo' });
  });

  it('reports the first applicable reason: disarmed wins over everything', () => {
    expect(gateSessionEvent({ ...base, armed: false, sessionId: 's2', isInjectedEcho: true }))
      .toEqual({ deliver: false, reason: 'not-armed' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — `gateSessionEvent is not a function`.

- [ ] **Step 3: Write the implementation**

In `bot/telegram.ts`, aggiungi l'import in testa al file:

```ts
import { log } from '../src/log.js';
```

Aggiungi le funzioni pure subito dopo `narrationPlan` (riga ~543):

```ts
// Perché un evento non è stato consegnato. Ogni `return` silenzioso dei gestori
// del bus corrisponde a uno di questi motivi: senza un nome, uno scarto è
// indistinguibile da una perdita.
export type DropReason = 'not-armed' | 'no-chat-bound' | 'not-active-session' | 'injected-echo';
export type DeliveryGate = { deliver: true } | { deliver: false; reason: DropReason };
export type GateKind = 'text' | 'tool' | 'error' | 'result' | 'prompt' | 'permission' | 'dialog';

export interface GateInput {
  kind: GateKind;
  armed: boolean;
  sessionId: string;
  activeSessionId?: string;
  isInjectedEcho?: boolean;
}

// Testo, tool, errori e risultati sono uno *stream*: riguardano solo la sessione
// che stai guardando. Domande, permessi e dialoghi sono *bloccanti*: scartarli
// perché la sessione non è selezionata la lascerebbe in attesa per sempre, senza
// modo di rispondere da Telegram — quindi passano sempre, e sono le rispettive
// code a decidere quando mostrarli.
const STREAM_KINDS: ReadonlySet<GateKind> = new Set<GateKind>(['text', 'tool', 'error', 'result']);

// `no-chat-bound` non compare qui di proposito: la mancanza di una chat collegata
// non ferma i gestori (che continuano a chiudere la bolla e a ripulire i flow),
// ferma l'invio — quindi va registrata dove l'invio avviene davvero, non qui.
export function gateSessionEvent(input: GateInput): DeliveryGate {
  if (!input.armed) return { deliver: false, reason: 'not-armed' };
  if (!STREAM_KINDS.has(input.kind)) return { deliver: true };
  if (input.isInjectedEcho) return { deliver: false, reason: 'injected-echo' };
  if (input.sessionId !== input.activeSessionId) return { deliver: false, reason: 'not-active-session' };
  return { deliver: true };
}
```

Aggiungi il metodo privato di supporto nella classe `TelegramBot`, accanto a `logCatch` (riga ~860 circa):

```ts
  // Applica il gate e registra l'esito. Restituisce true se l'evento va avanti.
  private passes(kind: GateKind, sessionId: string, eventId: string | undefined, isInjectedEcho = false): boolean {
    const gate = gateSessionEvent({
      kind,
      armed: this.deps.manager.isArmed(),
      sessionId,
      activeSessionId: this.deps.manager.getActive(),
      isInjectedEcho,
    });
    if (gate.deliver) return true;
    log().info('event dropped', { eventId, sessionId, kind, reason: gate.reason });
    return false;
  }
```

Registra poi lo scarto per chat non collegata nei tre punti in cui avviene per davvero, sostituendo il `return` muto.

In `forwardText` (riga 876-877):

```ts
    const chatId = this.chatId;
    if (!chatId) { log().warn('send skipped', { sessionId, kind: 'text', reason: 'no-chat-bound' }); return; }
```

In `notify` (riga 852-853):

```ts
    const chatId = this.chatId;
    if (!chatId) { log().warn('send skipped', { kind: 'notice', reason: 'no-chat-bound' }); return; }
```

Nel sink della bolla tool (`toolBurst`, righe 906-917), in entrambi i rami `edit` e `send`:

```ts
          const chatId = this.chatId;
          if (!chatId) { log().warn('send skipped', { sessionId, kind: 'tool', reason: 'no-chat-bound' }); return false; }
```

```ts
          const chatId = this.chatId;
          if (!chatId) { log().warn('send skipped', { sessionId, kind: 'tool', reason: 'no-chat-bound' }); return undefined; }
```

Ora sostituisci le guardie nei gestori del bus (righe ~1899-2000).

`session.text` — sostituisci le prime righe del gestore, cioè

```ts
    bus.on('session.text', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.sessionId !== this.deps.manager.getActive()) return; // solo la sessione selezionata
      if (e.role === 'assistant') this.typing.stop();
      if (e.role === 'user' && this.isInjectedEcho(e.sessionId, e.text)) {
        this.toolBurst(e.sessionId).close();
        this.resetSummarize(e.sessionId);
        return;
      }
```

con

```ts
    bus.on('session.text', e => {
      const echo = e.role === 'user' && this.isInjectedEcho(e.sessionId, e.text);
      if (!this.passes('text', e.sessionId, e.eventId, echo)) {
        if (echo) { this.toolBurst(e.sessionId).close(); this.resetSummarize(e.sessionId); }
        return;
      }
      if (e.role === 'assistant') this.typing.stop();
```

> Il comportamento resta identico: l'eco continua a chiudere la bolla e a scartare le summary pendenti, semplicemente ora lo scarto è registrato con il suo motivo.

Nello stesso gestore, subito prima di `void this.forwardText(...)`, aggiungi:

```ts
      log().info('event delivering', { eventId: e.eventId, sessionId: e.sessionId, kind: 'text', role: e.role });
```

e, nel ramo di fusione nella bolla (subito prima di `void burst.push(mdToHtml(e.text));`):

```ts
      log().info('event merged into tool bubble', { eventId: e.eventId, sessionId: e.sessionId, kind: 'text' });
```

`session.prompt` — sostituisci `if (!this.deps.manager.isArmed()) return;` con:

```ts
      if (!this.passes('prompt', sessionId, eventId)) return;
```

e adegua la firma del gestore a `({ sessionId, questions, eventId })`. Subito prima di `this.track(this.onSessionPrompt(...))` aggiungi:

```ts
      log().info('event delivering', { eventId, sessionId, kind: 'prompt', questions: questions.length });
```

`session.tool` — sostituisci `if (!this.deps.manager.isArmed()) return;` con:

```ts
      if (!this.passes('tool', e.sessionId, e.eventId)) return;
```

> Attenzione: il corpo attuale contiene già `e.sessionId === this.deps.manager.getActive()` dentro la condizione del ramo `tool_use`. Poiché il gate ora copre quel controllo per il tipo `tool`, la condizione del ramo si riduce a `if (e.kind === 'tool_use' && e.input)`.

`session.permission` — sostituisci `if (!this.deps.manager.isArmed()) return;` con:

```ts
      if (!this.passes('permission', permission.sessionId, undefined)) return;
```

`session.dialog` (gestore alla riga ~1973) e `session.result` / `session.error` (righe ~1987-1999) — stessa sostituzione, rispettivamente con `'dialog'`, `'result'` ed `'error'` come `kind`, passando `e.eventId` dove l'evento ce l'ha (`session.error`) e `undefined` dove non ce l'ha (`session.dialog`, `session.result`).

Infine, in `sendChunked` (riga ~839), sostituisci il `catch` per registrare l'esito reale dell'invio:

```ts
      const msg = await this.bot.api.sendMessage(chatId, parts[i], opts).catch(err => { log().error('telegram send failed', { chatId, part: i, of: parts.length, err }); return undefined; });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS, inclusi i 7 test nuovi di `gateSessionEvent`.

- [ ] **Step 5: Verifica manuale — riproduzione del caso reale**

Questo passo è il motivo per cui esiste l'intera fase.

```bash
./scripts/restart.sh
tail -f ~/.claude-omni-rc/logs/daemon.jsonl
```

Da Telegram: `/rc on`, poi `/sessions` e seleziona una sessione terminale attiva. Nella sessione, fai fare al modello alcune tool call seguite da un testo e da una domanda a scelta multipla (è la sequenza descritta in §2.1 della spec). Sul log devono comparire, per lo stesso `eventId`, o una riga `event delivering`, o una riga `event dropped` con il motivo. Annota nel commit quale motivo compare per il testo e per la domanda perduti: è il dato che manca per scrivere il piano della Fase 2.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck && npm test
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat(bot): gate di consegna esplicito, con motivo dello scarto registrato"
```

---

### Task 6: Comando /diag e documentazione

**Files:**
- Modify: `bot/telegram.ts` (funzione pura `diagReport` accanto a `sessionListText`; registrazione del comando accanto agli altri comandi di controllo; voce nella risposta di `/help`)
- Modify: `README.md` (tabella dei comandi, tabella della configurazione, riga sui log nella sezione Troubleshooting), `CHANGELOG.md` (sezione `[Unreleased]`), `.env.example`
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `log` da `src/log.ts` (Task 1); `Session`, `SessionKind`, `SessionStatus` da `src/types.js`.
- Produces:
  - `interface DiagSnapshot { version: string; armed: boolean; chatBound: boolean; activeSessionId?: string; sessions: DiagSession[]; pending: { permissions: number; dialogs: number; questionFlows: number }; recentErrors: string[] }`
  - `interface DiagSession { id: string; kind: SessionKind; status: SessionStatus; title: string; transcript?: string; hasTmux: boolean }`
  - `function diagReport(s: DiagSnapshot): string`

- [ ] **Step 1: Write the failing test**

Aggiungi `diagReport` alla lista di import in testa a `test/telegram.test.ts`, poi:

```ts
describe('diagReport', () => {
  const snapshot = {
    version: '0.2.0',
    armed: true,
    chatBound: true,
    activeSessionId: 'aaaaaaaa-1111',
    sessions: [
      { id: 'aaaaaaaa-1111', kind: 'terminal' as const, status: 'idle' as const, title: 'my-proj', transcript: 'abc.jsonl', hasTmux: true },
      { id: 'bbbbbbbb-2222', kind: 'headless' as const, status: 'running' as const, title: 'task', hasTmux: false },
    ],
    pending: { permissions: 1, dialogs: 0, questionFlows: 2 },
    recentErrors: ['{"level":"error","msg":"telegram send failed"}'],
  };

  it('reports armed state, version and the selected session', () => {
    const out = diagReport(snapshot);
    expect(out).toContain('0.2.0');
    expect(out).toContain('armed');
    expect(out).toContain('aaaaaaaa'); // id abbreviato della sessione selezionata
  });

  it('lists every session with kind, status and whether it can receive input', () => {
    const out = diagReport(snapshot);
    expect(out).toContain('my-proj');
    expect(out).toContain('terminal');
    expect(out).toContain('headless');
    expect(out).toContain('running');
  });

  it('reports the pending interactions, which are what wedges a session', () => {
    const out = diagReport(snapshot);
    expect(out).toMatch(/permissions.*1/);
    expect(out).toMatch(/questions.*2/);
  });

  it('includes the recent errors and escapes them for HTML', () => {
    const out = diagReport({ ...snapshot, recentErrors: ['<script>&'] });
    expect(out).toContain('&lt;script&gt;&amp;');
    expect(out).not.toContain('<script>');
  });

  it('says so plainly when nothing is tracked', () => {
    const out = diagReport({ ...snapshot, sessions: [], recentErrors: [], pending: { permissions: 0, dialogs: 0, questionFlows: 0 } });
    expect(out).toContain('no sessions');
    expect(out).toContain('no recent errors');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — `diagReport is not a function`.

- [ ] **Step 3: Write the implementation**

In `bot/telegram.ts`, aggiungi accanto a `sessionListText`:

```ts
// Fotografia dello stato del daemon, resa per Telegram. Serve nella situazione
// in cui il servizio è utile: sei fuori casa, qualcosa non arriva, e non hai un
// terminale per guardare i log.
export interface DiagSession {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  title: string;
  transcript?: string;
  hasTmux: boolean;
}

export interface DiagSnapshot {
  version: string;
  armed: boolean;
  chatBound: boolean;
  activeSessionId?: string;
  sessions: DiagSession[];
  pending: { permissions: number; dialogs: number; questionFlows: number };
  recentErrors: string[];
}

export function diagReport(s: DiagSnapshot): string {
  const head = [
    `🩺 <b>claude-omni-rc ${htmlEscape(s.version)}</b>`,
    `state: ${s.armed ? 'armed' : 'disarmed'} · chat ${s.chatBound ? 'bound' : 'not bound'}`,
    `selected: ${s.activeSessionId ? `<code>${htmlEscape(s.activeSessionId.slice(0, 8))}</code>` : '—'}`,
  ].join('\n');

  const sessions = s.sessions.length
    ? s.sessions.map(x => {
        const bits = [x.kind, x.status, x.hasTmux ? 'tmux' : 'no-tmux', x.transcript ? 'transcript' : 'no-transcript'];
        return `• <code>${htmlEscape(x.id.slice(0, 8))}</code> ${htmlEscape(x.title)} — ${htmlEscape(bits.join(' · '))}`;
      }).join('\n')
    : 'no sessions tracked';

  const pending = `permissions ${s.pending.permissions} · dialogs ${s.pending.dialogs} · questions ${s.pending.questionFlows}`;

  const errors = s.recentErrors.length
    ? s.recentErrors.map(l => `<code>${htmlEscape(l)}</code>`).join('\n')
    : 'no recent errors';

  return `${head}\n\n<b>Sessions</b>\n${sessions}\n\n<b>Pending</b>\n${htmlEscape(pending)}\n\n<b>Recent errors</b>\n${errors}`;
}
```

Assicurati che `SessionKind` e `SessionStatus` siano nella lista di import dei tipi in testa a `bot/telegram.ts` (il file importa già `Session` da `../src/types.js`).

Aggiungi `basename` all'import da `node:path` in testa al file, che oggi importa solo `join` (riga 2):

```ts
import { join, basename } from 'node:path';
```

Registra il comando in `register()` (riga ~993), subito dopo la riga di `bot.command('usage', ...)`, con lo stesso wrapper `safe` e la stessa guardia di autorizzazione degli altri (`this.authorize(ctx)`, che restituisce `true` e lega la chat, o risponde da sé):

```ts
    bot.command('diag', ctx => this.safe(ctx, 'diag', async () => {
      if (!this.authorize(ctx)) return;
      const sessions = this.deps.manager.list();
      await this.send(ctx, diagReport({
        version: CURRENT_VERSION,
        armed: this.deps.manager.isArmed(),
        chatBound: this.chatId !== undefined,
        activeSessionId: this.deps.manager.getActive(),
        sessions: sessions.map(x => ({
          id: x.id,
          kind: x.kind,
          status: x.status,
          title: x.title,
          transcript: x.transcriptFile ? basename(x.transcriptFile) : undefined,
          hasTmux: Boolean(x.tmuxTarget),
        })),
        pending: {
          permissions: this.deps.permissionFlow.pendingCount(),
          dialogs: this.deps.dialogFlow.pendingCount(),
          questionFlows: this.questionFlows.size,
        },
        recentErrors: log().recentErrors(),
      }));
    }));
```

> `this.send(ctx, text)` (riga 831) rende in HTML e spezza già il testo oltre il limite di Telegram: `/diag` con molte sessioni e venti errori recenti supera i 4096 caratteri, quindi va usato quello e non `ctx.reply` diretto.

Aggiungi anche `/diag` alla stringa di `/help` (riga ~997), che oggi termina con `· /usage · /help`:

```ts
      if (this.authorize(ctx)) await this.send(ctx, 'Commands: /rc [on|off|status] (no arg toggles) · /sessions · /view · /new &lt;text&gt; · /stop · /status · /attach &lt;project&gt; · /history [id] · /delete [id] · /usage · /diag · /help');
```

`PermissionFlow` e `DialogFlow` non espongono ancora il conteggio dei pendenti. Aggiungi a `src/permissions.ts` e a `src/dialogs.ts`, dentro le rispettive classi, accanto a `cancelAllForSession`:

```ts
  // Quanti pendenti ci sono adesso: è il numero che dice se una sessione è
  // ferma ad aspettare qualcosa (vedi /diag).
  pendingCount(): number {
    return this.pending.size;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS, inclusi i 5 test nuovi di `diagReport`.

- [ ] **Step 5: Aggiorna la documentazione**

In `README.md`, nella tabella dei comandi (dopo la riga di `/usage`):

```
| `/diag` | daemon state, sessions, pending interactions and recent errors |
```

Nella tabella della configurazione, dopo `CLAUDE_OMNI_RC_NO_UPDATE_CHECK`:

```
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` for the structured log |
| `LOG_FILE` | `<STATE_DIR>/logs/daemon.jsonl` | where the structured log is written |
| `LOG_MAX_BYTES` | `5000000` | rotate the structured log past this size |
| `LOG_KEEP` | `3` | how many rotated log files to keep |
```

Sostituisci la nota sulla rotazione dei log (la citazione che dice che `daemon.log` non ha rotazione automatica) con:

```
> `~/.claude-omni-rc/logs/daemon.jsonl` is the structured log, one JSON record
> per line, rotated at `LOG_MAX_BYTES`. `daemon.log` and `daemon.err.log` remain
> the raw process output from launchd and have no automatic rotation — that's
> left to the OS (`newsyslog`) or to you.
```

Nella tabella Troubleshooting, aggiungi:

```
| A message never arrived on Telegram | `/diag` from the phone, then `~/.claude-omni-rc/logs/daemon.jsonl`: every event carries an `eventId` from the transcript to the delivered message, and a dropped one is logged with its reason. |
```

In `.env.example`, aggiungi in fondo:

```
# Structured log (see README). Level: error | warn | info | debug.
# LOG_LEVEL=info
# LOG_FILE=~/.claude-omni-rc/logs/daemon.jsonl
# LOG_MAX_BYTES=5000000
# LOG_KEEP=3
```

In `CHANGELOG.md`, sotto `## [Unreleased]`, in testa alla lista:

```
- **Structured log and `/diag`.** The daemon writes one JSON record per event to
  `~/.claude-omni-rc/logs/daemon.jsonl` (levels, size-based rotation). Every
  event bound for Telegram now carries an id from the transcript line to the
  delivered message, and an event that is *not* delivered is logged with the
  reason instead of vanishing. `/diag` reports daemon state, sessions, pending
  interactions and recent errors from the phone.
```

- [ ] **Step 6: Typecheck, full test run and commit**

```bash
npm run typecheck && npm test
git add bot/telegram.ts src/permissions.ts src/dialogs.ts test/telegram.test.ts README.md CHANGELOG.md .env.example
git commit -m "feat(bot): comando /diag e documentazione dell'osservabilità"
```

---

## Verifica di fine fase

- [ ] `npm run typecheck && npm test` verdi.
- [ ] `./scripts/restart.sh` e poi `tail -f ~/.claude-omni-rc/logs/daemon.jsonl`: compare `daemon starting` con versione e pid.
- [ ] `/diag` da Telegram risponde con stato, sessioni e pendenti.
- [ ] Riproduzione del caso di §2.1 della spec: per l'evento di testo e per l'evento di domanda perduti compare nel log o `event delivering` o `event dropped` con il motivo. **Annotare il motivo osservato**: è il dato di ingresso del piano della Fase 2.
- [ ] `daemon.jsonl` supera `LOG_MAX_BYTES` e ruota (verificabile abbassando temporaneamente la soglia in `.env`).

## Fuori dalla Fase 1

Rimandati per scelta, ognuno alla propria fase della spec:

- Coda persistita, writer unico, trasporto astratto, ritentativi (Fase 2).
- Riconciliazione dal transcript e registro dei pendenti persistito (Fase 3).
- Autodiagnosi con invarianti e notifiche (Fase 3): `/diag` è a richiesta, il controllo periodico arriva insieme alla riconciliazione, che è ciò che gli dà gli invarianti da controllare.
- Guardrail di sessione (Fase 4).
- Fixture di transcript reali e test delle avversità (Fase 5).
