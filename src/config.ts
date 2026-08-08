import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  pairingCode?: string;
  ollamaBaseUrl: string;
  defaultModel: string;
  // Modo permessi delle sessioni headless quando /new non specifica un flag.
  // Default 'standard' (ogni tool passa dai bottoni): 'auto' significa un agente
  // non presidiato con accesso a Bash sulla macchina — va scelto, non subìto.
  defaultPermissionMode: 'auto' | 'standard';
  maxHeadlessSessions: number;
  permissionTimeoutSeconds: number;
  workspaceDirs: string[];
  stateDir: string;
  inboxDir: string;
  projectsDir: string;
  apiPort: number;
  armedOnStart: boolean;
  idleGraceMs: number;
  pollIntervalMs: number;
  // Ogni quanto ricontrollare il cwd del processo claude di una sessione già
  // tracciata. Costa `ps` + `lsof`, quindi non va fatto a ogni poll: serve solo
  // a seguire una sessione che si sposta in un git worktree.
  cwdRefreshMs: number;
  // Disabilita il check periodico di nuove versioni su GitHub (vedi src/update.ts).
  noUpdateCheck: boolean;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function parseNum(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = expandHome(env.STATE_DIR ?? '~/.claude-omni-rc');
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? '',
    allowedUserIds: (env.ALLOWED_USER_IDS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean).map(Number),
    pairingCode: env.PAIRING_CODE || undefined,
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    defaultModel: env.DEFAULT_MODEL ?? 'deepseek-v4-flash:cloud',
    defaultPermissionMode: env.DEFAULT_PERMISSION_MODE === 'auto' ? 'auto' : 'standard',
    maxHeadlessSessions: parseNum(env, 'MAX_HEADLESS_SESSIONS', 2),
    permissionTimeoutSeconds: parseNum(env, 'PERMISSION_TIMEOUT_SECONDS', 120),
    workspaceDirs: (env.WORKSPACE_DIRS ?? '').split(':').map(s => expandHome(s.trim())).filter(Boolean),
    stateDir,
    inboxDir: env.INBOX_DIR ?? join(stateDir, 'inbox'),
    projectsDir: expandHome(env.PROJECTS_DIR ?? '~/.claude/projects'),
    apiPort: parseNum(env, 'API_PORT', 4123),
    armedOnStart: env.ARMED_ON_START === 'true',
    idleGraceMs: parseNum(env, 'IDLE_GRACE_MS', 3000),
    pollIntervalMs: parseNum(env, 'POLL_INTERVAL_MS', 500),
    cwdRefreshMs: parseNum(env, 'CWD_REFRESH_MS', 10_000),
    noUpdateCheck: Boolean(env.CLAUDE_OMNI_RC_NO_UPDATE_CHECK),
  };
}
