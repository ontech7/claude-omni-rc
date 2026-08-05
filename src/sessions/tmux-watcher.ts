import type { Config } from '../config.js';
import type { SessionManager } from './manager.js';
import type { TmuxClient } from './tmux-inject.js';

export interface WatcherDeps {
  config: Config;
  manager: SessionManager;
  tmux: Pick<TmuxClient, 'listSessions' | 'serverRunning' | 'paneCwd'>;
}

// Grace prima di rimuovere una sessione terminale il cui target tmux è sparito:
// /attach può registrare un target non ancora avviato, e un restart di tmux non
// deve cancellare tutto. Oltre questo tempo la sessione è da considerare morta.
const PRUNE_GRACE_MS = 30_000;

// Scoperta sessioni terminale: `tmux list-sessions` → sessioni `claude:<progetto>`,
// registrate col cwd reale del pane (serve a risolvere il transcript). Solo
// sessioni tmux esplicite vengono registrate: niente scansione di
// ~/.claude/projects, quindi niente sessioni estranee (es. Claude Code non-Ollama)
// nel registro. Attivo solo quando il remote control è armed.
export class TmuxWatcher {
  private timer?: NodeJS.Timeout;
  private missingSince = new Map<string, number>();

  constructor(private deps: WatcherDeps) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.config.pollIntervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    if (!this.deps.manager.isArmed()) return;
    let sessions: string[];
    try {
      if (!(await this.deps.tmux.serverRunning())) return;
      sessions = await this.deps.tmux.listSessions();
    } catch { return; }
    this.prune(sessions);
    for (const target of sessions) {
      if (!target.startsWith('claude:')) continue;
      if (this.deps.manager.findByTmuxTarget(target)) continue;
      const name = target.slice('claude:'.length);
      let projectDir = `~/${name}`;
      try {
        projectDir = (await this.deps.tmux.paneCwd(target)) || projectDir;
      } catch { /* tmux in mezzo a un restart: fallback al project dir di default */ }
      this.deps.manager.registerTerminal({ title: name, projectDir, tmuxTarget: target });
      this.deps.manager.persist();
    }
  }

  private prune(sessions: string[]): void {
    const alive = new Set(sessions);
    const now = Date.now();
    for (const s of this.deps.manager.list()) {
      if (s.kind !== 'terminal' || !s.tmuxTarget) continue;
      if (alive.has(s.tmuxTarget)) {
        this.missingSince.delete(s.tmuxTarget);
        continue;
      }
      const since = this.missingSince.get(s.tmuxTarget) ?? now;
      this.missingSince.set(s.tmuxTarget, since);
      if (now - since < PRUNE_GRACE_MS) continue;
      this.deps.manager.remove(s.id);
      this.deps.manager.persist();
    }
  }
}
