import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { SessionManager } from './manager.js';
import type { TmuxClient } from './tmux-inject.js';

export interface MirrorDeps {
  bus: Bus;
  manager: SessionManager;
  config: Config;
  tmux: Pick<TmuxClient, 'listSessions'>;
}

export interface ParsedEvent {
  type: 'session.text' | 'session.tool';
  role?: 'user' | 'assistant';
  text?: string;
  toolName?: string;
  kind?: 'tool_use' | 'tool_result';
  toolUseId?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

// Un progetto con JSONL modificati negli ultimi N minuti conta come "sessione in
// corso" e viene auto-registrato come mirror anche senza una sessione tmux claude:*.
const AUTO_REGISTER_FRESH_MS = 15 * 60_000;

// Claude Code: ogni '/' (incluso l'iniziale) diventa '-'.
export function encodeProjectPath(projectDir: string): string {
  return projectDir.replace(/\//g, '-');
}

// Inverso best-effort: '-' → '/'. Lossy sui trattini letterali del path originale,
// ma encode(decode(encoded)) === encoded vale sempre → sicuro per il matching.
export function decodeProjectDir(encoded: string): string {
  return encoded.replace(/-/g, '/');
}

export function parseLine(line: string): ParsedEvent[] | null {
  if (!line.trim()) return null;
  let obj: { message?: { type?: string; role?: string; content?: Array<Record<string, unknown>> } };
  try { obj = JSON.parse(line); } catch { return null; }
  const message = obj.message;
  if (!message || message.type !== 'message' || !Array.isArray(message.content)) return null;
  const role = message.role as 'user' | 'assistant';
  const events: ParsedEvent[] = [];
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      events.push({ type: 'session.text', role, text: block.text });
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'session.tool', kind: 'tool_use',
        toolName: block.name as string, toolUseId: block.id as string,
        input: block.input as Record<string, unknown>,
      });
    } else if (block.type === 'tool_result') {
      events.push({
        type: 'session.tool', kind: 'tool_result',
        toolUseId: block.tool_use_id as string, result: block.content, isError: Boolean(block.is_error),
      });
    }
  }
  return events.length ? events : null;
}

export class JsonlMirror {
  private offsets: Record<string, number>;
  private partials: Record<string, string> = {};
  private timer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;

  constructor(private deps: MirrorDeps) {
    this.offsets = { ...deps.manager.getState().mirrorOffsets };
  }

  start(): void { this.poll(); this.timer = setInterval(() => this.poll(), this.deps.config.pollIntervalMs); }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
  }

  // constraint 16: gli offset vanno persistiti per la ripartenza (crash → launchd).
  // Debounce ~2s: persist dell'intero state.json a ogni lettura, ma al massimo
  // ogni 2 secondi, così un crash riattacca il tail vicino alla coda vera.
  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.deps.manager.persist();
    }, 2000);
  }

  poll(): void {
    if (!this.deps.manager.isArmed()) return;
    const dirs = this.discoverProjectDirs();
    for (const encoded of dirs) this.pollProjectDir(encoded);
  }

  private discoverProjectDirs(): string[] {
    const dirs = new Set<string>();
    for (const s of this.deps.manager.list()) dirs.add(encodeProjectPath(s.projectDir));
    try {
      for (const entry of readdirSync(this.deps.config.projectsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(entry.name);
      }
    } catch { /* projects dir non ancora creato */ }
    return [...dirs];
  }

  private pollProjectDir(encoded: string): void {
    const dir = join(this.deps.config.projectsDir, encoded);
    let files: string[];
    try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return; }
    for (const f of files) this.pollFile(`${encoded}/${f}`, join(dir, f));
  }

  private pollFile(key: string, absPath: string): void {
    const encoded = key.split('/')[0];
    // Prima osservazione di un file già esistente: consuma lo storico in silenzio
    // (offset → EOF, nessun emit). Niente replay di sessioni passate sul bot — da
    // Telegram si vede solo l'attività che arriva DOPO l'arm. Se il file è appena
    // stato creato (size 0) si parte da zero e le righe successive streammano.
    if (this.offsets[key] === undefined) {
      let size: number;
      try { size = statSync(absPath).size; } catch { return; }
      // marca il file come osservato: da qui in poi è il path normale a gestire
      // offset e righe parziali (senza questa marcatura, un file con solo una riga
      // incompleta resterebbe in "prima osservazione" e la riga completata dopo
      // verrebbe scartata come backlog)
      this.offsets[key] = 0;
      this.deps.manager.getState().mirrorOffsets[key] = 0;
      if (size > 0) {
        // File pre-esistente: consuma lo storico in silenzio fino all'ultima riga
        // completa (readNewChunk gestisce anche una riga finale incompleta) senza
        // emettere nulla — niente flood di sessioni passate sul bot. La dir va
        // registrata comunque se è una sessione in corso, così /sessions la vede.
        this.readNewChunk(key, absPath);
        this.schedulePersist();
        if (!this.deps.manager.list().some(s => encodeProjectPath(s.projectDir) === encoded)) {
          this.autoRegister(encoded);
        }
      }
      return;
    }
    const chunk = this.readNewChunk(key, absPath);
    if (!chunk) return;
    this.schedulePersist();
    // matching per uguaglianza encoded (esatto per qualsiasi path)
    const session = this.deps.manager.list().find(s => encodeProjectPath(s.projectDir) === encoded);
    if (session) {
      this.emitLines(session.id, chunk.text);
    } else {
      this.autoRegister(encoded);
    }
  }

  // Legge i byte nuovi e avanza l'offset SOLO fino all'ultima riga completa (`\n`):
  // una riga ancora in scrittura resta in `partials` (e l'offset punta al suo inizio)
  // così non viene consumata né persa. Restituisce null finché non c'è una riga completa.
  private readNewChunk(key: string, absPath: string): { text: string } | null {
    let size: number;
    try { size = statSync(absPath).size; } catch { return null; }
    const partial = this.partials[key] ?? '';
    const readStart = (this.offsets[key] ?? 0) + Buffer.byteLength(partial);
    if (size < readStart) {
      // file troncato/ricreato: riparti da zero (replay da 0, accettato)
      this.offsets[key] = 0;
      this.partials[key] = '';
      return this.readNewChunk(key, absPath);
    }
    if (size === readStart) return null;
    const len = size - readStart;
    const buf = Buffer.alloc(len);
    const fd = openSync(absPath, 'r');
    readSync(fd, buf, 0, len, readStart);
    closeSync(fd);
    const decoded = partial + buf.toString('utf8');
    const nl = decoded.lastIndexOf('\n');
    if (nl === -1) { this.partials[key] = decoded; return null; }
    const text = decoded.slice(0, nl);
    const newPartial = decoded.slice(nl + 1);
    this.partials[key] = newPartial;
    const newOffset = size - Buffer.byteLength(newPartial);
    this.offsets[key] = newOffset;
    this.deps.manager.getState().mirrorOffsets[key] = newOffset;
    return { text };
  }

  private emitLines(sessionId: string, text: string): void {
    this.deps.manager.touch(sessionId);
    this.deps.manager.setStatus(sessionId, 'running');
    for (const line of text.split('\n')) {
      const events = parseLine(line);
      if (!events) continue;
      for (const ev of events) {
        if (ev.type === 'session.text') {
          this.deps.bus.emit({ type: 'session.text', sessionId, role: ev.role!, text: ev.text! });
        } else {
          this.deps.bus.emit({
            type: 'session.tool', sessionId, toolName: ev.toolName ?? '', kind: ev.kind!,
            toolUseId: ev.toolUseId, input: ev.input, result: ev.result, isError: ev.isError,
          });
        }
      }
    }
  }

  // Auto-registrazione (spec §4, estesa): se la dir encoded non ha una sessione,
  // la registra come terminale quando (a) esiste una sessione tmux `claude:<name>`
  // il cui name è suffisso della dir encoded (→ continuabile via injection), oppure
  // (b) i JSONL sono stati modificati di recente (→ mirror read-only, senza target).
  // Nessun backlog emesso: il replay dello storico è già stato consumato in silenzio
  // dalla prima osservazione. projectDir best-effort via decode: encode(decode)===encoded.
  private autoRegister(encoded: string): void {
    const dir = join(this.deps.config.projectsDir, encoded);
    let mtime = 0;
    try {
      for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
        const st = statSync(join(dir, f));
        if (st.mtimeMs > mtime) mtime = st.mtimeMs;
      }
    } catch { return; }
    const fresh = Date.now() - mtime < AUTO_REGISTER_FRESH_MS;
    void this.deps.tmux.listSessions().then(sessions => {
      const target = sessions.find(t => {
        const name = t.replace(/^claude:/, '');
        return encoded === name || encoded.endsWith(`-${name}`);
      });
      if (!target && !fresh) return;
      const projectDir = decodeProjectDir(encoded);
      if (this.deps.manager.findByProjectDir(projectDir)) return; // già registrata
      this.deps.manager.registerTerminal({
        title: target ? target.replace(/^claude:/, '') : this.titleFromEncoded(encoded),
        projectDir,
        ...(target ? { tmuxTarget: target } : {}),
      });
    }).catch(() => {});
  }

  // Titolo best-effort dall'encoded: ultimo segmento dopo l'ultimo '-'.
  private titleFromEncoded(encoded: string): string {
    const seg = encoded.split('-').filter(Boolean);
    return seg[seg.length - 1] || encoded;
  }
}
