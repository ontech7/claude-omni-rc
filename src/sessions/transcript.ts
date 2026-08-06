import { existsSync, openSync, readSync, closeSync, fstatSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PromptQuestion } from '../types.js';

// Lettura dei transcript che Claude Code scrive da solo
// (`~/.claude/projects/<project-munged>/<session>.jsonl`). Il CLI appende ogni
// blocco di messaggio come riga JSON completa — niente delta live — quindi la
// chat si costruisce leggendo i blocchi man mano che vengono scritti.

export type TranscriptState = 'working' | 'awaiting' | 'unknown';

export interface TranscriptTextEvent { type: 'text'; role: 'user' | 'assistant'; text: string }
export interface TranscriptToolEvent {
  type: 'tool';
  kind: 'tool_use' | 'tool_result';
  name: string;
  id?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
}
export interface TranscriptPromptEvent { type: 'prompt'; questions: PromptQuestion[] }
export interface TranscriptErrorEvent { type: 'error'; message: string }
export type TranscriptEvent = TranscriptTextEvent | TranscriptToolEvent | TranscriptPromptEvent | TranscriptErrorEvent;

// Le domande a scelta multipla del CLI (tool_use "AskUserQuestion") sono
// strutturate nel transcript: header, domanda e opzioni. Rispondendo con il
// numero (o il testo) dell'opzione il menu viene risolto via tmux.
export function parseAskUserQuestions(input: unknown): PromptQuestion[] {
  const qs = (input as { questions?: unknown })?.questions;
  if (!Array.isArray(qs)) return [];
  const out: PromptQuestion[] = [];
  for (const q of qs) {
    if (!q || typeof q !== 'object') continue;
    const qq = q as { header?: unknown; question?: unknown; multiSelect?: unknown; options?: unknown };
    if (typeof qq.question !== 'string' || !qq.question.trim()) continue;
    const options = Array.isArray(qq.options)
      ? qq.options
          .filter((o): o is { label?: unknown; description?: unknown } => !!o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string')
          .map(o => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : undefined }))
      : [];
    out.push({
      header: typeof qq.header === 'string' ? qq.header : undefined,
      question: qq.question,
      multiSelect: qq.multiSelect === true,
      options,
    });
  }
  return out;
}

// Claude Code munge il project dir in path assoluto con '/' → '-'. I punti sono
// sostituiti in alcune versioni → proviamo entrambe le varianti e usiamo quella
// che esiste sul disco.
export function mungedProjectDir(projectDir: string, dotsToDash = false): string {
  const cleaned = projectDir.replace(/^\/+/, '');
  const dashed = cleaned.replace(/\//g, '-');
  return '-' + (dotsToDash ? dashed.replace(/\./g, '-') : dashed);
}

export function transcriptDirCandidates(projectsDir: string, projectDir: string): string[] {
  return [mungedProjectDir(projectDir), mungedProjectDir(projectDir, true)];
}

export function resolveTranscriptDir(projectsDir: string, projectDir: string): string | undefined {
  for (const dir of transcriptDirCandidates(projectsDir, projectDir)) {
    const abs = join(projectsDir, dir);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

// La sessione attiva per un progetto è il .jsonl modificato più di recente
// (non esiste un file last_session_id su questa versione del CLI).
export function newestTranscriptFile(dir: string): string | undefined {
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (!files.length) return undefined;
    let best: string | undefined;
    let bestMtime = 0;
    for (const f of files) {
      const p = join(dir, f);
      try {
        const m = statSync(p).mtimeMs;
        if (m > bestMtime) { bestMtime = m; best = p; }
      } catch { /* file scomparso nel frattempo */ }
    }
    return best;
  } catch {
    return undefined;
  }
}

export interface RecentMessage { role: 'user' | 'assistant'; text: string }

// Storia retroattiva per il Fix 5: legge gli ultimi `max` messaggi testuali
// (user/assistant) dal transcript, saltando thinking e tool. Usata quando si
// seleziona una sessione e dal comando /history.
export function readRecentMessages(file: string, max = 10): RecentMessage[] {
  try {
    const out: RecentMessage[] = [];
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      if (!raw.trim()) continue;
      let d: { type?: string; isMeta?: boolean; isCompactSummary?: boolean; message?: { content?: unknown } };
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
        // same guard as the live stream: skip slash commands / compaction noise
        if (isMetaUserLine(d)) continue;
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

// Il modello usato dalla sessione: prima riga assistant con `model`.
export function transcriptModel(file: string): string | undefined {
  try {
    const buf = Buffer.alloc(1_000_000);
    const fh = openSync(file, 'r');
    try {
      const n = readSync(fh, buf, 0, buf.length, 0);
      const head = buf.toString('utf8', 0, n);
      for (const line of head.split('\n')) {
        if (!line.trim()) continue;
        let d: unknown;
        try { d = JSON.parse(line); } catch { continue; }
        const msg = (d as { message?: { model?: string } })?.message;
        if (msg?.model) return msg.model;
      }
    } finally {
      closeSync(fh);
    }
  } catch { /* file illeggibile */ }
  return undefined;
}

interface JsonBlock { type?: string; text?: string; name?: string; id?: string; input?: unknown; content?: unknown; tool_use_id?: string; is_error?: boolean; thinking?: string }

// Ultima riga completa del file (per lo stato iniziale quando partiamo da EOF).
export function peekTranscriptState(file: string): TranscriptState {
  try {
    const fh = openSync(file, 'r');
    try {
      const size = fstatSync(fh).size;
      const len = Math.min(size, 64_000);
      const b = Buffer.alloc(len);
      const n = readSync(fh, b, 0, len, size - len);
      const tail = b.toString('utf8', 0, n);
      const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        const st = stateFromLine(lines[i]);
        if (st !== 'unknown') return st;
      }
    } finally {
      closeSync(fh);
    }
  } catch { /* file illeggibile */ }
  return 'unknown';
}

interface UserLineShape {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { content?: unknown };
}

// User lines that are NOT a real prompt: Claude Code writes them for local slash
// commands (/compact, /clear, …) and for compaction bookkeeping. They must not be
// forwarded as chat text and must not flip the state to "working" — a slash
// command never produces an assistant end_turn, so a "working" state would leave
// the "typing…" indicator (and the session status) stuck on forever.
export function isMetaUserLine(d: UserLineShape): boolean {
  if (d.isCompactSummary === true || d.isMeta === true) return true;
  const content = d.message?.content;
  if (typeof content === 'string') {
    if (content.startsWith('<command-name>') || content.startsWith('<local-command-caveat>') || content.startsWith('<local-command-stdout>')) return true;
    if (content.startsWith('/')) return true; // slash command: the CLI intercepts it before the model
  }
  return false;
}

// Stato "in attesa dell'umano" derivato dall'ultima riga del file: un turno
// finisce con un assistant stop_reason "end_turn"/"max_tokens" o con un system
// turn_duration.
export function stateFromLine(raw: string): TranscriptState {
  let d: UserLineShape & { subtype?: string; message?: { stop_reason?: string | null; content?: unknown } };
  try { d = JSON.parse(raw); } catch { return 'unknown'; }
  if (d.type === 'assistant') {
    const stop = d.message?.stop_reason;
    return stop === 'end_turn' || stop === 'max_tokens' ? 'awaiting' : 'working';
  }
  if (d.type === 'system' && d.subtype === 'turn_duration') return 'awaiting';
  // meta/command lines (isMeta, isCompactSummary, slash commands) say nothing
  // about whether the model is working → keep the previous status.
  if (d.type === 'user') return isMetaUserLine(d) ? 'unknown' : 'working';
  return 'unknown';
}

export function parseLineState(line: string): TranscriptState {
  return stateFromLine(line);
}

// Parser incrementale: tiene traccia di cosa ha già emesso (un messaggio
// assistant viene scritto una riga per blocco, con lo stesso id) per non
// duplicare i blocchi testuali/tool nel caso il CLI li riscriva.
export class TranscriptParser {
  private seenText = new Set<string>();
  private seenTool = new Set<string>();
  private seenError = new Set<string>();
  state: TranscriptState = 'unknown';

  consumeLine(raw: string): TranscriptEvent[] {
    let d: { type?: string; subtype?: string; isMeta?: boolean; isCompactSummary?: boolean; message?: { id?: string; stop_reason?: string | null; content?: JsonBlock[] | string } };
    try { d = JSON.parse(raw); } catch { return []; }
    const events: TranscriptEvent[] = [];
    if (d.type === 'assistant') {
      const m = d.message ?? {};
      const stop = m.stop_reason;
      const mid = m.id ?? '';
      const blocks = Array.isArray(m.content) ? m.content : [];
      let sawPrompt = false;
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text) {
          const key = `m:${mid}`;
          if (this.seenText.has(key)) continue;
          this.seenText.add(key);
          events.push({ type: 'text', role: 'assistant', text: b.text });
        } else if (b.type === 'tool_use' && b.name) {
          if (b.name === 'AskUserQuestion') {
            // il CLI ha aperto il menu a scelta multipla → attende l'umano
            sawPrompt = true;
            const key = `p:${b.id ?? mid}`;
            if (!this.seenTool.has(key)) {
              this.seenTool.add(key);
              const questions = parseAskUserQuestions(b.input);
              if (questions.length) events.push({ type: 'prompt', questions });
            }
            continue;
          }
          const key = `t:${b.id ?? mid}`;
          if (this.seenTool.has(key)) continue;
          this.seenTool.add(key);
          events.push({ type: 'tool', kind: 'tool_use', name: b.name, id: b.id, input: b.input });
        }
      }
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
    }
    if (d.type === 'user') {
      const content = d.message?.content;
      if (typeof content === 'string') {
        // local slash commands (/compact) and compaction bookkeeping are not real
        // prompts: no forward, and no "working" state (nothing would ever reset it).
        if (isMetaUserLine(d)) return events;
        this.state = 'working';
        events.push({ type: 'text', role: 'user', text: content });
        return events;
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_result') {
            this.state = 'working';
            events.push({
              type: 'tool', kind: 'tool_result', name: b.tool_use_id ?? '',
              id: b.tool_use_id, result: b.content, isError: !!b.is_error,
            });
          }
        }
        return events;
      }
      return events;
    }
    if (d.type === 'system' && d.subtype === 'turn_duration') {
      this.state = 'awaiting';
      return events;
    }
    return events;
  }
}

// Tail incrementale di un file transcript. Parte dalla fine (nessun replay
// della storia) e a ogni poll() legge i byte nuovi e li divide in righe.
export class TranscriptTail {
  private offset: number;
  private buf = '';
  parser = new TranscriptParser();
  readonly file: string;

  constructor(file: string, startAtEnd = true) {
    this.file = file;
    this.offset = startAtEnd ? TranscriptTail.sizeOf(file) : 0;
  }

  private static sizeOf(file: string): number {
    try { return statSync(file).size; } catch { return 0; }
  }

  // true se il file è cresciuto da quando abbiamo letto (o è stato riscritto)
  hasChanges(): boolean {
    return TranscriptTail.sizeOf(this.file) !== this.offset;
  }

  // Legge i byte nuovi e restituisce gli eventi + lo stato aggiornato.
  poll(): { events: TranscriptEvent[]; state: TranscriptState } {
    let content = '';
    try {
      const fh = openSync(this.file, 'r');
      try {
        const size = fstatSync(fh).size;
        if (size < this.offset) {
          // file riscritto/accorciato (il CLI può riscrivere il transcript):
          // per non riprodurre la storia, saltiamo al nuovo EOF e ricominciamo.
          this.offset = size;
          this.buf = '';
        }
        const toRead = size - this.offset;
        if (toRead > 0) {
          const maxRead = Math.min(toRead, 1_000_000);
          const b = Buffer.alloc(maxRead);
          const n = readSync(fh, b, 0, maxRead, this.offset);
          content = b.toString('utf8', 0, n);
          this.offset += n;
        }
      } finally {
        closeSync(fh);
      }
    } catch {
      return { events: [], state: this.parser.state };
    }
    this.buf += content;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? ''; // l'ultima riga può essere ancora in scrittura
    const events: TranscriptEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const ev of this.parser.consumeLine(line)) events.push(ev);
    }
    return { events, state: this.parser.state };
  }
}
