import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { Session, SessionStatus } from '../types.js';
import type { SessionManager } from './manager.js';
import {
  TranscriptTail,
  resolveTranscriptDir,
  newestTranscriptFile,
  findTranscriptFile,
  transcriptSessionId,
  peekTranscriptState,
  type TranscriptEvent,
} from './transcript.js';

export interface TranscriptWatcherDeps {
  config: Config;
  manager: SessionManager;
  bus: Bus;
}

// Per ogni sessione terminale tracciata risolve il transcript del CLI
// (`~/.claude/projects/<progetto>/<sessione>.jsonl`), ne fa tail e re-emette i
// messaggi assistant/user come chat sul bus — lo stesso percorso usato dalle
// sessioni headless. Lo stato della sessione (working / in attesa dell'umano)
// viene dedotto dal transcript e scritto sul manager.
//
// Niente filtro sul modello: le sessioni terminali arrivano qui SOLO dal
// TmuxWatcher (nome `claude:*` + comando non-shell), quindi sono già "nostre" —
// lanciate con `ollama launch claude`. Il nome del modello nel transcript non
// distingue una sessione Ollama da una Anthropic-hosted (un modello `claude-*`
// può essere servito dal proxy Ollama locale) e un filtro lì scarterebbe
// proprio le sessioni più comuni.
export class TranscriptWatcher {
  private timer?: NodeJS.Timeout;
  private tails = new Map<string, TranscriptTail>();

  constructor(private deps: TranscriptWatcherDeps) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.config.pollIntervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    if (!this.deps.manager.isArmed()) return;
    for (const s of this.deps.manager.list()) {
      if (s.kind !== 'terminal') continue;
      try {
        this.pollSession(s);
      } catch { /* una sessione non deve far cadere le altre */ }
    }
  }

  private pollSession(s: Session): void {
    const { config, manager } = this.deps;
    let file = s.transcriptFile;

    // Il path registrato è sparito: il CLI può aver spostato la sessione (es. in
    // un git worktree) e il transcript ora vive in un'altra dir di projectsDir.
    // Lo cerchiamo per basename prima di ripiegare sul "più recente" della dir
    // registrata, che potrebbe appartenere a un'ALTRA sessione.
    if (file && !existsSync(file)) {
      const relocated = findTranscriptFile(config.projectsDir, basename(file));
      if (relocated) {
        file = relocated;
        manager.setTranscriptFile(s.id, file);
        manager.persist();
      } else {
        file = undefined; // non è da nessuna parte → fallback sotto
      }
    }

    // Binding stale: il tmux-watcher ha aggiornato projectDir al worktree (cwd
    // del processo claude) ma il binding è ancora nella dir precedente — la
    // sessione si è spostata e il transcript va ri-scoperto nella dir nuova.
    // Il flag `.claude/worktrees` evita di scartare il binding quando più
    // sessioni condividono legittimamente la stessa dir di progetto.
    const resolvedDir = resolveTranscriptDir(config.projectsDir, s.projectDir);
    if (file && existsSync(file) && resolvedDir && dirname(file) !== resolvedDir && s.projectDir.includes('.claude/worktrees')) {
      manager.setTranscriptFile(s.id, undefined);
      file = undefined;
    }

    if (!file || !existsSync(file)) {
      // Nessun transcript (ancora): il più recente nella dir del project registrato.
      const dir = resolveTranscriptDir(config.projectsDir, s.projectDir);
      const newest = dir ? newestTranscriptFile(dir) : undefined;
      if (!newest) return; // niente transcript → sessione screen-only (via /view)
      // una sessione ancora senza transcript non deve adottare quello di una
      // sessione PRECEDENTE: aspetta il file suo, che è più recente della
      // creazione della sessione (altrimenti mostrerebbe storia/status altrui).
      if (!file && s.createdAt) {
        const after = Date.parse(s.createdAt);
        if (!Number.isNaN(after)) {
          try {
            if (statSync(newest).mtimeMs < after) return;
          } catch {
            return;
          }
        }
      }
      // Guardia anti-adozione sbagliata: se la sessione AVEVA un transcript che è
      // sparito (e non è stato ritrovato altrove), il "più recente" qui può essere
      // di un'altra istanza → confronta l'id prima di adottarlo.
      const expectedId = s.claudeSessionId ?? (s.transcriptFile ? basename(s.transcriptFile).replace(/\.jsonl$/, '') : undefined);
      if (expectedId) {
        const nid = transcriptSessionId(newest);
        if (nid && nid !== expectedId) return;
      }
      file = newest;
      manager.setTranscriptFile(s.id, file);
      manager.persist(); // il binding sopravvive al riavvio del daemon
    } else {
      // Transcript valido: se nella SUA dir è comparso un file più recente (nuova
      // sessione nello stesso progetto) lo seguiamo — rotazione storica, senza
      // guardia: il vecchio file esiste ancora, quindi non è l'adozione sbagliata.
      const newest = newestTranscriptFile(dirname(file));
      if (newest && newest !== file) {
        file = newest;
        manager.setTranscriptFile(s.id, file);
        manager.persist();
      }
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
