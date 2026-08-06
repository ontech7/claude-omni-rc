import 'dotenv/config';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { StateStore } from './state.js';
import { Bus } from './bus.js';
import { SessionManager } from './sessions/manager.js';
import { PermissionFlow } from './permissions.js';
import { OllamaClient } from './ollama.js';
import { SdkDriver } from './sessions/sdk-driver.js';
import { TmuxWatcher } from './sessions/tmux-watcher.js';
import { TranscriptWatcher } from './sessions/transcript-watcher.js';
import { TmuxClient } from './sessions/tmux-inject.js';
import { Inbox } from './input.js';
import { startApi } from './api.js';
import { TelegramBot } from '../bot/telegram.js';

export interface Daemon { start(): Promise<void>; stop(): Promise<void>; }

export function createDaemon(
  config: Config,
  overrides: { bot?: Pick<TelegramBot, 'start' | 'stop'> } = {},
): Daemon {
  const state = new StateStore(join(config.stateDir, 'state.json'));
  const bus = new Bus();
  const manager = new SessionManager({ bus, state, idleGraceMs: config.idleGraceMs, armedOnStart: config.armedOnStart });
  const permissionFlow = new PermissionFlow({
    bus, config,
    setStatus: (id, s) => manager.setStatus(id, s),
  });
  const ollama = new OllamaClient({ baseUrl: config.ollamaBaseUrl });
  const sdk = new SdkDriver({ bus, manager, config, permissionFlow, ollama });
  const tmux = new TmuxClient();
  const watcher = new TmuxWatcher({ config, manager, tmux });
  const transcriptWatcher = new TranscriptWatcher({ config, manager, bus });
  const inbox = new Inbox({ dir: config.inboxDir });
  const bot = overrides.bot ?? new TelegramBot({ config, bus, manager, permissionFlow, sdk, tmux, inbox, ollama });

  const reaper = setInterval(() => manager.reapIdle(), 1000);
  reaper.unref();
  const api = startApi(config.apiPort, { manager, permissionFlow, config });

  return {
    async start() {
      // Prima sincronizzazione dei terminali PRIMA che il transcript-watcher
      // parta: projectDir viene risolto dal cwd del processo claude (worktree
      // incluso), così i transcript non vengono adottati nella dir precedente.
      await watcher.poll();
      watcher.start(); // gated su armed
      transcriptWatcher.start();
      await bot.start();
    },
    async stop() {
      clearInterval(reaper);
      watcher.stop();
      transcriptWatcher.stop();
      await api.close();
      await bot.stop();
      manager.persist();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // rete di sicurezza: anche un fire-and-forget sfuggito non deve uccidere il daemon.
  process.on('unhandledRejection', err => { console.error('claude-omni-rc unhandledRejection:', err); });
  const daemon = createDaemon(loadConfig());
  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  daemon.start().catch(err => { console.error('daemon start failed:', err); process.exit(1); });
}
