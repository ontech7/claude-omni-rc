import { randomUUID } from 'node:crypto';
import type { Bus } from '../bus.js';
import type { StateStore, StateFile } from '../state.js';
import type { Session, SessionKind, SessionStatus } from '../types.js';

export interface ManagerDeps {
  bus: Bus;
  state: StateStore;
  idleGraceMs: number;
  armedOnStart: boolean;
}

export class SessionManager {
  private state: StateFile;

  constructor(private deps: ManagerDeps) {
    const { state, existed } = deps.state.load();
    if (!existed && deps.armedOnStart) state.armed = true;
    this.state = state;
  }

  getState(): StateFile { return this.state; }
  persist(): void { this.deps.state.save(this.state); }
  getActive(): string | undefined { return this.state.activeSessionId; }
  setActive(id: string | undefined): void {
    if (this.state.activeSessionId === id) return;
    this.state.activeSessionId = id;
    this.persist();
  }

  list(): Session[] {
    return [...this.state.sessions].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  }
  get(id: string): Session | undefined { return this.state.sessions.find(s => s.id === id); }
  findByProjectDir(dir: string): Session | undefined { return this.state.sessions.find(s => s.projectDir === dir); }
  findByTmuxTarget(target: string): Session | undefined { return this.state.sessions.find(s => s.tmuxTarget === target); }

  private makeSession(kind: SessionKind, title: string, projectDir: string): Session {
    const now = new Date().toISOString();
    return { id: randomUUID(), kind, title, projectDir, status: 'idle', lastActivity: now, createdAt: now };
  }

  createHeadless(input: { title: string; projectDir: string; model?: string; permissionMode?: 'auto' | 'standard' }): Session {
    const s = this.makeSession('headless', input.title, input.projectDir);
    if (input.model) s.model = input.model;
    s.permissionMode = input.permissionMode ?? 'auto';
    this.state.sessions.push(s);
    this.emitUpdated(s.id);
    return s;
  }

  registerTerminal(input: { title: string; projectDir: string; tmuxTarget?: string }): Session {
    // dedupe: per target tmux se presente, altrimenti per project dir
    const existing = input.tmuxTarget
      ? this.findByTmuxTarget(input.tmuxTarget)
      : this.findByProjectDir(input.projectDir);
    if (existing) return existing;
    const s = this.makeSession('terminal', input.title, input.projectDir);
    if (input.tmuxTarget) s.tmuxTarget = input.tmuxTarget;
    this.state.sessions.push(s);
    this.emitUpdated(s.id);
    return s;
  }

  setStatus(id: string, status: SessionStatus): void {
    const s = this.get(id);
    if (!s || s.status === status) return;
    s.status = status;
    this.emitUpdated(id);
  }

  remove(id: string): boolean {
    const i = this.state.sessions.findIndex(s => s.id === id);
    if (i === -1) return false;
    this.state.sessions.splice(i, 1);
    if (this.state.activeSessionId === id) this.state.activeSessionId = undefined;
    this.emitUpdated(id);
    return true;
  }

  setClaudeSessionId(id: string, claudeSessionId: string): void {
    const s = this.get(id);
    if (!s) return;
    if (s.claudeSessionId !== claudeSessionId) { s.claudeSessionId = claudeSessionId; this.emitUpdated(id); }
  }

  setTranscriptFile(id: string, transcriptFile: string | undefined): void {
    const s = this.get(id);
    if (!s) return;
    if (s.transcriptFile !== transcriptFile) { s.transcriptFile = transcriptFile; this.emitUpdated(id); }
  }

  setProjectDir(id: string, projectDir: string): void {
    const s = this.get(id);
    if (!s) return;
    if (s.projectDir !== projectDir) { s.projectDir = projectDir; this.emitUpdated(id); }
  }

  touch(id: string): void {
    const s = this.get(id);
    if (s) s.lastActivity = new Date().toISOString();
  }

  isArmed(): boolean { return this.state.armed; }
  setArmed(armed: boolean): void { this.state.armed = armed; }

  addAuthorizedUser(id: number): void {
    if (!this.state.authorizedUserIds.includes(id)) this.state.authorizedUserIds.push(id);
  }
  isAuthorizedUser(id: number): boolean { return this.state.authorizedUserIds.includes(id); }

  isIdle(id: string): boolean {
    const s = this.get(id);
    if (!s) return false;
    if (s.status === 'waiting-permission') return false;
    return Date.now() - new Date(s.lastActivity).getTime() >= this.deps.idleGraceMs;
  }

  reapIdle(): void {
    const now = Date.now();
    for (const s of this.state.sessions) {
      // headless: il busy-guard del driver protegge la concorrenza e un turno può
      // restare in tool-execution/think > idleGraceMs senza touch → mai reaping,
      // altrimenti /status mentirebbe e il cap maxHeadlessSessions (spec §8) perderebbe.
      if (s.kind === 'headless') continue;
      // terminali con transcript: lo stato è gestito dal TranscriptWatcher
      // (running / awaiting-input) in base al flusso reale dei messaggi.
      if (s.transcriptFile) continue;
      if (s.status === 'running' && now - new Date(s.lastActivity).getTime() >= this.deps.idleGraceMs) {
        s.status = 'idle';
        this.emitUpdated(s.id);
      }
    }
  }

  private emitUpdated(sessionId: string): void {
    this.deps.bus.emit({ type: 'session.updated', sessionId });
  }
}
