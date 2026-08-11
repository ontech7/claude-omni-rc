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
    if (level === 'error') {
      // Il logging non deve MAI poter uccidere il daemon: una write su stderr
      // può lanciare in sincrono (EPIPE/EBADF su un descrittore staccato), e
      // senza questo try/catch l'eccezione risalirebbe fino a chi ha chiamato
      // log().error() — incluso l'handler di unhandledRejection in daemon.ts,
      // dove diventerebbe un'eccezione non gestita.
      try { this.stderr(line); } catch { /* vedi sopra: non deve propagare */ }
    }
    if (this.fd === undefined) return;
    const lineBytes = Buffer.byteLength(line);
    if (this.size + lineBytes > this.maxBytes) this.rotate();
    if (this.fd === undefined) return;
    try {
      writeSync(this.fd, line);
      this.size += lineBytes;
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
