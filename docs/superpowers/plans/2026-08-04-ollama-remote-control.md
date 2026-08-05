# Ollama Remote Control (ollama-rc) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 1 MVP of ollama-rc: a local daemon that drives Claude Code headless sessions (and mirrors terminal sessions) over Ollama, controlled remotely from a single Telegram chat — including the remote permission-approval flow.

**Architecture:** A Node 22 + TypeScript daemon (run with `tsx`) that owns a session registry persisted to `~/.ollama-rc/state.json`. Headless sessions are driven via the Claude Agent SDK (`query()` + `resume`, `canUseTool` bridging to a remote approval flow); terminal sessions are mirrored read-only by tailing `~/.claude/projects/*/*.jsonl` and injected into via tmux. A grammy Telegram bot (long-polling, outbound-only) is the only UI: commands, inline keyboards, throttled `edit_message` progress. An internal typed event bus decouples sessions → bot. A global `armed` switch gates all mirroring/injection/relay.

**Tech Stack:** Node 22, TypeScript, `tsx`, vitest, `@anthropic-ai/claude-agent-sdk@0.3.221`, grammy, dotenv.

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-08-04-ollama-remote-control-design.md`) — every task implicitly includes these:

1. **Runtime**: Node 22, TypeScript, eseguito con `tsx`.
2. **Niente infrastruttura Anthropic**: solo harness locale + Ollama (`ANTHROPIC_BASE_URL` → Ollama, token fittizio `ollama`).
3. **SDK congelato**: `@anthropic-ai/claude-agent-sdk` **0.3.221** (validato da spike, 04/08/2026).
4. **Bot Telegram**: long-polling in uscita (nessuna porta in ingresso), **chat unica + switcher** di sessione.
5. **Niente streaming token-by-token**: progresso a milestone + `edit_message` throttlato (~1/s).
6. **Vision check via `/api/show`**: mai inoltrare blocchi immagine a modelli text-only.
7. **Concorrenza limitata**: default **2** sessioni headless attive (`MAX_HEADLESS_SESSIONS`).
8. **Interruttore globale `armed`**: persistito in `~/.ollama-rc/state.json`, default `false`. Da disattivo: **nessun mirroring, nessuna iniezione, nessun relay** — il bot risponde solo ai comandi di controllo (`/rc`, `/help` e `/start` per il pairing, necessario anche da disattivo). Il daemon gira sempre (launchd) ma inerte finché non armato.
9. **Registry sessioni** persistito in `~/.ollama-rc/state.json`.
10. **Modello default**: `deepseek-v4-flash:0731-cloud` (`DEFAULT_MODEL`).
11. **Whisper** (Ollama): modello configurabile, default `whisper-large-v3`; endpoint nativo `/api/transcribe` con fallback `/v1/audio/transcriptions` (OpenAI-compat), multipart `file`+`model`.
12. **Timeout permessi**: `PERMISSION_TIMEOUT_SECONDS` default **120** → deny.
13. **Convenzione sessioni terminale**: `tmux new -s claude:<progetto>`.
14. **Permessi SDK**: `canUseTool` copre le decisioni "ask"; le tool coperte da allowlist (es. `~/.claude/settings.json`) **non** generano notifiche. `{ behavior: 'allow' }` esegue; `{ behavior: 'deny', message }` blocca (`is_error=true`) e il modello viene informato.
15. **Segreti** in `.env`, mai committati.
16. **Mirror JSONL**: read-only, mai scrivere nei JSONL; offset persistiti per file per la ripartenza.

### Prerequisiti ambiente (verificati 2026-08-04)

- **tmux NON installato** → `brew install tmux` prima dell'E2E (i test lo mockano).
- **ffmpeg** richiesto per la voce → `brew install ffmpeg`.
- Ollama attivo con `kimi-k3:cloud`; `deepseek-v4-flash:0731-cloud` (default) e `whisper-large-v3` da pullare quando servono (`ollama pull <name>`).

---

### Task 1: Scaffold + Config

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` and the `Config` interface (all fields below). Every later task imports `Config` from `../config.js`.

- [ ] **Step 1: Write `package.json`, `tsconfig.json`, `vitest.config.ts`**

`package.json`:
```json
{
  "name": "ollama-rc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx src/daemon.ts",
    "start": "tsx src/daemon.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.221",
    "dotenv": "^16.4.5",
    "grammy": "^1.30.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json` (bundler resolution → importi relativi senza estensione; runtime è `tsx`, non `tsc`):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "bot", "test"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

- [ ] **Step 2: Run install to verify the scaffold resolves**

Run: `npm install`
Expected: lockfile created; `npm ls @anthropic-ai/claude-agent-sdk` shows exactly `0.3.221`.

- [ ] **Step 3: Write the failing test**

`test/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies spec defaults', () => {
    const c = loadConfig({});
    expect(c.telegramBotToken).toBe('');
    expect(c.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(c.defaultModel).toBe('deepseek-v4-flash:0731-cloud');
    expect(c.whisperModel).toBe('whisper-large-v3');
    expect(c.maxHeadlessSessions).toBe(2);
    expect(c.permissionTimeoutSeconds).toBe(120);
    expect(c.armedOnStart).toBe(false);
    expect(c.stateDir).toBe(`${process.env.HOME}/.ollama-rc`);
    expect(c.inboxDir).toBe(`${process.env.HOME}/.ollama-rc/inbox`);
  });
  it('parses overrides', () => {
    const c = loadConfig({
      TELEGRAM_BOT_TOKEN: 'abc',
      ALLOWED_USER_IDS: '111, 222',
      PAIRING_CODE: 'secret',
      MAX_HEADLESS_SESSIONS: '5',
      PERMISSION_TIMEOUT_SECONDS: '30',
      ARMED_ON_START: 'true',
      WORKSPACE_DIRS: '~/proj1:/tmp/proj2',
    });
    expect(c.allowedUserIds).toEqual([111, 222]);
    expect(c.pairingCode).toBe('secret');
    expect(c.maxHeadlessSessions).toBe(5);
    expect(c.permissionTimeoutSeconds).toBe(30);
    expect(c.armedOnStart).toBe(true);
    expect(c.workspaceDirs).toEqual([`${process.env.HOME}/proj1`, '/tmp/proj2']);
  });
  it('falls back on malformed numbers', () => {
    expect(loadConfig({ MAX_HEADLESS_SESSIONS: 'nope' }).maxHeadlessSessions).toBe(2);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `src/config.ts` missing / no `loadConfig` export.

- [ ] **Step 5: Write minimal implementation**

`src/config.ts`:
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Config {
  telegramBotToken: string;
  allowedUserIds: number[];
  pairingCode?: string;
  ollamaBaseUrl: string;
  defaultModel: string;
  whisperModel: string;
  maxHeadlessSessions: number;
  permissionTimeoutSeconds: number;
  workspaceDirs: string[];
  stateDir: string;
  inboxDir: string;
  projectsDir: string;
  armedOnStart: boolean;
  idleGraceMs: number;
  pollIntervalMs: number;
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
  const stateDir = expandHome(env.STATE_DIR ?? '~/.ollama-rc');
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? '',
    allowedUserIds: (env.ALLOWED_USER_IDS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean).map(Number),
    pairingCode: env.PAIRING_CODE || undefined,
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    defaultModel: env.DEFAULT_MODEL ?? 'deepseek-v4-flash:0731-cloud',
    whisperModel: env.WHISPER_MODEL ?? 'whisper-large-v3',
    maxHeadlessSessions: parseNum(env, 'MAX_HEADLESS_SESSIONS', 2),
    permissionTimeoutSeconds: parseNum(env, 'PERMISSION_TIMEOUT_SECONDS', 120),
    workspaceDirs: (env.WORKSPACE_DIRS ?? '').split(':').map(s => expandHome(s.trim())).filter(Boolean),
    stateDir,
    inboxDir: env.INBOX_DIR ?? join(stateDir, 'inbox'),
    projectsDir: expandHome(env.PROJECTS_DIR ?? '~/.claude/projects'),
    armedOnStart: env.ARMED_ON_START === 'true',
    idleGraceMs: parseNum(env, 'IDLE_GRACE_MS', 3000),
    pollIntervalMs: parseNum(env, 'POLL_INTERVAL_MS', 500),
  };
}
```

Note: `IDLE_GRACE_MS` and `POLL_INTERVAL_MS` are implementation tuning constants (not in the spec's env list); the rest maps 1:1 to spec §11.

`.env.example`:
```
# Telegram (BotFather → https://t.me/BotFather)
TELEGRAM_BOT_TOKEN=
# Numeri id Telegram autorizzati, separati da virgola (vuoto = pairing via PAIRING_CODE)
ALLOWED_USER_IDS=
# Codice di pairing per il primo /start (default-deny se assenti entrambi)
PAIRING_CODE=
# Ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
DEFAULT_MODEL=deepseek-v4-flash:0731-cloud
WHISPER_MODEL=whisper-large-v3
# Limiti
MAX_HEADLESS_SESSIONS=2
PERMISSION_TIMEOUT_SECONDS=120
WORKSPACE_DIRS=
# Stato e attivazione
STATE_DIR=~/.ollama-rc
ARMED_ON_START=false
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example src/config.ts test/config.test.ts
git commit -m "chore: scaffold project and config module"
```

---

### Task 2: Types + Event Bus

**Files:**
- Create: `src/types.ts`
- Create: `src/bus.ts`
- Test: `test/bus.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (self-contained types).
- Produces: `Session`, `SessionKind`, `SessionStatus`, `PermissionRequest`, `BusEvent` (all from `types.js`) and `Bus` (from `bus.js`) with `on(type, handler) => unsubscribe()` and `emit(event)`. Used by **every** subsequent task.

- [ ] **Step 1: Write the failing test**

`test/bus.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { Bus } from '../src/bus.js';

describe('Bus', () => {
  it('delivers matching events and supports unsubscribe', () => {
    const bus = new Bus();
    const a = vi.fn();
    const b = vi.fn();
    const off = bus.on('session.text', a);
    bus.on('session.text', b);
    bus.emit({ type: 'session.text', sessionId: 's1', role: 'assistant', text: 'ciao' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    off();
    bus.emit({ type: 'session.text', sessionId: 's1', role: 'assistant', text: 'x' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
  it('does not deliver to handlers of other types', () => {
    const bus = new Bus();
    const h = vi.fn();
    bus.on('session.permission', h);
    bus.emit({ type: 'session.error', sessionId: 's1', message: 'boom' });
    expect(h).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/bus.test.ts`
Expected: FAIL — module `bus` not found.

- [ ] **Step 3: Write minimal implementation**

`src/types.ts`:
```ts
export type SessionKind = 'headless' | 'terminal';
export type SessionStatus = 'idle' | 'running' | 'waiting-permission' | 'error' | 'stopped';

export interface Session {
  id: string;
  kind: SessionKind;
  title: string;
  projectDir: string;
  model?: string;
  status: SessionStatus;
  claudeSessionId?: string;
  tmuxTarget?: string;
  lastActivity: string; // ISO
  createdAt: string;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: string;
}

export type BusEvent =
  | { type: 'session.updated'; sessionId: string }
  | { type: 'session.text'; sessionId: string; role: 'user' | 'assistant'; text: string }
  | {
      type: 'session.tool';
      sessionId: string;
      toolName: string;
      kind: 'tool_use' | 'tool_result';
      toolUseId?: string;
      input?: Record<string, unknown>;
      result?: unknown;
      isError?: boolean;
    }
  | { type: 'session.permission'; permission: PermissionRequest }
  | { type: 'session.result'; sessionId: string; result: string; isError: boolean }
  | { type: 'session.error'; sessionId: string; message: string };
```

`src/bus.ts`:
```ts
import type { BusEvent } from './types.js';

type Handler<T extends BusEvent['type']> = (e: Extract<BusEvent, { type: T }>) => void;

export class Bus {
  private handlers = new Map<BusEvent['type'], Set<Handler<BusEvent['type']>>>();

  on<T extends BusEvent['type']>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    const anyHandler = handler as Handler<BusEvent['type']>;
    set.add(anyHandler);
    return () => { set.delete(anyHandler); };
  }

  emit(event: BusEvent): void {
    for (const h of this.handlers.get(event.type) ?? []) h(event);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/bus.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/types.ts src/bus.ts test/bus.test.ts
git commit -m "feat: add shared types and typed event bus"
```

---

### Task 3: State registry (persistenza)

**Files:**
- Create: `src/state.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Consumes: `Session` from `types.js`.
- Produces: `StateFile`, `emptyState()`, and `StateStore` with `load(): { state: StateFile; existed: boolean }` and `save(state: StateFile): void`. `existed` lets the manager apply `ARMED_ON_START` only on first run. Persists to `<stateDir>/state.json` (spec §4).

- [ ] **Step 1: Write the failing test**

`test/state.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, emptyState } from '../src/state.js';

function tmpState(): { store: StateStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orc-state-'));
  const path = join(dir, 'state.json');
  return { store: new StateStore(path), path };
}

describe('StateStore', () => {
  it('returns empty defaults for a missing file with existed=false', () => {
    const { store } = tmpState();
    const { state, existed } = store.load();
    expect(existed).toBe(false);
    expect(state).toEqual(emptyState());
  });
  it('returns defaults for corrupt json with existed=true', () => {
    const { store, path } = tmpState();
    writeFileSync(path, '{{{not json');
    const { state, existed } = store.load();
    expect(existed).toBe(true);
    expect(state.armed).toBe(false);
    expect(state.sessions).toEqual([]);
  });
  it('round-trips saved state', () => {
    const { store } = tmpState();
    const { state } = store.load();
    state.armed = true;
    store.save(state);
    const again = store.load();
    expect(again.existed).toBe(true);
    expect(again.state.armed).toBe(true);
    expect(existsSync((store as any).filePath)).toBe(true);
  });
  it('merges partial state onto defaults', () => {
    const { store, path } = tmpState();
    writeFileSync(path, JSON.stringify({ armed: true }));
    const { state } = store.load();
    expect(state.armed).toBe(true);
    expect(state.sessions).toEqual([]);
    expect(state.mirrorOffsets).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/state.test.ts`
Expected: FAIL — module `state` not found.

- [ ] **Step 3: Write minimal implementation**

`src/state.ts`:
```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session } from './types.js';

export interface StateFile {
  armed: boolean;
  authorizedUserIds: number[];
  sessions: Session[];
  mirrorOffsets: Record<string, number>;
}

export function emptyState(): StateFile {
  return { armed: false, authorizedUserIds: [], sessions: [], mirrorOffsets: {} };
}

export class StateStore {
  constructor(private filePath: string) {}

  load(): { state: StateFile; existed: boolean } {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<StateFile>;
      return {
        existed: true,
        state: {
          ...emptyState(),
          ...parsed,
          authorizedUserIds: parsed.authorizedUserIds ?? [],
          sessions: parsed.sessions ?? [],
          mirrorOffsets: parsed.mirrorOffsets ?? {},
        },
      };
    } catch {
      return { existed: false, state: emptyState() };
    }
  }

  save(state: StateFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/state.ts test/state.test.ts
git commit -m "feat: add persistent state registry"
```

---

### Task 4: Session manager

**Files:**
- Create: `src/sessions/manager.ts`
- Test: `test/manager.test.ts`

**Interfaces:**
- Consumes: `Bus` (`bus.js`), `StateStore` + `StateFile` (`state.js`), `Session`/`SessionStatus` (`types.js`).
- Produces: `SessionManager` with:
  - `list(): Session[]` (sorted by `lastActivity` desc), `get(id)`, `findByProjectDir(dir)`, `findByTmuxTarget(target)`
  - `createHeadless({ title, projectDir, model? }): Session`
  - `registerTerminal({ title, projectDir, tmuxTarget }): Session` (dedupe by `tmuxTarget`)
  - `setStatus(id, status)`, `setClaudeSessionId(id, claudeSessionId)`, `touch(id)`
  - `isArmed()`, `setArmed(armed)`, `addAuthorizedUser(id)`, `isAuthorizedUser(id)`
  - `isIdle(id): boolean`, `reapIdle(): void`
  - `getState(): StateFile`, `persist(): void`

- [ ] **Step 1: Write the failing test**

`test/manager.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';

function makeManager(armedOnStart = false, idleGraceMs = 3000): { manager: SessionManager; bus: Bus; onUpdated: ReturnType<typeof vi.fn> } {
  const bus = new Bus();
  const onUpdated = vi.fn();
  bus.on('session.updated', onUpdated);
  const state = new StateStore(join(mkdtempSync(join(tmpdir(), 'orc-mgr-')), 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs, armedOnStart });
  return { manager, bus, onUpdated };
}

describe('SessionManager', () => {
  it('creates headless sessions and emits session.updated', () => {
    const { manager, onUpdated } = makeManager();
    const s = manager.createHeadless({ title: 't', projectDir: '/tmp/x' });
    expect(s.kind).toBe('headless');
    expect(s.status).toBe('idle');
    expect(manager.get(s.id)).toBe(s);
    expect(onUpdated).toHaveBeenCalledWith({ type: 'session.updated', sessionId: s.id });
  });
  it('dedupes terminal registration by tmuxTarget', () => {
    const { manager } = makeManager();
    const a = manager.registerTerminal({ title: 'x', projectDir: '/tmp/x', tmuxTarget: 'claude:x' });
    const b = manager.registerTerminal({ title: 'x', projectDir: '/tmp/x', tmuxTarget: 'claude:x' });
    expect(b.id).toBe(a.id);
    expect(manager.list().filter(s => s.tmuxTarget === 'claude:x')).toHaveLength(1);
  });
  it('persists armed switch and applies ARMED_ON_START only on first run', () => {
    const { manager } = makeManager(true);
    expect(manager.isArmed()).toBe(true);
    manager.setArmed(false);
    manager.persist();
    const { manager: m2 } = makeManager(true);
    const loaded = m2.getState();
    expect(loaded.armed).toBe(false); // persisted false wins over armedOnStart
  });
  it('tracks authorized users', () => {
    const { manager } = makeManager();
    expect(manager.isAuthorizedUser(42)).toBe(false);
    manager.addAuthorizedUser(42);
    expect(manager.isAuthorizedUser(42)).toBe(true);
  });
  it('idle heuristic: recent activity blocks, grace elapses unblocks', () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeManager(false, 3000);
      const s = manager.registerTerminal({ title: 'x', projectDir: '/tmp/x', tmuxTarget: 'claude:x' });
      manager.touch(s.id);
      expect(manager.isIdle(s.id)).toBe(false);
      vi.advanceTimersByTime(4000);
      expect(manager.isIdle(s.id)).toBe(true);
      manager.setStatus(s.id, 'waiting-permission');
      expect(manager.isIdle(s.id)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('reapIdle flips stale running sessions back to idle', () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeManager();
      const s = manager.registerTerminal({ title: 'x', projectDir: '/tmp/x', tmuxTarget: 'claude:x' });
      manager.setStatus(s.id, 'running');
      vi.advanceTimersByTime(4000);
      manager.reapIdle();
      expect(manager.get(s.id)!.status).toBe('idle');
    } finally { vi.useRealTimers(); }
  });
  it('never reaps a running headless session (busy-guard owns concurrency)', () => {
    vi.useFakeTimers();
    try {
      const { manager } = makeManager();
      const s = manager.createHeadless({ title: 'h', projectDir: '/tmp/h' });
      manager.setStatus(s.id, 'running');
      vi.advanceTimersByTime(10_000);
      manager.reapIdle();
      expect(manager.get(s.id)!.status).toBe('running');
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/manager.test.ts`
Expected: FAIL — module `manager` not found.

- [ ] **Step 3: Write minimal implementation**

`src/sessions/manager.ts`:
```ts
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

  createHeadless(input: { title: string; projectDir: string; model?: string }): Session {
    const s = this.makeSession('headless', input.title, input.projectDir);
    if (input.model) s.model = input.model;
    this.state.sessions.push(s);
    this.emitUpdated(s.id);
    return s;
  }

  registerTerminal(input: { title: string; projectDir: string; tmuxTarget: string }): Session {
    const existing = this.findByTmuxTarget(input.tmuxTarget);
    if (existing) return existing;
    const s = this.makeSession('terminal', input.title, input.projectDir);
    s.tmuxTarget = input.tmuxTarget;
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

  setClaudeSessionId(id: string, claudeSessionId: string): void {
    const s = this.get(id);
    if (!s) return;
    if (s.claudeSessionId !== claudeSessionId) { s.claudeSessionId = claudeSessionId; this.emitUpdated(id); }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/manager.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/sessions/manager.ts test/manager.test.ts
git commit -m "feat: add session manager with registry and armed switch"
```

---

### Task 5: Permission flow

**Files:**
- Create: `src/permissions.ts`
- Test: `test/permissions.test.ts`

**Interfaces:**
- Consumes: `Bus` (`bus.js`), `Config` (`config.js`), `PermissionRequest` (`types.js`).
- Produces: `PermissionDecision`, `PermissionFlowDeps`, `PermissionFlow` with:
  - `request(sessionId, toolName, input, signal?): Promise<PermissionDecision>` — emits `session.permission`, resolves on approve/deny/timeout/abort
  - `approve(id): boolean`, `deny(id, message?): boolean`, `cancelAllForSession(sessionId): void`
  - `setStatus?: (sessionId, status) => void` in deps (wired to the manager in the daemon) flips `waiting-permission` ↔ `running`.

- [ ] **Step 1: Write the failing test**

`test/permissions.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { PermissionFlow } from '../src/permissions.js';

function makeFlow(timeoutSeconds = 120): { flow: PermissionFlow; bus: Bus; onPerm: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } {
  const bus = new Bus();
  const onPerm = vi.fn();
  bus.on('session.permission', onPerm);
  const setStatus = vi.fn();
  const config = loadConfig({ PERMISSION_TIMEOUT_SECONDS: String(timeoutSeconds) });
  const flow = new PermissionFlow({ bus, config, setStatus });
  return { flow, bus, onPerm, setStatus };
}

describe('PermissionFlow', () => {
  it('emits a permission request and resolves on approve', async () => {
    const { flow, onPerm, setStatus } = makeFlow();
    const p = flow.request('s1', 'Bash', { command: 'ls' });
    expect(onPerm).toHaveBeenCalledTimes(1);
    const req = onPerm.mock.calls[0][0].permission;
    expect(req.sessionId).toBe('s1');
    expect(req.toolName).toBe('Bash');
    expect(setStatus).toHaveBeenCalledWith('s1', 'waiting-permission');
    expect(flow.approve(req.id)).toBe(true);
    await expect(p).resolves.toEqual({ behavior: 'allow' });
    expect(setStatus).toHaveBeenLastCalledWith('s1', 'running');
  });
  it('denies and reports why', async () => {
    const { flow, onPerm } = makeFlow();
    const p = flow.request('s1', 'Bash', { command: 'rm -rf /' });
    const req = onPerm.mock.calls[0][0].permission;
    expect(flow.deny(req.id, 'no')).toBe(true);
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'no' });
    expect(flow.deny(req.id)).toBe(false); // already resolved
  });
  it('times out to deny', async () => {
    vi.useFakeTimers();
    try {
      const { flow, onPerm } = makeFlow(120);
      const p = flow.request('s1', 'Bash', {});
      onPerm.mock.calls[0][0].permission; // request emitted
      vi.advanceTimersByTime(120_000);
      await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Timeout 120s' });
    } finally { vi.useRealTimers(); }
  });
  it('resolves deny when the AbortSignal fires', async () => {
    const { flow, onPerm } = makeFlow();
    const ac = new AbortController();
    const p = flow.request('s1', 'Bash', {}, ac.signal);
    onPerm.mock.calls[0][0].permission;
    ac.abort();
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Interrotto' });
  });
  it('cancels all pending requests for a session', async () => {
    const { flow, onPerm } = makeFlow();
    const p = flow.request('s1', 'Bash', {});
    flow.cancelAllForSession('s1');
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Sessione fermata' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/permissions.test.ts`
Expected: FAIL — module `permissions` not found.

- [ ] **Step 3: Write minimal implementation**

`src/permissions.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Bus } from './bus.js';
import type { Config } from './config.js';
import type { PermissionRequest } from './types.js';

export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string };

export interface PermissionFlowDeps {
  bus: Bus;
  config: Config;
  setStatus?: (sessionId: string, status: 'running' | 'waiting-permission') => void;
}

interface Pending {
  resolve: (d: PermissionDecision) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
}

export class PermissionFlow {
  private pending = new Map<string, Pending>();

  constructor(private deps: PermissionFlowDeps) {}

  request(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ behavior: 'deny', message: `Timeout ${this.deps.config.permissionTimeoutSeconds}s` });
      }, this.deps.config.permissionTimeoutSeconds * 1000);
      this.pending.set(id, { resolve, timer, sessionId });
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          if (this.pending.delete(id)) resolve({ behavior: 'deny', message: 'Interrotto' });
        });
      }
      this.deps.setStatus?.(sessionId, 'waiting-permission');
      const req: PermissionRequest = {
        id, sessionId, toolName, input, createdAt: new Date().toISOString(),
      };
      this.deps.bus.emit({ type: 'session.permission', permission: req });
    });
  }

  approve(id: string): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.deps.setStatus?.(p.sessionId, 'running');
    p.resolve({ behavior: 'allow' });
    return true;
  }

  deny(id: string, message = "Rifiutato dall'utente"): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.deps.setStatus?.(p.sessionId, 'running');
    p.resolve({ behavior: 'deny', message });
    return true;
  }

  cancelAllForSession(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ behavior: 'deny', message: 'Sessione fermata' });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/permissions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/permissions.ts test/permissions.test.ts
git commit -m "feat: add remote permission flow with timeout and abort"
```

---

### Task 6: SDK driver (headless)

**Files:**
- Create: `src/sessions/sdk-driver.ts`
- Test: `test/sdk-driver.test.ts`

**Interfaces:**
- Consumes: `Bus`, `Config`, `SessionManager`, `PermissionFlow` (all earlier tasks).
- Produces: `SdkDriver` with `runTurn(sessionId: string, prompt: string): Promise<void>` and `isBusy(sessionId): boolean`.

SDK mapping (validated by spike + docs at 0.3.221):
- `query({ prompt, options })` is an async iterable of `SDKMessage`.
- `msg.type === 'assistant'` → emit `session.text` (joined text blocks) + `session.tool` (tool_use blocks: `name`, `id`, `input`).
- `msg.type === 'user'` → emit `session.tool` (tool_result blocks: `tool_use_id`, `content`, `is_error`).
- `msg.type === 'result'` → success ⇒ `session.result` + status `idle`; error ⇒ `session.error` + status `error`.
- Every message carries `session_id` → `manager.setClaudeSessionId` (resume key, spec §5).
- Options: `model`, `cwd`, `resume: session.claudeSessionId`, `permissionMode: 'default'`, `canUseTool`, `additionalDirectories: [config.inboxDir]` (così l'headless può leggere gli allegati dell'inbox).

- [ ] **Step 1: Write the failing test**

`test/sdk-driver.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { PermissionFlow } from '../src/permissions.js';
import { SdkDriver } from '../src/sessions/sdk-driver.js';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...args: unknown[]) => queryMock(...args) }));

function makeDriver() {
  const bus = new Bus();
  const events: unknown[] = [];
  for (const t of ['session.text', 'session.tool', 'session.result', 'session.error', 'session.updated'] as const) {
    bus.on(t, e => events.push(e));
  }
  const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
  const state = new StateStore(join(mkdtempSync(join(tmpdir(), 'orc-sdk-')), 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const permissionFlow = new PermissionFlow({ bus, config, setStatus: (id, s) => manager.setStatus(id, s) });
  const sdk = new SdkDriver({ bus, manager, config, permissionFlow });
  const session = manager.createHeadless({ title: 'test', projectDir: '/tmp/x' });
  return { bus, events, manager, sdk, session };
}

function assistantText(sessionId: string, text: string) {
  return {
    type: 'assistant', uuid: 'u', session_id: sessionId,
    message: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}
function resultMsg(sessionId: string, result: string, isError = false) {
  return { type: 'result', subtype: 'success', uuid: 'u', session_id: sessionId, is_error: isError, result, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] };
}

describe('SdkDriver', () => {
  beforeEach(() => queryMock.mockReset());

  it('maps assistant text, tool_use and result to bus events', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield assistantText(session.id, 'ciao');
      yield {
        type: 'assistant', uuid: 'u', session_id: session.id,
        message: { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        parent_tool_use_id: null,
      };
      yield resultMsg(session.id, 'done');
    });
    await sdk.runTurn(session.id, 'saluta');
    const texts = events.filter(e => (e as any).type === 'session.text');
    expect(texts).toHaveLength(1);
    expect((texts[0] as any).text).toBe('ciao');
    const tools = events.filter(e => (e as any).type === 'session.tool');
    expect(tools).toHaveLength(1);
    expect((tools[0] as any).toolName).toBe('Bash');
    const res = events.find(e => (e as any).type === 'session.result');
    expect((res as any).result).toBe('done');
    expect(events.some(e => (e as any).type === 'session.error')).toBe(false);
  });

  it('stores the session_id for resume and passes resume on next turn', async () => {
    const { sdk, session, manager } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield assistantText(session.id, 'primo');
      yield resultMsg(session.id, 'ok');
    });
    await sdk.runTurn(session.id, 'a');
    expect(manager.get(session.id)!.claudeSessionId).toBe(session.id);
    queryMock.mockImplementationOnce(async function* () { yield resultMsg(session.id, 'ok2'); });
    await sdk.runTurn(session.id, 'b');
    const opts = queryMock.mock.calls[1][0].options;
    expect(opts.resume).toBe(session.id);
    expect(opts.permissionMode).toBe('default');
  });

  it('emits error and sets status error when the query throws', async () => {
    const { sdk, session, events, manager } = makeDriver();
    queryMock.mockImplementationOnce(async function* () { throw new Error('ollama giu'); });
    await sdk.runTurn(session.id, 'x');
    const err = events.find(e => (e as any).type === 'session.error');
    expect((err as any).message).toBe('ollama giu');
    expect(manager.get(session.id)!.status).toBe('error');
  });

  it('rejects concurrent turns on the same session', async () => {
    const { sdk, session } = makeDriver();
    queryMock.mockImplementationOnce(() => (async function* () { await new Promise(() => {}); })());
    const p1 = sdk.runTurn(session.id, 'a');
    expect(sdk.isBusy(session.id)).toBe(true);
    await expect(sdk.runTurn(session.id, 'b')).rejects.toThrow('busy');
    void p1;
  });
  it('stop() aborts an in-flight turn and sets status stopped', async () => {
    const { sdk, session, manager } = makeDriver();
    let ac: AbortController | undefined;
    queryMock.mockImplementationOnce(async function* (config: any) {
      ac = config.options.abortController;
      await new Promise<void>((_, reject) => {
        ac!.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const p = sdk.runTurn(session.id, 'x');
    expect(sdk.stop(session.id)).toBe(true);
    await p;
    expect(manager.get(session.id)!.status).toBe('stopped');
    expect(sdk.stop(session.id)).toBe(false); // già fermata
  });
  it('maps user tool_result blocks to session.tool', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: 'user', uuid: 'u', session_id: session.id,
        message: { id: 'm', type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: false }] },
        parent_tool_use_id: null,
      };
      yield resultMsg(session.id, 'ok');
    });
    await sdk.runTurn(session.id, 'x');
    const tools = events.filter(e => (e as any).type === 'session.tool');
    expect(tools).toHaveLength(1);
    expect((tools[0] as any).kind).toBe('tool_result');
    expect((tools[0] as any).result).toBe('out');
  });
  it('emits the joined SDK errors on an error result', async () => {
    const { sdk, session, events, manager } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: 'result', subtype: 'error_during_execution', uuid: 'u', session_id: session.id,
        is_error: true, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
        errors: ['boom1', 'boom2'],
      };
    });
    await sdk.runTurn(session.id, 'x');
    const err = events.find(e => (e as any).type === 'session.error');
    expect((err as any).message).toBe('boom1\nboom2');
    expect(manager.get(session.id)!.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/sdk-driver.test.ts`
Expected: FAIL — module `sdk-driver` not found.

- [ ] **Step 3: Write minimal implementation**

`src/sessions/sdk-driver.ts`:
```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { PermissionFlow } from '../permissions.js';
import type { SessionManager } from './manager.js';

export interface SdkDriverDeps {
  bus: Bus;
  manager: SessionManager;
  config: Config;
  permissionFlow: PermissionFlow;
}

export class SdkDriver {
  private busy = new Set<string>();
  private aborters = new Map<string, AbortController>();

  constructor(private deps: SdkDriverDeps) {}

  isBusy(sessionId: string): boolean { return this.busy.has(sessionId); }

  // /stop (e /rc off): abort del turno in corso via AbortController (opzione SDK).
  stop(sessionId: string): boolean {
    const ac = this.aborters.get(sessionId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  async runTurn(sessionId: string, prompt: string): Promise<void> {
    const { bus, manager, config, permissionFlow } = this.deps;
    if (this.busy.has(sessionId)) throw new Error(`session ${sessionId} is busy`);
    const session = manager.get(sessionId);
    if (!session || session.kind !== 'headless') throw new Error(`no headless session ${sessionId}`);
    this.busy.add(sessionId);
    manager.setStatus(sessionId, 'running');
    const ac = new AbortController();
    this.aborters.set(sessionId, ac);
    try {
      const stream = query({
        prompt,
        options: {
          model: session.model ?? config.defaultModel,
          cwd: session.projectDir,
          resume: session.claudeSessionId,
          permissionMode: 'default',
          additionalDirectories: [config.inboxDir],
          abortController: ac,
          canUseTool: (toolName, input, opts) =>
            permissionFlow.request(sessionId, toolName, input as Record<string, unknown>, opts.signal),
        },
      });
      let finished = false;
      for await (const msg of stream) {
        if (msg.session_id) manager.setClaudeSessionId(sessionId, msg.session_id);
        if (msg.type === 'assistant') {
          manager.touch(sessionId);
          const text = msg.message.content
            .filter(b => b.type === 'text')
            .map(b => (b as { text: string }).text)
            .join('\n');
          if (text.trim()) bus.emit({ type: 'session.text', sessionId, role: 'assistant', text });
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              bus.emit({
                type: 'session.tool', sessionId, toolName: block.name, kind: 'tool_use',
                toolUseId: block.id, input: block.input as Record<string, unknown>,
              });
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message.content) {
            // SDKUserMessage.content può contenere stringhe: guardia necessaria
            if (typeof block !== 'string' && block.type === 'tool_result') {
              bus.emit({
                type: 'session.tool', sessionId, toolName: '', kind: 'tool_result',
                toolUseId: block.tool_use_id, result: block.content, isError: block.is_error,
              });
            }
          }
        } else if (msg.type === 'result') {
          finished = true;
          // `is_error: boolean` (non letterale) NON restringe l'unione SDKResultMessage;
          // il discriminator è `subtype`. SDKResultError ha `errors: string[]`, non `result`.
          if (msg.subtype === 'success') {
            bus.emit({ type: 'session.result', sessionId, result: msg.result, isError: false });
            manager.setStatus(sessionId, 'idle');
          } else {
            bus.emit({ type: 'session.error', sessionId, message: msg.errors.join('\n') });
            manager.setStatus(sessionId, 'error');
          }
        }
      }
      if (!finished) manager.setStatus(sessionId, 'idle');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        bus.emit({ type: 'session.error', sessionId, message: "Fermata dall'utente" });
        manager.setStatus(sessionId, 'stopped');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        bus.emit({ type: 'session.error', sessionId, message });
        manager.setStatus(sessionId, 'error');
      }
    } finally {
      this.aborters.delete(sessionId);
      this.busy.delete(sessionId);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/sdk-driver.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/sessions/sdk-driver.ts test/sdk-driver.test.ts
git commit -m "feat: add SDK driver for headless sessions with resume"
```

---

### Task 7: tmux-inject

**Files:**
- Create: `src/sessions/tmux-inject.ts`
- Test: `test/tmux-inject.test.ts`

**Interfaces:**
- Produces: `ExecResult`, `ExecFn = (args: string[], opts?: { input?: string }) => Promise<ExecResult>`, `createExec(): ExecFn` (spawns `tmux`), and `TmuxClient` with:
  - `listSessions(): Promise<string[]>`
  - `sessionAlive(target: string): Promise<boolean>`
  - `injectText(target: string, text: string): Promise<void>` — named-buffer bracketed paste: `set-buffer -b <buf> -` (stdin) → `paste-buffer -b <buf> -t <target> -p` → `delete-buffer -b <buf>` (spec §7, con buffer temporaneo per non toccare il buffer utente).

- [ ] **Step 1: Write the failing test**

`test/tmux-inject.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { TmuxClient } from '../src/sessions/tmux-inject.js';

// Il buffer ha nome random per chiamata: la fake verifica solo il primo argomento
// (comando) e registra gli args reali per le asserzioni successive.
function fakeExec(script: Array<{ call: string[]; input?: string; result: { code: number; stdout?: string; stderr?: string } }>) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const exec: any = (args: string[], opts?: { input?: string }) => {
    calls.push({ args, input: opts?.input });
    const entry = script.shift()!;
    expect(args[0]).toBe(entry.call[0]);
    if (entry.input !== undefined) expect(opts?.input).toBe(entry.input);
    return Promise.resolve({ code: entry.result.code, stdout: entry.result.stdout ?? '', stderr: entry.result.stderr ?? '' });
  };
  return { exec, calls };
}

describe('TmuxClient', () => {
  it('lists session names', async () => {
    const { exec } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_name}'], result: { code: 0, stdout: 'claude:proj1\nclaude:proj2\n' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.listSessions()).resolves.toEqual(['claude:proj1', 'claude:proj2']);
  });
  it('returns empty list when tmux is not running', async () => {
    const { exec } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_name}'], result: { code: 1, stderr: 'no server running' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.listSessions()).resolves.toEqual([]);
  });
  it('injects multiline text via named buffer with bracketed paste', async () => {
    const { exec, calls } = fakeExec([
      { call: ['set-buffer', '-b', 'BUF', '-'], input: 'line1\nline2', result: { code: 0 } },
      { call: ['paste-buffer', '-b', 'BUF', '-t', 'claude:proj', '-p'], result: { code: 0 } },
      { call: ['delete-buffer', '-b', 'BUF'], result: { code: 0 } },
    ]);
    const tmux = new TmuxClient(exec);
    await tmux.injectText('claude:proj', 'line1\nline2');
    const buf = calls[0].args[2];
    expect(calls[0].args[0]).toBe('set-buffer');
    expect(buf).toMatch(/^rc-/);
    expect(calls[1].args[2]).toBe(buf);       // stesso buffer nel paste
    expect(calls[1].args).toContain('-p');     // bracketed paste
    expect(calls[2].args).toContain(buf);      // cleanup
  });
  it('throws when the target pane is gone', async () => {
    const { exec } = fakeExec([
      { call: ['set-buffer', '-b', 'BUF', '-'], input: 'x', result: { code: 0 } },
      { call: ['paste-buffer', '-b', 'BUF', '-t', 'gone:pane', '-p'], result: { code: 1, stderr: 'no such pane' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.injectText('gone:pane', 'x')).rejects.toThrow('paste-buffer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tmux-inject.test.ts`
Expected: FAIL — module `tmux-inject` not found.

- [ ] **Step 3: Write minimal implementation**

`src/sessions/tmux-inject.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string; }
export type ExecFn = (args: string[], opts?: { input?: string }) => Promise<ExecResult>;

export function createExec(): ExecFn {
  return (args, opts) => new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts?.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export class TmuxClient {
  constructor(private exec: ExecFn = createExec()) {}

  async listSessions(): Promise<string[]> {
    const r = await this.exec(['list-sessions', '-F', '#{session_name}']);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  }

  async sessionAlive(target: string): Promise<boolean> {
    return (await this.listSessions()).includes(target);
  }

  async injectText(target: string, text: string): Promise<void> {
    const buf = `rc-${randomBytes(4).toString('hex')}`;
    const set = await this.exec(['set-buffer', '-b', buf, '-'], { input: text });
    if (set.code !== 0) throw new Error(`tmux set-buffer failed: ${set.stderr}`);
    const paste = await this.exec(['paste-buffer', '-b', buf, '-t', target, '-p']);
    if (paste.code !== 0) throw new Error(`tmux paste-buffer failed: ${paste.stderr}`);
    await this.exec(['delete-buffer', '-b', buf]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tmux-inject.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/sessions/tmux-inject.ts test/tmux-inject.test.ts
git commit -m "feat: add tmux injection client with bracketed paste"
```

---

### Task 8: Mirror JSONL (sessioni terminale)

**Files:**
- Create: `src/sessions/mirror.ts`
- Test: `test/mirror.test.ts`

**Interfaces:**
- Consumes: `Bus`, `Config`, `SessionManager`, `TmuxClient` (solo `listSessions`, per l'auto-registrazione).
- Produces:
  - `encodeProjectPath(dir): string` — codifica di Claude Code: ogni `/` (incluso quello iniziale) → `-`. Es. `/private/tmp/ollama-rc-sdk-spike` → `-private-tmp-ollama-rc-sdk-spike` (convenzione verificata sulla dir dello spike).
  - `decodeProjectDir(encoded): string` — inverso best-effort: ogni `-` → `/` (nessun prefisso aggiunto: il `-` iniziale diventa la `/` iniziale). **Lossy con i trattini letterali nel path** — usato solo come display e per auto-registrazione, MAI per il matching.
  - **Matching dir→sessione per uguaglianza encoded**: `encodeProjectPath(s.projectDir) === encodedDirName` (esatto per qualsiasi path). Vale sempre `encodeProjectPath(decodeProjectDir(encoded)) === encoded`.
  - `parseLine(line: string): ParsedEvent[] | null` (puro, esportato per i test)
  - `JsonlMirror` con `start()`, `stop()`, `poll()`; legge incrementalmente i JSONL da offset persistiti (`manager.getState().mirrorOffsets`), gate sull'`armed`.

Parsing (formato verificato dallo spike, `~/.claude/projects/-private-tmp-ollama-rc-sdk-spike/*.jsonl`): si ignorano `queue-operation`, `last-prompt`, hook; si leggono le righe con `message.type === 'message'`.

- [ ] **Step 1: Write the failing test**

`test/mirror.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { JsonlMirror, encodeProjectPath, decodeProjectDir, parseLine } from '../src/sessions/mirror.js';

function makeMirror(tmuxSessions: string[] = []) {
  const bus = new Bus();
  const events: unknown[] = [];
  bus.on('session.text', e => events.push(e));
  bus.on('session.tool', e => events.push(e));
  const dir = mkdtempSync(join(tmpdir(), 'orc-mirror-'));
  const projectsDir = join(dir, 'projects');
  const config = loadConfig({ STATE_DIR: dir, PROJECTS_DIR: projectsDir });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const tmux = { listSessions: vi.fn(async () => tmuxSessions) };
  const mirror = new JsonlMirror({ bus, manager, config, tmux: tmux as any });
  return { bus, events, manager, mirror, dir, projectsDir };
}

describe('project path encoding', () => {
  it('encodes project paths to Claude Code dir names', () => {
    expect(encodeProjectPath('/private/tmp/ollama-rc-sdk-spike')).toBe('-private-tmp-ollama-rc-sdk-spike');
    expect(encodeProjectPath('/work/auto')).toBe('-work-auto');
  });
  it('decode is the inverse of encode on the encoded space (lossy on literal dashes)', () => {
    // decode è best-effort: i trattini letterali del path originale non sono recuperabili,
    // ma encode(decode(encoded)) === encoded vale SEMPRE — è il contratto del matching.
    expect(decodeProjectDir('-private-tmp-ollama-rc-sdk-spike')).toBe('/private/tmp/ollama/rc/sdk/spike');
    expect(encodeProjectPath(decodeProjectDir('-private-tmp-ollama-rc-sdk-spike'))).toBe('-private-tmp-ollama-rc-sdk-spike');
  });
});

describe('parseLine', () => {
  it('extracts assistant text', () => {
    const line = JSON.stringify({ parentUuid: null, message: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ciao' }] } });
    expect(parseLine(line)).toEqual([{ type: 'session.text', role: 'assistant', text: 'ciao' }]);
  });
  it('extracts tool_use and tool_result blocks', () => {
    const use = JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    const res = JSON.stringify({ message: { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: false }] } });
    expect(parseLine(use)).toEqual([{ type: 'session.tool', kind: 'tool_use', toolName: 'Bash', toolUseId: 't1', input: { command: 'ls' } }]);
    expect(parseLine(res)).toEqual([{ type: 'session.tool', kind: 'tool_result', toolUseId: 't1', result: 'out', isError: false }]);
  });
  it('returns null for non-message lines', () => {
    expect(parseLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' }))).toBeNull();
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('')).toBeNull();
  });
});

describe('JsonlMirror', () => {
  it('reads new lines from offset and emits events for a registered session', () => {
    const { manager, mirror, projectsDir, dir, events } = makeMirror();
    const projDir = join(dir, 'proj');
    const encoded = encodeProjectPath(projDir);
    const s = manager.registerTerminal({ title: 'proj', projectDir: projDir, tmuxTarget: 'claude:proj' });
    manager.setArmed(true);
    // simula ~/.claude/projects/<encoded>/session.jsonl
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, 'a.jsonl');
    writeFileSync(file, '{"type":"queue-operation"}\n' + JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'primo' }] } }) + '\n');
    mirror.poll();
    expect(events.filter(e => (e as any).text === 'primo')).toHaveLength(1);
    expect(manager.get(s.id)!.status).toBe('running');
    // seconda poll: nessun duplicato
    mirror.poll();
    expect(events.filter(e => (e as any).text === 'primo')).toHaveLength(1);
  });
  it('is a no-op when disarmed', () => {
    const { manager, mirror, projectsDir, dir, events } = makeMirror();
    const projDir = join(dir, 'proj');
    const encoded = encodeProjectPath(projDir);
    manager.registerTerminal({ title: 'proj', projectDir: projDir, tmuxTarget: 'claude:proj' });
    manager.setArmed(false);
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'a.jsonl'), JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'x' }] } }));
    mirror.poll();
    expect(events).toHaveLength(0);
  });
  it('auto-registers a terminal session and emits the discovered events', async () => {
    const { manager, mirror, projectsDir, dir, events } = makeMirror(['claude:auto']);
    manager.setArmed(true);
    const encoded = encodeProjectPath('/work/auto');
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'a.jsonl'), JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    mirror.poll();
    await vi.waitFor(() => expect(manager.findByTmuxTarget('claude:auto')).toBeDefined());
    // il primo batch letto in questa poll viene emesso dopo la registrazione (non perso)
    await vi.waitFor(() => expect(events.some(e => (e as any).text === 'hi')).toBe(true));
  });
  it('does not lose a partial trailing line across polls', () => {
    const { manager, mirror, projectsDir, dir, events } = makeMirror();
    const projDir = join(dir, 'proj');
    const encoded = encodeProjectPath(projDir);
    manager.registerTerminal({ title: 'proj', projectDir: projDir, tmuxTarget: 'claude:proj' });
    manager.setArmed(true);
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, 'a.jsonl');
    const full = JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'parziale' }] } }) + '\n';
    writeFileSync(file, full.slice(0, 20)); // prima metà, senza \n
    mirror.poll();
    expect(events).toHaveLength(0); // riga incompleta: non consumata
    appendFileSync(file, full.slice(20)); // append del resto
    mirror.poll();
    expect(events.filter(e => (e as any).text === 'parziale')).toHaveLength(1);
  });
  it('persists mirror offsets to disk after the debounce', () => {
    vi.useFakeTimers();
    try {
      const { manager, mirror, projectsDir, dir } = makeMirror();
      const projDir = join(dir, 'proj');
      const encoded = encodeProjectPath(projDir);
      manager.registerTerminal({ title: 'proj', projectDir: projDir, tmuxTarget: 'claude:proj' });
      manager.setArmed(true);
      const sessionDir = join(projectsDir, encoded);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'a.jsonl'), JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'x' }] } }) + '\n');
      mirror.poll();
      vi.advanceTimersByTime(2100);
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      expect(Object.keys(state.mirrorOffsets).length).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/mirror.test.ts`
Expected: FAIL — module `mirror` not found.

- [ ] **Step 3: Write minimal implementation**

`src/sessions/mirror.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/mirror.test.ts`
Expected: PASS (10 tests). (The auto-register test uses `vi.waitFor` because the tmux lookup is async.)

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/sessions/mirror.ts test/mirror.test.ts
git commit -m "feat: add JSONL mirror for terminal sessions"
```

---

### Task 9: Ollama helper (vision + whisper)

**Files:**
- Create: `src/ollama.ts`
- Test: `test/ollama.test.ts`

**Interfaces:**
- Produces: `OllamaDeps = { baseUrl: string; whisperModel: string; fetchImpl?: typeof fetch }` and `OllamaClient` with:
  - `hasVision(model): Promise<boolean>` — `POST /api/show` `{ model }`, legge `capabilities` (spec §2.7)
  - `transcribe(audioPath): Promise<string>` — multipart `file`+`model` su `/api/transcribe`, fallback `/v1/audio/transcriptions` (OpenAI-compat), ritorna `text` (constraint 11)

- [ ] **Step 1: Write the failing test**

`test/ollama.test.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaClient } from '../src/ollama.js';

// il transcribe legge il file da disco: va creato prima di ogni test
beforeEach(() => writeFileSync('/tmp/voice.wav', 'fake-audio'));

function fakeFetch(routes: Array<{ url: string; body?: unknown; ok?: boolean; status?: number }>) {
  const calls: Array<{ url: string; method?: string; body?: string | FormData }> = [];
  const fetchImpl: any = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body as any });
    const route = routes.shift()!;
    expect(url.endsWith(route.url)).toBe(true);
    if (!route.ok) return new Response(JSON.stringify({ error: 'x' }), { status: route.status ?? 500 });
    return new Response(JSON.stringify(route.body));
  };
  return { fetchImpl, calls };
}

describe('OllamaClient', () => {
  it('detects vision via /api/show capabilities', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/show', ok: true, body: { capabilities: ['vision', 'tools'] } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'whisper-large-v3', fetchImpl });
    await expect(client.hasVision('kimi-k3:cloud')).resolves.toBe(true);
  });
  it('returns false for models without vision', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/show', ok: true, body: { capabilities: ['tools'] } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'x', fetchImpl });
    await expect(client.hasVision('qwen2.5:7b')).resolves.toBe(false);
  });
  it('throws when /api/show fails', async () => {
    const { fetchImpl } = fakeFetch([{ url: '/api/show', ok: false, status: 404 }]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'x', fetchImpl });
    await expect(client.hasVision('m')).rejects.toThrow('404');
  });
  it('transcribes via /api/transcribe and falls back to OpenAI-compatible route', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/transcribe', ok: false, status: 404 },
      { url: '/v1/audio/transcriptions', ok: true, body: { text: 'ciao mondo' } },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'whisper-large-v3', fetchImpl });
    await expect(client.transcribe('/tmp/voice.wav')).resolves.toBe('ciao mondo');
  });
  it('throws when both endpoints fail', async () => {
    const { fetchImpl } = fakeFetch([
      { url: '/api/transcribe', ok: false, status: 500 },
      { url: '/v1/audio/transcriptions', ok: false, status: 500 },
    ]);
    const client = new OllamaClient({ baseUrl: 'http://127.0.0.1:11434', whisperModel: 'x', fetchImpl });
    await expect(client.transcribe('/tmp/voice.wav')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ollama.test.ts`
Expected: FAIL — module `ollama` not found.

- [ ] **Step 3: Write minimal implementation**

`src/ollama.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export interface OllamaDeps {
  baseUrl: string;
  whisperModel: string;
  fetchImpl?: typeof fetch;
}

interface ShowResponse { capabilities?: string[]; }

export class OllamaClient {
  private fetchImpl: typeof fetch;

  constructor(private deps: OllamaDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async hasVision(model: string): Promise<boolean> {
    const res = await this.fetchImpl(`${this.deps.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) throw new Error(`Ollama /api/show ${res.status}`);
    const data = (await res.json()) as ShowResponse;
    return (data.capabilities ?? []).includes('vision');
  }

  async transcribe(audioPath: string): Promise<string> {
    const buf = await readFile(audioPath);
    const name = basename(audioPath);
    const mime = name.endsWith('.wav') ? 'audio/wav' : 'audio/ogg';
    const form = new FormData();
    form.append('model', this.deps.whisperModel);
    form.append('file', new Blob([buf], { type: mime }), name);
    const endpoints = ['/api/transcribe', '/v1/audio/transcriptions'];
    let lastErr: unknown = new Error('transcription failed');
    for (const ep of endpoints) {
      try {
        const res = await this.fetchImpl(`${this.deps.baseUrl}${ep}`, { method: 'POST', body: form });
        if (!res.ok) { lastErr = new Error(`Ollama ${ep} ${res.status}`); continue; }
        const data = (await res.json()) as { text?: string };
        return data.text ?? '';
      } catch (e) { lastErr = e; }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ollama.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/ollama.ts test/ollama.test.ts
git commit -m "feat: add Ollama vision and whisper helpers"
```

---

### Task 10: Input handling (allegati + voce)

**Files:**
- Create: `src/input.ts`
- Test: `test/input.test.ts`

**Interfaces:**
- Consumes: `OllamaClient` (`ollama.js`).
- Produces: `InboxDeps = { dir: string; ollama: OllamaClient }` and `Inbox` with:
  - `saveAttachment(buf: Buffer, filename: string): Promise<string>` — scrive in `~/.ollama-rc/inbox/`, nome sanitizzato con timestamp (spec §8)
  - `voiceToText(oggPath: string): Promise<string>` — `ffmpeg -y -i <ogg> -ar 16000 -ac 1 <wav>` poi `ollama.transcribe(wav)`

- [ ] **Step 1: Write the failing test**

`test/input.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Inbox } from '../src/input.js';

const transcribeMock = vi.fn();
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function makeInbox() {
  const dir = mkdtempSync(join(tmpdir(), 'orc-inbox-'));
  const ollama = { transcribe: transcribeMock };
  return { inbox: new Inbox({ dir, ollama: ollama as any }), dir };
}

function fakeFfmpeg(ok = true) {
  return { on: (ev: string, cb: any) => { if (ev === 'close') setImmediate(() => cb(ok ? 0 : 1)); }, };
}

describe('Inbox', () => {
  beforeEach(() => { transcribeMock.mockReset(); spawnMock.mockReset(); });

  it('saves attachments with a sanitized timestamped name', async () => {
    const { inbox, dir } = makeInbox();
    const path = await inbox.saveAttachment(Buffer.from('hello'), 'a b!/c.png');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('hello');
    expect(path).not.toMatch(/[^a-zA-Z0-9._\-\/]/);
  });

  it('converts ogg to wav and transcribes via Ollama', async () => {
    const { inbox } = makeInbox();
    transcribeMock.mockResolvedValue('testo trascritto');
    spawnMock.mockImplementation((cmd: string, args: string[], _o: any) => {
      expect(cmd).toBe('ffmpeg');
      expect(args).toContain('-ar'); expect(args).toContain('16000');
      return fakeFfmpeg(true);
    });
    await expect(inbox.voiceToText('/tmp/msg.ogg')).resolves.toBe('testo trascritto');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when ffmpeg fails', async () => {
    const { inbox } = makeInbox();
    spawnMock.mockImplementation(() => fakeFfmpeg(false));
    await expect(inbox.voiceToText('/tmp/msg.ogg')).rejects.toThrow('ffmpeg');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/input.test.ts`
Expected: FAIL — module `input` not found.

- [ ] **Step 3: Write minimal implementation**

`src/input.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import type { OllamaClient } from './ollama.js';

export interface InboxDeps { dir: string; ollama: OllamaClient; }

export class Inbox {
  constructor(private deps: InboxDeps) {
    mkdirSync(this.deps.dir, { recursive: true });
  }

  async saveAttachment(buf: Buffer, filename: string): Promise<string> {
    const safe = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    // suffisso di unicità: due save nello stesso millisecondo non si sovrascrivono
    const path = join(this.deps.dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
    writeFileSync(path, buf);
    return path;
  }

  async voiceToText(oggPath: string): Promise<string> {
    const wavPath = oggPath.replace(/\.ogg$/, '.wav');
    await this.convertOggToWav(oggPath, wavPath);
    return this.deps.ollama.transcribe(wavPath);
  }

  private convertOggToWav(src: string, dst: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-y', '-i', src, '-ar', '16000', '-ac', '1', dst]);
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/input.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add src/input.ts test/input.test.ts
git commit -m "feat: add inbox for attachments and voice transcription"
```

---

### Task 11: Bot Telegram

**Files:**
- Create: `bot/telegram.ts`
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `Config`, `Bus`, `SessionManager`, `PermissionFlow`, `SdkDriver`, `TmuxClient`, `OllamaClient`, `Session`/`PermissionRequest` (tutti i task precedenti).
- Produces (pure helpers, testati): `ParsedCommand`, `parseCommand(text)`, `parseCallbackData(data)`, `permissionMessage(req)`, `sessionListText(sessions, activeId?)`, `EditThrottler`; e la classe `TelegramBot` (grammy, long-polling) con `start()` / `stop()`.

Comandi (spec §10): `/start` (intro + pairing) · `/rc on|off|status` · `/sessions` · `/new <testo>` · `/stop` · `/status` · `/attach <progetto>` · `/help`.

**Gate di attivazione** (spec §2.10/§12): da disattivo il bot risponde **solo** a `/rc`, `/help`, `/start`; ogni altro comando o messaggio → `Remote control disattivato. Usa /rc on.`

- [ ] **Step 1: Write the failing test**

`test/telegram.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { parseCommand, parseCallbackData, permissionMessage, sessionListText, EditThrottler, attachmentPlan } from '../bot/telegram.js';

describe('parseCommand', () => {
  it('classifies control commands', () => {
    expect(parseCommand('/rc on')).toEqual({ kind: 'control', command: 'rc', arg: 'on' });
    expect(parseCommand('/help')).toEqual({ kind: 'control', command: 'help' });
  });
  it('classifies session commands', () => {
    expect(parseCommand('/new  refactor this')).toEqual({ kind: 'session', command: 'new', arg: 'refactor this' });
    expect(parseCommand('/sessions')).toEqual({ kind: 'session', command: 'sessions' });
  });
  it('classifies plain text and unknown', () => {
    expect(parseCommand('ciao')).toEqual({ kind: 'text' });
    expect(parseCommand('/bogus')).toEqual({ kind: 'unknown' });
  });
});

describe('parseCallbackData', () => {
  it('parses approve/deny/select actions', () => {
    expect(parseCallbackData('perm:approve:abc')).toEqual({ action: 'approve', id: 'abc' });
    expect(parseCallbackData('perm:deny:abc')).toEqual({ action: 'deny', id: 'abc' });
    expect(parseCallbackData('sess:select:xyz')).toEqual({ action: 'select', id: 'xyz' });
  });
  it('throws on malformed data', () => {
    expect(() => parseCallbackData('junk')).toThrow();
  });
});

describe('permissionMessage / sessionListText', () => {
  it('renders tool name and input', () => {
    const msg = permissionMessage({ id: 'i', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, createdAt: '' });
    expect(msg).toContain('Bash');
    expect(msg).toContain('ls');
  });
  it('marks the active session', () => {
    const sessions = [
      { id: 'aaa', kind: 'headless', title: 't1', projectDir: '/x', status: 'idle', lastActivity: '2026-08-04T00:00:00.000Z', createdAt: '' },
      { id: 'bbb', kind: 'terminal', title: 't2', projectDir: '/y', status: 'running', lastActivity: '2026-08-05T00:00:00.000Z', createdAt: '' },
    ] as any;
    const txt = sessionListText(sessions, 'bbb');
    expect(txt).toContain('▸');
    expect(txt).toContain('running');
  });
});

describe('attachmentPlan', () => {
  it('warns only for text-only models on images (path-reference, no image blocks)', () => {
    expect(attachmentPlan(true, 'image')).toEqual({});
    expect(attachmentPlan(false, 'image').warning).toBeTruthy();
    expect(attachmentPlan(true, 'document')).toEqual({});
  });
});

describe('EditThrottler', () => {
  it('paces edits at ~1/s', async () => {
    vi.useFakeTimers();
    try {
      const t = new EditThrottler(1000);
      const fn = vi.fn(async () => undefined);
      const p1 = t.throttled(fn);
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      const p2 = t.throttled(fn);
      await vi.advanceTimersByTimeAsync(500);
      expect(fn).toHaveBeenCalledTimes(1); // ancora in attesa
      await vi.advanceTimersByTimeAsync(600);
      await p1; await p2;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — module `telegram` not found.

- [ ] **Step 3: Write minimal implementation**

`bot/telegram.ts`:
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Bus } from '../src/bus.js';
import type { Config } from '../src/config.js';
import type { SessionManager } from '../src/sessions/manager.js';
import type { PermissionFlow } from '../src/permissions.js';
import type { SdkDriver } from '../src/sessions/sdk-driver.js';
import type { TmuxClient } from '../src/sessions/tmux-inject.js';
import type { OllamaClient } from '../src/ollama.js';
import type { Inbox } from '../src/input.js';
import type { Session, PermissionRequest } from '../src/types.js';

// ---------- pure helpers ----------

export type ParsedCommand =
  | { kind: 'control'; command: 'rc' | 'help'; arg?: string }
  | { kind: 'start'; arg?: string }
  | { kind: 'session'; command: 'sessions' | 'new' | 'stop' | 'status' | 'attach'; arg?: string }
  | { kind: 'text' }
  | { kind: 'unknown' };

const CONTROL_COMMANDS = new Set(['rc', 'help', 'start']);

export function parseCommand(text: string): ParsedCommand {
  const t = text.trim();
  if (!t.startsWith('/')) return { kind: 'text' };
  const [raw, ...rest] = t.split(/\s+/);
  const command = raw.slice(1).toLowerCase();
  const arg = rest.join(' ').trim();
  // `arg` è omesso quando vuoto (campo opzionale nel tipo)
  const control = (c: 'rc' | 'help'): ParsedCommand =>
    arg ? { kind: 'control', command: c, arg } : { kind: 'control', command: c };
  const sessionCmd = (c: 'sessions' | 'new' | 'stop' | 'status' | 'attach'): ParsedCommand =>
    arg ? { kind: 'session', command: c, arg } : { kind: 'session', command: c };
  if (command === 'rc' || command === 'help') return control(command as 'rc' | 'help');
  if (command === 'start') return arg ? { kind: 'start', arg } : { kind: 'start' };
  if (['sessions', 'new', 'stop', 'status', 'attach'].includes(command)) {
    return sessionCmd(command as 'sessions' | 'new' | 'stop' | 'status' | 'attach');
  }
  return { kind: 'unknown' };
}

export function parseCallbackData(data: string): { action: 'approve' | 'deny' | 'select'; id: string } {
  const parts = data.split(':');
  if (parts.length === 3) {
    const [ns, action, id] = parts;
    if (ns === 'perm' && (action === 'approve' || action === 'deny') && id) return { action, id };
    if (ns === 'sess' && action === 'select' && id) return { action: 'select', id };
  }
  throw new Error(`bad callback data: ${data}`);
}

// parse_mode 'HTML' rigetta markup malformato (es. '<b' sbilanciato) e il send è
// dentro .catch(()=>{}) → il messaggio sparirebbe in silenzio. Escapare ogni frammento
// dinamico prima di interpolarlo nei template HTML.
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function permissionMessage(req: PermissionRequest): string {
  const input = htmlEscape(JSON.stringify(req.input, null, 2).slice(0, 1000));
  return `🔧 Permesso richiesto — sessione <b>${htmlEscape(req.sessionId.slice(0, 8))}</b>\nTool: <code>${htmlEscape(req.toolName)}</code>\n<pre>${input}</pre>`;
}

export function sessionListText(sessions: Session[], activeId?: string): string {
  if (!sessions.length) return 'Nessuna sessione.';
  return sessions
    .map(s => `${s.id === activeId ? '▸' : ' '} <b>${htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}] ${htmlEscape(s.title)} — ${s.status}`)
    .join('\n');
}

// spec §8: mai inoltrare blocchi immagine a modelli text-only.
// Nota onesta (review finale): l'inoltro immagine è un "path reference" — il modello
// legge il file via additionalDirectories: inboxDir — NON un blocco immagine nel
// prompt, perché l'SDK query accetta solo prompt testuali. Il flag attach è
// volutamente assente (il codice non deve fingere un attach che non fa).
export function attachmentPlan(
  modelHasVision: boolean,
  kind: 'image' | 'document',
): { warning?: string } {
  if (kind === 'image' && !modelHasVision) {
    return { warning: '⚠️ Modello senza vision: inoltro solo il riferimento al file.' };
  }
  return {};
}

export class EditThrottler {
  private lastEdit = 0;
  constructor(private minIntervalMs = 1000) {}
  async throttled<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const wait = this.lastEdit + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastEdit = Date.now();
    try { return await fn(); } catch { return undefined; }
  }
}

// ---------- bot ----------

export interface BotDeps {
  config: Config;
  bus: Bus;
  manager: SessionManager;
  permissionFlow: PermissionFlow;
  sdk: SdkDriver;
  tmux: TmuxClient;
  inbox: Inbox;
  ollama: OllamaClient;
}

export class TelegramBot {
  private bot: Bot;
  private throttler = new EditThrottler(1000);
  private chatId?: number;
  private activeSessionId?: string;
  private lastMsg = new Map<string, { messageId: number; text: string; at: number }>();

  constructor(private deps: BotDeps) {
    this.bot = new Bot(deps.config.telegramBotToken);
    this.register();
    this.subscribeBus();
  }

  async start(): Promise<void> {
    if (!this.deps.config.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN mancante');
    await this.bot.start({ drop_pending_updates: true });
  }
  async stop(): Promise<void> { await this.bot.stop(); }

  private send(ctx: Context, text: string): Promise<unknown> {
    return ctx.reply(text, { parse_mode: 'HTML' });
  }
  private notify(text: string): void {
    if (this.chatId) void this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
  private async forwardText(sessionId: string, text: string): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;
    const last = this.lastMsg.get(sessionId);
    const now = Date.now();
    if (last && now - last.at < 10_000) {
      const ok = await this.throttler.throttled(() =>
        this.bot.api.editMessageText(chatId, last.messageId, last.text + '\n' + text).then(() => true).catch(() => false));
      if (ok) { last.text += '\n' + text; last.at = now; return; }
    }
    const msg = await this.bot.api.sendMessage(chatId, text).catch(() => undefined);
    if (msg) this.lastMsg.set(sessionId, { messageId: msg.message_id, text, at: now });
  }

  private isAuthorized(ctx: Context): boolean {
    const userId = ctx.from?.id;
    return !!userId && (this.deps.config.allowedUserIds.includes(userId) || this.deps.manager.isAuthorizedUser(userId));
  }

  private authorize(ctx: Context): boolean {
    if (this.isAuthorized(ctx)) { this.chatId = ctx.chat?.id ?? this.chatId; return true; }
    void this.send(ctx, '⛔ Non autorizzato. Inviami <code>/start &lt;codice di pairing&gt;</code>.');
    return false;
  }

  private register(): void {
    const bot = this.bot;
    bot.command('start', ctx => this.onStart(ctx));
    bot.command('help', ctx => { if (this.authorize(ctx)) this.send(ctx, 'Comandi: /rc on|off|status · /sessions · /new &lt;testo&gt; · /stop · /status · /attach &lt;progetto&gt; · /help'); });
    bot.command('rc', ctx => this.onRc(ctx));
    bot.command('sessions', ctx => this.onSessions(ctx));
    bot.command('new', ctx => this.onNew(ctx));
    bot.command('stop', ctx => this.onStop(ctx));
    bot.command('status', ctx => this.onStatus(ctx));
    bot.command('attach', ctx => this.onAttach(ctx));
    bot.on('callback_query:data', ctx => this.onCallback(ctx));
    bot.on('message:text', ctx => this.onMessage(ctx));
    bot.on('message:photo', ctx => this.onPhoto(ctx));
    bot.on('message:voice', ctx => this.onVoice(ctx));
    bot.on('message:document', ctx => this.onDocument(ctx));
  }

  private async onStart(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (this.isAuthorized(ctx)) {
      this.chatId = ctx.chat?.id;
      await this.send(ctx, `👋 Benvenuto! Stato: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disattivato'}. Usa /help.`);
      return;
    }
    const code = ctx.match?.toString().trim() ?? '';
    if (this.deps.config.pairingCode && code === this.deps.config.pairingCode) {
      this.deps.manager.addAuthorizedUser(userId);
      this.deps.manager.persist();
      this.chatId = ctx.chat?.id;
      await this.send(ctx, '✅ Pairing riuscito. Usa /help.');
    } else {
      await this.send(ctx, '⛔ Non autorizzato. Inviami <code>/start &lt;codice di pairing&gt;</code>.');
    }
  }

  private async onRc(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    const arg = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (arg === 'on') {
      this.deps.manager.setArmed(true); this.deps.manager.persist();
      await this.send(ctx, '🔓 Remote control ARMATO.');
    } else if (arg === 'off') {
      this.deps.manager.setArmed(false);
      for (const s of this.deps.manager.list()) {
        this.deps.permissionFlow.cancelAllForSession(s.id);
        this.deps.sdk.stop(s.id); // spegne anche i turni headless in corso
      }
      this.deps.manager.persist();
      await this.send(ctx, '🔒 Remote control DISATTIVATO. Nessun mirror, iniezione o relay.');
    } else if (arg === 'status') {
      await this.send(ctx, `Interruttore: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disattivato'}`);
    } else {
      await this.send(ctx, 'Uso: /rc on | /rc off | /rc status');
    }
  }

  private requireArmed(ctx: Context): boolean {
    if (!this.deps.manager.isArmed()) { void this.send(ctx, '🔒 Remote control disattivato. Usa /rc on.'); return false; }
    return true;
  }

  private async onSessions(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const kb = new InlineKeyboard();
    for (const s of this.deps.manager.list()) kb.text(s.id.slice(0, 6), `sess:select:${s.id}`);
    await ctx.reply(sessionListText(this.deps.manager.list(), this.activeSessionId), {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }

  private async onNew(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const text = ctx.match?.toString().trim() ?? '';
    if (!text) { await this.send(ctx, 'Uso: /new &lt;testo&gt;'); return; }
    const running = this.deps.manager.list().filter(s => s.kind === 'headless' && s.status === 'running').length;
    if (running >= this.deps.config.maxHeadlessSessions) { await this.send(ctx, `Limite di ${this.deps.config.maxHeadlessSessions} sessioni headless attive raggiunto.`); return; }
    const projectDir = this.deps.config.workspaceDirs[0] ?? homedir();
    const session = this.deps.manager.createHeadless({
      title: text.slice(0, 40), projectDir, model: this.deps.config.defaultModel,
    });
    this.activeSessionId = session.id;
    this.deps.manager.persist();
    await this.send(ctx, `🆕 Sessione <b>${htmlEscape(session.id.slice(0, 8))}</b> avviata.`);
    // NON await: grammy processa gli update in sequenza — aspettare un turno di minuti
    // bloccherebbe /stop, /rc off e i callback. Il driver emette gli eventi sul bus.
    void this.deps.sdk.runTurn(session.id, text);
  }

  private async onStop(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    if (this.activeSessionId) {
      this.deps.permissionFlow.cancelAllForSession(this.activeSessionId);
      this.deps.sdk.stop(this.activeSessionId); // abort del turno in corso
    }
    await this.send(ctx, '🛑 Fermata richiesta per la sessione attiva.');
  }

  private async onStatus(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const s = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : undefined;
    await this.send(ctx, s
      ? `Sessione attiva: <b>${s.id.slice(0, 8)}</b> [${s.kind}] — ${s.status}`
      : 'Nessuna sessione attiva. Crea con /new.');
  }

  private async onAttach(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const name = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (!name) { await this.send(ctx, 'Uso: /attach &lt;progetto&gt;'); return; }
    const projectDir = this.resolveProjectDir(name);
    if (!projectDir) { await this.send(ctx, `Progetto "${htmlEscape(name)}" non trovato nei workspace.`); return; }
    const session = this.deps.manager.registerTerminal({ title: name, projectDir, tmuxTarget: `claude:${name}` });
    this.activeSessionId = session.id;
    this.deps.manager.persist();
    await this.send(ctx, `📎 Sessione terminale <b>${htmlEscape(session.id.slice(0, 8))}</b> collegata a <code>claude:${htmlEscape(name)}</code>.`);
  }

  private resolveProjectDir(name: string): string | undefined {
    for (const w of this.deps.config.workspaceDirs) {
      const candidate = join(w, name);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private async onCallback(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    // da disattivo nessuna approvazione/deny/switch (constraint 8): un permesso
    // in sospeso resta pending e scade → deny per timeout.
    if (!this.deps.manager.isArmed()) { await ctx.answerCallbackQuery({ text: '🔒 Remote control disattivato' }); return; }
    const data = ctx.callbackQuery?.data ?? '';
    try {
      const { action, id } = parseCallbackData(data);
      if (action === 'approve') {
        const ok = this.deps.permissionFlow.approve(id);
        await ctx.answerCallbackQuery({ text: ok ? '✓ Approvato' : 'Già risolto' });
      } else if (action === 'deny') {
        const ok = this.deps.permissionFlow.deny(id);
        await ctx.answerCallbackQuery({ text: ok ? '✗ Rifiutato' : 'Già risolto' });
      } else {
        const s = this.deps.manager.get(id);
        if (s) this.activeSessionId = s.id;
        await ctx.answerCallbackQuery({ text: 'Sessione selezionata' });
        await ctx.editMessageText(sessionListText(this.deps.manager.list(), this.activeSessionId), { parse_mode: 'HTML' });
      }
    } catch {
      await ctx.answerCallbackQuery({ text: 'Dato non valido' });
    }
  }

  private async routeMessageToSession(ctx: Context, text: string): Promise<void> {
    const session = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'Nessuna sessione. Crea con /new o /attach.'); return; }
    if (session.kind === 'headless') {
      if (this.deps.sdk.isBusy(session.id)) {
        await this.send(ctx, '⏳ Sessione occupata: aspetta che diventi idle prima di inoltrare.');
        return;
      }
      void this.deps.sdk.runTurn(session.id, text); // non bloccante (vedi onNew)
    } else {
      if (!this.deps.manager.isIdle(session.id)) {
        await this.send(ctx, '⏳ Sessione occupata: aspetta che diventi idle prima di iniettare.');
        return;
      }
      await this.deps.tmux.injectText(session.tmuxTarget!, text);
    }
  }

  private async onMessage(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    if (!ctx.message) return;
    // grammy 1.45: `text` è `text?: string` anche su message:text — la guardia non lo
    // restringe; `?? ''` è sicuro perché il filtro message:text scatta solo su testi.
    const text = ctx.message.text ?? '';
    if (text.startsWith('/')) return; // gestiti dai comandi
    if (!this.deps.manager.isArmed()) { await this.send(ctx, '🔒 Remote control disattivato. Usa /rc on.'); return; }
    await this.routeMessageToSession(ctx, text);
  }

  // grammy 1.45: `ctx.getFile()` ritorna i METADATA del file ({ file_id, file_path }),
  // non i byte — i byte vanno scaricati dall'endpoint /file/bot<token>/<file_path>.
  private async downloadTelegramFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.deps.config.telegramBotToken}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async onPhoto(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const session = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'Nessuna sessione. Crea con /new o /attach.'); return; }
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File non scaricabile.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, `image-${Date.now()}.jpg`);
    let hasVision = false;
    try { hasVision = await this.deps.ollama.hasVision(session.model ?? this.deps.config.defaultModel); } catch { /* assume no vision */ }
    const plan = attachmentPlan(hasVision, 'image');
    if (plan.warning) await this.send(ctx, plan.warning);
    await this.routeMessageToSession(ctx, `[Immagine allegata: ${path}]`);
  }

  private async onVoice(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    if (!ctx.message?.voice) return;
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File non scaricabile.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, `voice-${Date.now()}.ogg`);
    await this.send(ctx, '🎙️ Trascrizione in corso…');
    try {
      const text = await this.deps.inbox.voiceToText(path);
      if (!text.trim()) { await this.send(ctx, 'Trascrizione vuota.'); return; }
      await this.routeMessageToSession(ctx, text);
    } catch (e) {
      await this.send(ctx, `❌ Trascrizione fallita: ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
    }
  }

  private async onDocument(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const doc = ctx.message?.document;
    if (!doc) return;
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File non scaricabile.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, doc.file_name ?? `doc-${Date.now()}`);
    await this.send(ctx, `📄 File salvato: <code>${htmlEscape(path)}</code>`);
    await this.routeMessageToSession(ctx, `[File allegato: ${path}]`);
  }

  private subscribeBus(): void {
    const bus = this.deps.bus;
    // constraint 8: da disattivo nessun relay — ogni handler del bus è gated su armed.
    bus.on('session.text', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.role === 'assistant') void this.forwardText(e.sessionId, e.text);
    });
    bus.on('session.tool', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.kind === 'tool_use' && e.sessionId === this.activeSessionId && e.input) {
        this.notify(`🔧 <code>${htmlEscape(e.toolName)}</code> — <pre>${htmlEscape(JSON.stringify(e.input).slice(0, 300))}</pre>`);
      }
    });
    bus.on('session.permission', ({ permission }) => {
      if (!this.deps.manager.isArmed()) return;
      const kb = new InlineKeyboard()
        .text('✓ Approva', `perm:approve:${permission.id}`)
        .text('✗ Rifiuta', `perm:deny:${permission.id}`);
      if (this.chatId) {
        void this.bot.api.sendMessage(this.chatId, permissionMessage(permission), { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
      }
    });
    bus.on('session.result', e => { if (this.deps.manager.isArmed() && e.sessionId === this.activeSessionId) this.notify(`✅ ${htmlEscape(e.result.slice(0, 500))}`); });
    bus.on('session.error', e => { if (this.deps.manager.isArmed() && e.sessionId === this.activeSessionId) this.notify(`❌ <b>${htmlEscape(e.message.slice(0, 500))}</b>`); });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS (parseCommand 3, parseCallbackData 2, helpers 3, throttler 1 — 9 test totali).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` — Expected: clean.
```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat: add Telegram bot with commands, permission keyboard, routing"
```

---

### Task 12: Daemon wiring

**Files:**
- Create: `src/daemon.ts`
- Test: `test/daemon.test.ts`

**Interfaces:**
- Consumes: tutti i moduli.
- Produces: `createDaemon(config: Config, overrides?: { bot?: Pick<TelegramBot, 'start' | 'stop'> }): Daemon` con `{ start(): Promise<void>; stop(): Promise<void> }`. Compone i moduli, collega `PermissionFlow.setStatus` al manager, avvia mirror + bot, gestisce SIGINT/SIGTERM. `import.meta.url` guard → avvio diretto con `tsx src/daemon.ts` (spec §14).

- [ ] **Step 1: Write the failing test**

`test/daemon.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDaemon } from '../src/daemon.js';

describe('createDaemon', () => {
  it('applies ARMED_ON_START and persists state on stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-daemon-'));
    const config = loadConfig({
      STATE_DIR: dir,
      TELEGRAM_BOT_TOKEN: 'test-token',
      ARMED_ON_START: 'true',
      WORKSPACE_DIRS: '/tmp',
    });
    const bot = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const daemon = createDaemon(config, { bot: bot as any });
    await daemon.start();
    expect(bot.start).toHaveBeenCalled();
    // il mirror gira ma il gate armed non impedisce la persistenza
    await daemon.stop();
    const statePath = join(dir, 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(state.armed).toBe(true);
  });

  it('starts disarmed by default (no mirror, no relay)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-daemon2-'));
    const config = loadConfig({ STATE_DIR: dir, TELEGRAM_BOT_TOKEN: 't' });
    const bot = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const daemon = createDaemon(config, { bot: bot as any });
    await daemon.start();
    await daemon.stop();
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(state.armed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon.test.ts`
Expected: FAIL — module `daemon` not found.

- [ ] **Step 3: Write minimal implementation**

`src/daemon.ts`:
```ts
import 'dotenv/config';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.js';
import { StateStore } from './state.js';
import { Bus } from './bus.js';
import { SessionManager } from './sessions/manager.js';
import { PermissionFlow } from './permissions.js';
import { OllamaClient } from './ollama.js';
import { SdkDriver } from './sessions/sdk-driver.js';
import { JsonlMirror } from './sessions/mirror.js';
import { TmuxClient } from './sessions/tmux-inject.js';
import { Inbox } from './input.js';
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
  const ollama = new OllamaClient({ baseUrl: config.ollamaBaseUrl, whisperModel: config.whisperModel });
  const sdk = new SdkDriver({ bus, manager, config, permissionFlow });
  const tmux = new TmuxClient();
  const mirror = new JsonlMirror({ bus, manager, config, tmux });
  const inbox = new Inbox({ dir: config.inboxDir, ollama });
  const bot = overrides.bot ?? new TelegramBot({ config, bus, manager, permissionFlow, sdk, tmux, inbox, ollama });

  const reaper = setInterval(() => manager.reapIdle(), 1000);
  reaper.unref();

  return {
    async start() {
      mirror.start(); // interno: gate su armed (constraint 8)
      await bot.start();
    },
    async stop() {
      clearInterval(reaper);
      mirror.stop();
      await bot.stop();
      manager.persist();
    },
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const daemon = createDaemon(loadConfig());
  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0)).catch(() => process.exit(1));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  daemon.start().catch(err => { console.error('daemon start failed:', err); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/daemon.test.ts`
Expected: PASS (2 test). Il test inietta un bot fake così `start()`/`stop()` non toccano Telegram; la classe reale `TelegramBot.start()` lancia "TELEGRAM_BOT_TOKEN mancante" se il token è vuoto — quindi in produzione serve `.env` compilato.

- [ ] **Step 5: Full suite + typecheck + commit**

Run: `npm test` — Expected: tutti i test PASS. `npm run typecheck` — Expected: clean.
```bash
git add src/daemon.ts test/daemon.test.ts
git commit -m "feat: wire the daemon and add armed-gate smoke tests"
```

---

### Task 13: Deployment + docs

**Files:**
- Create: `scripts/install-launchd.sh`
- Create: `scripts/com.ontech7.ollama-rc.plist.template`
- Create: `README.md`

**Interfaces:**
- Consumes: daemon (Task 12). Niente test unitari: deliverable = script installabile + doc. Verifica manuale in Step 3.

- [ ] **Step 1: Write the launchd install script**

`scripts/com.ontech7.ollama-rc.plist.template` (i path vengono sostituiti dallo script):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ontech7.ollama-rc</string>
  <key>ProgramArguments</key>
  <array>
    <string>__NODE__</string>
    <string>__TSX__</string>
    <string>__DAEMON__</string>
  </array>
  <key>WorkingDirectory</key><string>__REPO__</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>__STATE__/logs/daemon.log</string>
  <key>StandardErrorPath</key><string>__STATE__/logs/daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
```

`scripts/install-launchd.sh` (genera la plist con path assoluti e carica l'agente; idempotente):
```bash
#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# `|| true`: sotto set -euo pipefail, command -v che fallisce TERMINEREBBE lo script
# prima della guardia -z — il || true rende raggiungibile il messaggio di errore.
NODE="$(command -v node || true)"
TSX="$(command -v tsx || true)"
# tsx è una devDependency locale (node_modules/.bin) — spesso non è su PATH:
# fallback al bin locale dopo `npm install` (vedi README).
if [ -z "$TSX" ] && [ -x "$REPO/node_modules/.bin/tsx" ]; then
  TSX="$REPO/node_modules/.bin/tsx"
fi
STATE="${STATE_DIR:-$HOME/.ollama-rc}"
PLIST="$HOME/Library/LaunchAgents/com.ontech7.ollama-rc.plist"
LABEL="com.ontech7.ollama-rc"

if [ -z "$NODE" ] || [ -z "$TSX" ]; then
  echo "node o tsx non trovati in PATH" >&2
  exit 1
fi

mkdir -p "$STATE/logs"
mkdir -p "$(dirname "$PLIST")"
sed -e "s|__NODE__|$NODE|g" \
    -e "s|__TSX__|$TSX|g" \
    -e "s|__DAEMON__|$REPO/src/daemon.ts|g" \
    -e "s|__REPO__|$REPO|g" \
    -e "s|__STATE__|$STATE|g" \
    "$REPO/scripts/com.ontech7.ollama-rc.plist.template" > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Daemon ollama-rc installato (label $LABEL)."
echo "Log: $STATE/logs/daemon.log"
```

- [ ] **Step 2: Write the README**

`README.md`:
```markdown
# ollama-rc

Remote control per Claude Code servito da Ollama: daemon locale + bot Telegram.
Mima `/remote-control` di Claude Code senza infrastruttura Anthropic.

## Prerequisiti
- Node 22, Ollama attivo, `tmux` (`brew install tmux`), `ffmpeg` (`brew install ffmpeg`)
- Modelli: `ollama pull deepseek-v4-flash:0731-cloud` (default) e `ollama pull whisper-large-v3` (voce)

## Setup
1. `cp .env.example .env` e compila i segreti (token da @BotFather, ALLOWED_USER_IDS o PAIRING_CODE)
2. `npm install`
3. `./scripts/install-launchd.sh`  (o `npm run dev` per il primo test in foreground)

## Uso
- Sessioni interattive: `tmux new -s claude:<progetto>` → dentro, `claude`
- Da Telegram: `/rc on` armare · `/sessions` · `/new <testo>` · `/attach <progetto>` · `/stop` · `/status`
- Da disattivo il bot risponde solo a `/rc`, `/help`, `/start`
- Permessi headless: bottoni `✓ Approva` / `✗ Rifiuta` direttamente in chat
- Media: foto/voci/file salvati in `~/.ollama-rc/inbox/`; le immagini viaggiano come
  *riferimento al path* (il modello headless le legge via `additionalDirectories`) — non
  come blocco immagine nel prompt (limite dell'SDK query testuale). Voci trascritte via whisper.

## Architettura
Daemon (Node 22 + tsx) → bus eventi → bot grammy (long-polling).
Sessione headless = SDK 0.3.221 (`query`+`resume`, `canUseTool`); sessione terminale =
mirror dei JSONL `~/.claude/projects` (read-only) + iniezione tmux con bracketed paste.
Stato (`armed`, sessioni, offset) in `~/.ollama-rc/state.json`. Vedi `docs/superpowers/specs/`.

> Nota log: i log del daemon (`~/.ollama-rc/logs/daemon.log`) sono file plain senza rotazione
> automatica — la rotazione è demandata all'OS (newsyslog) o all'utente. Segnalato come
> follow-up rispetto alla spec §14.

- [ ] **Step 3: Manual verification**

Run: `chmod +x scripts/install-launchd.sh && ./scripts/install-launchd.sh`
Expected: plist generato in `~/Library/LaunchAgents/`, `launchctl list | grep ollama-rc` mostra il label, `tail ~/.ollama-rc/logs/daemon.log` mostra l'avvio. Poi `launchctl unload` se si vuole fermare durante lo sviluppo.

- [ ] **Step 4: Commit**

```bash
git add scripts/install-launchd.sh scripts/com.ontech7.ollama-rc.plist.template README.md
git commit -m "docs: add launchd install script and README"
```

---
