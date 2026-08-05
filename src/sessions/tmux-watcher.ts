import type { Config } from '../config.js';
import type { SessionManager } from './manager.js';
import type { TmuxClient } from './tmux-inject.js';

export interface WatcherDeps {
  config: Config;
  manager: SessionManager;
  tmux: Pick<TmuxClient, 'listSessions'>;
}

// Scoperta sessioni terminale: `tmux list-sessions` → sessioni `claude:<progetto>`.
// Solo sessioni tmux esplicite vengono registrate: niente scansione di
// ~/.claude/projects, quindi niente sessioni estranee (es. Claude Code non-Ollama)
// nel registro. Attivo solo quando il remote control è armed.
export class TmuxWatcher {
  private timer?: NodeJS.Timeout;

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
    try {
      const sessions = await this.deps.tmux.listSessions();
      for (const target of sessions) {
        if (!target.startsWith('claude:')) continue;
        if (this.deps.manager.findByTmuxTarget(target)) continue;
        const name = target.slice('claude:'.length);
        this.deps.manager.registerTerminal({ title: name, projectDir: `~/${name}`, tmuxTarget: target });
      }
    } catch { /* tmux non attivo */ }
  }
}
