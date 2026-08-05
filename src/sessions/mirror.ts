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
    const chunk = this.readNewChunk(key, absPath);
    if (!chunk) return;
    this.schedulePersist();
    const encoded = key.split('/')[0];
    // matching per uguaglianza encoded (esatto per qualsiasi path)
    const session = this.deps.manager.list().find(s => encodeProjectPath(s.projectDir) === encoded);
    if (session) {
      this.emitLines(session.id, chunk.text);
    } else {
      this.autoRegisterAndEmit(encoded, chunk.text);
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

  // Auto-registrazione (spec §4): se la dir encoded non ha una sessione, cerca un
  // target tmux `claude:<name>` il cui name sia suffisso della dir encoded. Gli eventi
  // letti in QUESTA poll vengono emessi subito dopo la registrazione (il primo batch
  // non va perso). projectDir best-effort via decode: encode(decode(encoded))===encoded.
  private autoRegisterAndEmit(encoded: string, text: string): void {
    void this.deps.tmux.listSessions().then(sessions => {
      const target = sessions.find(t => {
        const name = t.replace(/^claude:/, '');
        return encoded === name || encoded.endsWith(`-${name}`);
      });
      if (!target) return;
      const name = target.replace(/^claude:/, '');
      const s = this.deps.manager.registerTerminal({
        title: name,
        projectDir: decodeProjectDir(encoded),
        tmuxTarget: target,
      });
      this.emitLines(s.id, text);
    }).catch(() => {});
  }
}
