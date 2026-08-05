import { existsSync } from 'node:fs';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { Session, SessionStatus } from '../types.js';
import type { SessionManager } from './manager.js';
import {
  TranscriptTail,
  resolveTranscriptDir,
  newestTranscriptFile,
  peekTranscriptState,
  transcriptModel,
  type TranscriptEvent,
} from './transcript.js';

export interface TranscriptWatcherDeps {
  config: Config;
  manager: SessionManager;
  bus: Bus;
  // modelli locali noti (da `ollama list`), per non fare streaming di sessioni
  // non-Ollama. Set vuoto = non verificabile → streaming comunque.
  ollamaModels: () => Promise<Set<string>>;
}

const MODEL_CACHE_MS = 5 * 60_000;

// Per ogni sessione terminale tracciata risolve il transcript del CLI
// (`~/.claude/projects/<progetto>/<sessione>.jsonl`), ne fa tail e re-emette i
// messaggi assistant/user come chat sul bus — lo stesso percorso usato dalle
// sessioni headless. Lo stato della sessione (working / in attesa dell'umano)
// viene dedotto dal transcript e scritto sul manager.
export class TranscriptWatcher {
  private timer?: NodeJS.Timeout;
  private tails = new Map<string, TranscriptTail>();
  private modelCache?: Set<string>;
  private modelCacheAt = 0;

  constructor(private deps: TranscriptWatcherDeps) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.config.pollIntervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async knownModels(): Promise<Set<string>> {
    const now = Date.now();
    if (this.modelCache && now - this.modelCacheAt < MODEL_CACHE_MS) return this.modelCache;
    try {
      const models = await this.deps.ollamaModels();
      this.modelCache = models;
      this.modelCacheAt = now;
      return models;
    } catch {
      return this.modelCache ?? new Set();
    }
  }

  private isOllamaModel(model: string | undefined, known: Set<string>): boolean {
    if (!model) return true; // non verificabile → stream
    if (known.size === 0) return true; // ollama irraggiungibile → stream
    if (known.has(model)) return true;
    return !model.startsWith('claude-'); // i modelli Anthropic-hosted non lo sono
  }

  async poll(): Promise<void> {
    if (!this.deps.manager.isArmed()) return;
    const known = await this.knownModels();
    for (const s of this.deps.manager.list()) {
      if (s.kind !== 'terminal') continue;
      try {
        this.pollSession(s, known);
      } catch { /* una sessione non deve far cadere le altre */ }
    }
  }

  private pollSession(s: Session, known: Set<string>): void {
    const { config, manager } = this.deps;
    const dir = resolveTranscriptDir(config.projectsDir, s.projectDir);
    const newest = dir ? newestTranscriptFile(dir) : undefined;
    let file = s.transcriptFile;
    // il transcript può ruotare (nuova sessione nello stesso progetto) o sparire:
    // se quello registrato non è più il più recente, ri-risolviamo.
    if (!file || !existsSync(file) || (newest && newest !== file)) {
      if (!newest) return; // niente transcript → sessione screen-only (via /view)
      if (!this.isOllamaModel(transcriptModel(newest), known)) return; // non-Ollama
      file = newest;
      manager.setTranscriptFile(s.id, file);
    }
    let tail = this.tails.get(s.id);
    if (!tail || tail.file !== file) {
      tail = new TranscriptTail(file);
      this.tails.set(s.id, tail);
      // stato iniziale dall'ultima riga già scritta (nessun replay della storia)
      this.applyState(s, peekTranscriptState(file));
      return;
    }
    if (!tail.hasChanges()) {
      this.applyState(s, tail.parser.state);
      return;
    }
    const { events, state } = tail.poll();
    for (const ev of events) this.emit(s, ev);
    this.applyState(s, state);
  }

  private emit(s: Session, ev: TranscriptEvent): void {
    const { bus, manager } = this.deps;
    if (ev.type === 'prompt') {
      manager.touch(s.id);
      manager.setStatus(s.id, 'awaiting-input');
      bus.emit({ type: 'session.prompt', sessionId: s.id, questions: ev.questions });
      return;
    }
    if (ev.type === 'error') {
      manager.touch(s.id);
      bus.emit({ type: 'session.error', sessionId: s.id, message: ev.message });
      return;
    }
    if (ev.type === 'text') {
      manager.touch(s.id);
      bus.emit({ type: 'session.text', sessionId: s.id, role: ev.role, text: ev.text });
    } else if (ev.kind === 'tool_use') {
      manager.touch(s.id);
      manager.setStatus(s.id, 'running');
      bus.emit({
        type: 'session.tool', sessionId: s.id, toolName: ev.name, kind: 'tool_use',
        toolUseId: ev.id, input: (ev.input ?? {}) as Record<string, unknown>,
      });
    } else {
      manager.touch(s.id);
      manager.setStatus(s.id, 'running');
      bus.emit({
        type: 'session.tool', sessionId: s.id, toolName: ev.name, kind: 'tool_result',
        toolUseId: ev.id, result: ev.result, isError: ev.isError,
      });
    }
  }

  private applyState(s: Session, state: string): void {
    const status: SessionStatus = state === 'awaiting' ? 'awaiting-input' : state === 'working' ? 'running' : s.status;
    if (status !== s.status) this.deps.manager.setStatus(s.id, status);
  }
}
