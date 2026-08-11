# /settings command + enriched /diag — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/settings` Telegram command (view/edit curated user settings persisted to `settings.json` in the state dir, applied at daemon restart) and enrich `/diag` (fix the missing menu entry; show per-session model · effort · git branch).

**Architecture:** A new `src/settings.ts` module (validated JSON store, same atomic-write/corrupt-preservation pattern as `src/state.ts`) feeds `loadConfig()` as an override layer with precedence `settings.json > .env > hardcoded default`. The bot gets a `SettingsStore` dependency; `/settings` is a pure-function, argument-based command (list / show / set / reset) behind the `authorize` + `requireArmed` gates. Effort is a new `Session.effort` field: set by `/new --effort` for headless and discovered from the `claude` process command line (`--reasoning-effort`) for terminal sessions; the branch is resolved at `/diag` render time via a new `src/git.ts` helper.

**Tech Stack:** Node 22+, TypeScript strict ESM (`.js` import extensions), `tsx`, `vitest`, grammy, `@anthropic-ai/claude-agent-sdk`. No new runtime dependencies.

## Global Constraints

- Config is read **once**, in `loadConfig()` (`src/config.ts`). No `process.env` reads anywhere else. The settings file is read only inside `loadConfig()` and by the bot's `/settings` handler via a `SettingsStore`.
- Settings precedence: **`settings.json` > `.env` > hardcoded default**. `settings.json` lives at `join(stateDir, 'settings.json')` (stateDir honors `STATE_DIR`).
- Every dynamic fragment sent to Telegram is `htmlEscape`d; every reply goes through `this.send()` (splits at 4096 chars). User-facing strings in English.
- Every handler is registered via `this.safe(...)`. `/settings` requires `authorize` + `requireArmed`. `/diag` keeps its existing gate (`authorize` only — unchanged).
- The command list lives in **four places** and must stay in sync: `setMyCommands` in `start()`, the `/help` string, `README.md` Usage table, `AI-GUIDE.md` Command reference.
- A new config option (`DEFAULT_EFFORT`) follows the five-file checklist: `src/config.ts`, `.env.example`, README Configuration table, `test/config.test.ts` (not `install.sh` — not a first-run choice).
- TypeScript `strict`. Tests use the existing per-module harnesses (no mocking library): `makeManager()`, `makeWatcher()`, `makeDriver()`, `loadConfig()`.
- Docs ship in the same commit as the code; add a `CHANGELOG.md` entry under `## [Unreleased]`.
- Commit to the working branch `feat/settings-diag`, never straight to `main`. Conventional Commits, one concern each.

---

### Task 1: `EffortLevel` type, `Session.effort`, manager support

**Files:**
- Modify: `src/types.ts` (add `EFFORT_LEVELS` + `EffortLevel`; add `effort?` to `Session`)
- Modify: `src/sessions/manager.ts` (`createHeadless`, `registerTerminal` accept and store `effort`)
- Test: `test/manager.test.ts`

**Interfaces:**
- Produces: `export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;` and `export type EffortLevel = (typeof EFFORT_LEVELS)[number];` in `src/types.ts`; `Session.effort?: EffortLevel`; `createHeadless(input: { title: string; projectDir: string; model?: string; permissionMode?: 'auto' | 'standard'; effort?: EffortLevel }): Session`; `registerTerminal(input: { title: string; projectDir: string; tmuxTarget?: string; model?: string; effort?: EffortLevel }): Session`. The manager persists the field only when provided; restored sessions from older `state.json` have `effort` undefined (safe default).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Add to `test/manager.test.ts` (inside the existing `describe('SessionManager')`, using the existing `makeManager()` harness):

```ts
it('stores effort on headless sessions when provided', () => {
  const { manager } = makeManager();
  const s = manager.createHeadless({ title: 't', projectDir: '/tmp/x', effort: 'high' });
  expect(s.effort).toBe('high');
  const plain = manager.createHeadless({ title: 'p', projectDir: '/tmp/p' });
  expect(plain.effort).toBeUndefined();
});
it('stores effort on terminal registration when provided', () => {
  const { manager } = makeManager();
  const s = manager.registerTerminal({ title: 'x', projectDir: '/tmp/x', tmuxTarget: 'claude:x', model: 'claude-sonnet-5', effort: 'low' });
  expect(s.effort).toBe('low');
  const plain = manager.registerTerminal({ title: 'y', projectDir: '/tmp/y', tmuxTarget: 'claude:y' });
  expect(plain.effort).toBeUndefined();
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/manager.test.ts`
Expected: FAIL — `s.effort` is `undefined`, type errors on the `effort` argument.

- [ ] **Step 3: Implement — `src/types.ts`**

At the top of `src/types.ts` (before `SessionKind`), add:

```ts
// Effort di ragionamento dei modelli che lo supportano (Claude nativo). Le
// sessioni terminali lo scoprono dalla riga di comando (`--reasoning-effort`),
// le headless lo ricevono da /new --effort (default DEFAULT_EFFORT). 'max' è
// riservato a pochi modelli e non è esposto qui: si sceglie esplicitamente via CLI.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
```

In the `Session` interface, directly after `model?: string;` add:

```ts
  effort?: EffortLevel;
```

- [ ] **Step 4: Implement — `src/sessions/manager.ts`**

Update the import line to include `EffortLevel`:

```ts
import type { Session, SessionKind, SessionStatus, EffortLevel } from '../types.js';
```

`createHeadless` input type and body:

```ts
  createHeadless(input: { title: string; projectDir: string; model?: string; permissionMode?: 'auto' | 'standard'; effort?: EffortLevel }): Session {
    const s = this.makeSession('headless', input.title, input.projectDir);
    if (input.model) s.model = input.model;
    if (input.effort) s.effort = input.effort;
    s.permissionMode = input.permissionMode ?? 'standard';
    this.state.sessions.push(s);
    this.emitUpdated(s.id);
    return s;
  }
```

`registerTerminal` input type and body:

```ts
  registerTerminal(input: { title: string; projectDir: string; tmuxTarget?: string; model?: string; effort?: EffortLevel }): Session {
    // dedupe: per target tmux se presente, altrimenti per project dir
    const existing = input.tmuxTarget
      ? this.findByTmuxTarget(input.tmuxTarget)
      : this.findByProjectDir(input.projectDir);
    if (existing) return existing;
    const s = this.makeSession('terminal', input.title, input.projectDir);
    if (input.tmuxTarget) s.tmuxTarget = input.tmuxTarget;
    if (input.model) s.model = input.model;
    if (input.effort) s.effort = input.effort;
    this.state.sessions.push(s);
    this.emitUpdated(s.id);
    return s;
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/manager.test.ts`
Expected: PASS (both new tests plus the existing ones).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/sessions/manager.ts test/manager.test.ts
git commit -m "feat: track reasoning effort per session"
```

---

### Task 2: `src/settings.ts` — validated JSON settings store

**Files:**
- Create: `src/settings.ts`
- Test: `test/settings.test.ts`

**Interfaces:**
- Produces:
  - `export interface UserSettings { defaultModel?: string; defaultPermissionMode?: 'auto' | 'standard'; maxHeadlessSessions?: number; permissionTimeoutSeconds?: number; armedOnStart?: boolean; noUpdateCheck?: boolean; defaultEffort?: EffortLevel; }`
  - `export const SETTINGS_KEYS: readonly ['defaultModel', 'defaultPermissionMode', 'maxHeadlessSessions', 'permissionTimeoutSeconds', 'armedOnStart', 'noUpdateCheck', 'defaultEffort']`
  - `export type SettingsKey = (typeof SETTINGS_KEYS)[number]`
  - `export function sanitizeSettings(raw: unknown): UserSettings` — keeps only known keys with valid values; invalid values are dropped (not errors).
  - `export function parseSettingsValue(key: SettingsKey, value: string): { ok: true; settings: Partial<UserSettings> } | { ok: false; error: string }` — validates one key/value pair for `/settings set`, with a readable error.
  - `export class SettingsStore { constructor(filePath: string); load(): UserSettings; save(settings: UserSettings): void }` — atomic write (tmp+rename), corrupt file preserved as `.corrupt-<ts>` and reloaded as `{}`.
- Consumes: `EffortLevel`, `EFFORT_LEVELS` from `src/types.js`.

- [ ] **Step 1: Write the failing tests**

Create `test/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, sanitizeSettings, parseSettingsValue } from '../src/settings.js';

describe('sanitizeSettings', () => {
  it('keeps only known keys with valid values', () => {
    expect(sanitizeSettings({
      defaultModel: 'claude-opus-5',
      defaultPermissionMode: 'auto',
      maxHeadlessSessions: 3,
      permissionTimeoutSeconds: 30,
      armedOnStart: true,
      noUpdateCheck: true,
      defaultEffort: 'high',
      junk: 1,
    })).toEqual({
      defaultModel: 'claude-opus-5',
      defaultPermissionMode: 'auto',
      maxHeadlessSessions: 3,
      permissionTimeoutSeconds: 30,
      armedOnStart: true,
      noUpdateCheck: true,
      defaultEffort: 'high',
    });
  });
  it('drops invalid values instead of erroring', () => {
    expect(sanitizeSettings({ defaultPermissionMode: 'yolo', maxHeadlessSessions: -2, permissionTimeoutSeconds: 'fast', defaultEffort: 'ultra', armedOnStart: 'yes' })).toEqual({});
  });
  it('returns {} for non-objects', () => {
    expect(sanitizeSettings(null)).toEqual({});
    expect(sanitizeSettings([1, 2])).toEqual({});
  });
});

describe('parseSettingsValue', () => {
  it('parses every curated key', () => {
    expect(parseSettingsValue('defaultModel', ' claude-opus-5 ')).toEqual({ ok: true, settings: { defaultModel: 'claude-opus-5' } });
    expect(parseSettingsValue('defaultPermissionMode', 'auto')).toEqual({ ok: true, settings: { defaultPermissionMode: 'auto' } });
    expect(parseSettingsValue('maxHeadlessSessions', '3')).toEqual({ ok: true, settings: { maxHeadlessSessions: 3 } });
    expect(parseSettingsValue('permissionTimeoutSeconds', '30')).toEqual({ ok: true, settings: { permissionTimeoutSeconds: 30 } });
    expect(parseSettingsValue('armedOnStart', 'true')).toEqual({ ok: true, settings: { armedOnStart: true } });
    expect(parseSettingsValue('noUpdateCheck', 'false')).toEqual({ ok: true, settings: { noUpdateCheck: false } });
    expect(parseSettingsValue('defaultEffort', 'high')).toEqual({ ok: true, settings: { defaultEffort: 'high' } });
  });
  it('rejects invalid values with a readable error', () => {
    expect(parseSettingsValue('defaultPermissionMode', 'yolo').ok).toBe(false);
    expect(parseSettingsValue('maxHeadlessSessions', 'many').ok).toBe(false);
    expect(parseSettingsValue('armedOnStart', '1').ok).toBe(false);
    expect(parseSettingsValue('defaultEffort', 'max').ok).toBe(false); // 'max' non è esposto
  });
});

describe('SettingsStore', () => {
  it('returns {} when the file does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-settings-'));
    const store = new SettingsStore(join(dir, 'settings.json'));
    expect(store.load()).toEqual({});
  });
  it('saves atomically and loads back what was written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-settings-'));
    const path = join(dir, 'settings.json');
    const store = new SettingsStore(path);
    store.save({ defaultModel: 'claude-opus-5', defaultEffort: 'high' });
    expect(existsSync(path)).toBe(true);
    expect(store.load()).toEqual({ defaultModel: 'claude-opus-5', defaultEffort: 'high' });
  });
  it('preserves a corrupt file as a .corrupt- copy and starts from empty settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orc-settings-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, '{ not json');
    const store = new SettingsStore(path);
    expect(store.load()).toEqual({});
    expect(readFileSync(path, 'utf8')).not.toContain('not json'); // l'originale è stato spostato
    expect(readdirSync(dir).some(f => f.startsWith('settings.json.corrupt-'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/settings.test.ts`
Expected: FAIL — module `../src/settings.js` not found.

- [ ] **Step 3: Implement `src/settings.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { EFFORT_LEVELS, type EffortLevel } from './types.js';

// Settaggi utente modificabili da /settings. Chiavi note a SETTINGS_KEYS; ogni
// valore è validato (sanitizeSettings) sia in lettura dal file sia prima della
// scrittura. Precedenza: settings.json > .env > default (vedi loadConfig).
export interface UserSettings {
  defaultModel?: string;
  defaultPermissionMode?: 'auto' | 'standard';
  maxHeadlessSessions?: number;
  permissionTimeoutSeconds?: number;
  armedOnStart?: boolean;
  noUpdateCheck?: boolean;
  defaultEffort?: EffortLevel;
}

export const SETTINGS_KEYS = [
  'defaultModel',
  'defaultPermissionMode',
  'maxHeadlessSessions',
  'permissionTimeoutSeconds',
  'armedOnStart',
  'noUpdateCheck',
  'defaultEffort',
] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parsePositiveInt(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return undefined;
  return v;
}

// Tiene solo le chiavi note con un valore valido; il resto cade (su .env o
// default). Un valore invalido NON è un errore del file: è un valore da
// ignorare, il file resta leggibile.
export function sanitizeSettings(raw: unknown): UserSettings {
  if (!isRecord(raw)) return {};
  const out: UserSettings = {};
  if (typeof raw.defaultModel === 'string' && raw.defaultModel.trim()) out.defaultModel = raw.defaultModel.trim();
  if (raw.defaultPermissionMode === 'auto' || raw.defaultPermissionMode === 'standard') out.defaultPermissionMode = raw.defaultPermissionMode;
  const max = parsePositiveInt(raw.maxHeadlessSessions);
  if (max !== undefined) out.maxHeadlessSessions = max;
  const timeout = parsePositiveInt(raw.permissionTimeoutSeconds);
  if (timeout !== undefined) out.permissionTimeoutSeconds = timeout;
  if (typeof raw.armedOnStart === 'boolean') out.armedOnStart = raw.armedOnStart;
  if (typeof raw.noUpdateCheck === 'boolean') out.noUpdateCheck = raw.noUpdateCheck;
  if (typeof raw.defaultEffort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(raw.defaultEffort)) out.defaultEffort = raw.defaultEffort as EffortLevel;
  return out;
}

// Valida una singola chiave dall'argomento di /settings, con un errore
// leggibile per l'utente. `value` è il testo grezzo inviato da Telegram.
export function parseSettingsValue(key: SettingsKey, value: string):
  | { ok: true; settings: Partial<UserSettings> }
  | { ok: false; error: string } {
  const v = value.trim();
  switch (key) {
    case 'defaultModel':
      return v ? { ok: true, settings: { defaultModel: v } } : { ok: false, error: 'expected a non-empty model name' };
    case 'defaultPermissionMode':
      return v === 'auto' || v === 'standard'
        ? { ok: true, settings: { defaultPermissionMode: v } }
        : { ok: false, error: 'expected "auto" or "standard"' };
    case 'maxHeadlessSessions':
    case 'permissionTimeoutSeconds': {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) return { ok: true, settings: { [key]: n } as Partial<UserSettings> };
      return { ok: false, error: 'expected a positive integer' };
    }
    case 'armedOnStart':
    case 'noUpdateCheck':
      if (v === 'true' || v === 'false') return { ok: true, settings: { [key]: v === 'true' } as Partial<UserSettings> };
      return { ok: false, error: 'expected "true" or "false"' };
    case 'defaultEffort':
      return (EFFORT_LEVELS as readonly string[]).includes(v)
        ? { ok: true, settings: { defaultEffort: v as EffortLevel } }
        : { ok: false, error: `expected one of ${EFFORT_LEVELS.join(', ')}` };
  }
}

// Lettura + scrittura atomica di settings.json, stesso pattern di state.ts:
// un file corrotto viene preservato come .corrupt-<ts> e si riparte da vuoto
// (il /settings lo riscriverebbe comunque, ma il vecchio contenuto non va
// perso in silenzio).
export class SettingsStore {
  constructor(private filePath: string) {}

  load(): UserSettings {
    if (!existsSync(this.filePath)) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch {
      this.preserveCorrupt();
      return {};
    }
    return sanitizeSettings(parsed);
  }

  private preserveCorrupt(): void {
    const backup = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      renameSync(this.filePath, backup);
      console.error(`claude-omni-rc: unreadable ${this.filePath} — kept a copy at ${backup}, starting from empty settings.`);
    } catch (e) {
      console.error(`claude-omni-rc: unreadable ${this.filePath} and could not back it up:`, e);
    }
  }

  save(settings: UserSettings): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(sanitizeSettings(settings), null, 2) + '\n', 'utf8');
      renameSync(tmp, this.filePath);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* già sparito */ }
      throw e;
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts test/settings.test.ts
git commit -m "feat: validated settings.json store for /settings"
```

---

### Task 3: `loadConfig()` merges settings over env; `defaultEffort`; `settingsFile`

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `UserSettings` and `sanitizeSettings` from `./settings.js`; `EffortLevel`, `EFFORT_LEVELS` from `./types.js`.
- Produces: `Config.defaultEffort: EffortLevel`; `Config.settingsFile: string`; `export function resolveStateDir(env: NodeJS.ProcessEnv): string`; `loadConfig(env: NodeJS.ProcessEnv = process.env, settings: UserSettings = {}): Config` with precedence `settings > env > default` for the curated keys.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.ts` (after the existing `loadConfig — logging` describe):

```ts
describe('loadConfig — settings.json layer', () => {
  it('lets settings override env, and env override defaults', () => {
    const c = loadConfig({ DEFAULT_MODEL: 'from-env', DEFAULT_PERMISSION_MODE: 'standard' }, { defaultModel: 'from-settings', maxHeadlessSessions: 7 });
    expect(c.defaultModel).toBe('from-settings');
    expect(c.maxHeadlessSessions).toBe(7);
    expect(c.defaultPermissionMode).toBe('standard'); // non toccato dal settings → .env
  });
  it('ignores invalid settings values and falls back to env/default', () => {
    const c = loadConfig({ DEFAULT_MODEL: 'from-env' }, { defaultPermissionMode: 'yolo', defaultEffort: 'ultra' } as never);
    expect(c.defaultPermissionMode).toBe('standard');
    expect(c.defaultEffort).toBe('medium');
    expect(c.defaultModel).toBe('from-env');
  });
  it('defaults defaultEffort to medium and parses a valid env value', () => {
    expect(loadConfig({}).defaultEffort).toBe('medium');
    expect(loadConfig({ DEFAULT_EFFORT: 'high' }).defaultEffort).toBe('high');
    expect(loadConfig({ DEFAULT_EFFORT: 'max' }).defaultEffort).toBe('medium'); // 'max' non è esposto
  });
  it('applies settings to every curated key', () => {
    const c = loadConfig({}, {
      defaultPermissionMode: 'auto', permissionTimeoutSeconds: 45, armedOnStart: true, noUpdateCheck: true, defaultEffort: 'low',
    });
    expect(c.defaultPermissionMode).toBe('auto');
    expect(c.permissionTimeoutSeconds).toBe(45);
    expect(c.armedOnStart).toBe(true);
    expect(c.noUpdateCheck).toBe(true);
    expect(c.defaultEffort).toBe('low');
  });
  it('exposes the settings file path under the state dir', () => {
    expect(loadConfig({}).settingsFile).toBe(`${process.env.HOME}/.claude-omni-rc/settings.json`);
    expect(loadConfig({ STATE_DIR: '/tmp/orc' }).settingsFile).toBe('/tmp/orc/settings.json');
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — `defaultEffort`/`settingsFile` missing on `Config`, second argument ignored.

- [ ] **Step 3: Implement — `src/config.ts`**

Update the imports:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOG_LEVELS, type LogLevel } from './log.js';
import { sanitizeSettings, type UserSettings } from './settings.js';
import { EFFORT_LEVELS, type EffortLevel } from './types.js';
```

Add to the `Config` interface (after `defaultPermissionMode`):

```ts
  // Effort di ragionamento di default per le sessioni headless (/new --effort
  // lo sovrascrive per sessione). Vale per i modelli che lo supportano (Claude
  // nativo); gli altri lo ignorano.
  defaultEffort: EffortLevel;
```

and (after `logKeep`):

```ts
  // Percorso del file settings.json (le chiavi curate di /settings, con
  // precedenza su .env: vedi loadConfig).
  settingsFile: string;
```

Extract the stateDir computation into an exported helper and use it in `loadConfig`:

```ts
export function resolveStateDir(env: NodeJS.ProcessEnv): string {
  return expandHome(env.STATE_DIR ?? '~/.claude-omni-rc');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, settings: UserSettings = {}): Config {
  const s = sanitizeSettings(settings);
  const stateDir = resolveStateDir(env);
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? '',
    allowedUserIds: (env.ALLOWED_USER_IDS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean).map(Number),
    pairingCode: env.PAIRING_CODE || undefined,
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
    defaultModel: s.defaultModel ?? env.DEFAULT_MODEL ?? 'deepseek-v4-flash:cloud',
    defaultPermissionMode: s.defaultPermissionMode ?? (env.DEFAULT_PERMISSION_MODE === 'auto' ? 'auto' : 'standard'),
    defaultEffort: s.defaultEffort
      ?? ((EFFORT_LEVELS as readonly string[]).includes(env.DEFAULT_EFFORT ?? '') ? env.DEFAULT_EFFORT as EffortLevel : 'medium'),
    maxHeadlessSessions: s.maxHeadlessSessions ?? parseNum(env, 'MAX_HEADLESS_SESSIONS', 2),
    permissionTimeoutSeconds: s.permissionTimeoutSeconds ?? parseNum(env, 'PERMISSION_TIMEOUT_SECONDS', 120),
    workspaceDirs: (env.WORKSPACE_DIRS ?? '').split(':').map(s => expandHome(s.trim())).filter(Boolean),
    stateDir,
    inboxDir: env.INBOX_DIR ?? join(stateDir, 'inbox'),
    projectsDir: expandHome(env.PROJECTS_DIR ?? '~/.claude/projects'),
    apiPort: parseNum(env, 'API_PORT', 4123),
    armedOnStart: s.armedOnStart ?? env.ARMED_ON_START === 'true',
    idleGraceMs: parseNum(env, 'IDLE_GRACE_MS', 3000),
    pollIntervalMs: parseNum(env, 'POLL_INTERVAL_MS', 500),
    cwdRefreshMs: parseNum(env, 'CWD_REFRESH_MS', 10_000),
    noUpdateCheck: s.noUpdateCheck ?? Boolean(env.CLAUDE_OMNI_RC_NO_UPDATE_CHECK),
    logLevel: parseLevel(env, 'LOG_LEVEL', 'info'),
    logFile: expandHome(env.LOG_FILE ?? join(stateDir, 'logs', 'daemon.jsonl')),
    logMaxBytes: parseNum(env, 'LOG_MAX_BYTES', 5_000_000),
    logKeep: parseNum(env, 'LOG_KEEP', 3),
    settingsFile: join(stateDir, 'settings.json'),
  };
}
```

- [ ] **Step 4: Implement — `.env.example`**

Insert after the `DEFAULT_PERMISSION_MODE` block:

```
# Reasoning effort for headless /new sessions when no --effort flag is given
# (per-session: /new --effort). One of: low | medium | high | xhigh.
DEFAULT_EFFORT=medium
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/config.test.ts`
Expected: PASS (new describe plus the existing ones).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts .env.example test/config.test.ts
git commit -m "feat(config): settings.json layer over .env + DEFAULT_EFFORT"
```

---

### Task 4: daemon wiring — settings loaded at boot, `SettingsStore` into the bot

**Files:**
- Modify: `src/daemon.ts`
- Modify: `bot/telegram.ts` (only the `BotDeps` interface + import in this task; the handler comes in Task 5)
- Test: `test/daemon.test.ts` (no change expected — verify it still passes)

**Interfaces:**
- Consumes: `SettingsStore` from `./settings.js`; `resolveStateDir` from `./config.js`.
- Produces: `createDaemon(config, overrides: { bot?: Pick<TelegramBot, 'start' | 'stop' | 'notify'>; settingsStore?: SettingsStore }): Daemon`; the real bot is constructed with `settingsStore` in its deps; `BotDeps.settingsStore: SettingsStore`.

- [ ] **Step 1: Implement — `src/daemon.ts`**

Add to the imports:

```ts
import { SettingsStore } from './settings.js';
```

Add `settingsStore` to the `overrides` type and construct the bot with it (in `createDaemon`, replacing the `const bot = overrides.bot ?? new TelegramBot(...)` line):

```ts
export function createDaemon(
  config: Config,
  overrides: { bot?: Pick<TelegramBot, 'start' | 'stop' | 'notify'>; settingsStore?: SettingsStore } = {},
): Daemon {
```

and, just above the `const bot = ...` line:

```ts
  const settingsStore = overrides.settingsStore ?? new SettingsStore(config.settingsFile);
```

then:

```ts
  const bot = overrides.bot ?? new TelegramBot({ config, bus, manager, permissionFlow, dialogFlow, sdk, tmux, inbox, ollama, settingsStore });
```

In the `isMain` block, replace:

```ts
  const daemon = createDaemon(loadConfig());
```

with:

```ts
  const settingsStore = new SettingsStore(join(resolveStateDir(process.env), 'settings.json'));
  const daemon = createDaemon(loadConfig(process.env, settingsStore.load()), { settingsStore });
```

and extend the startup log record with the settings file:

```ts
  log().info('daemon starting', {
    version: CURRENT_VERSION,
    pid: process.pid,
    apiPort: config.apiPort,
    armedOnStart: config.armedOnStart,
    stateDir: config.stateDir,
    settingsFile: config.settingsFile,
  });
```

- [ ] **Step 2: Implement — `bot/telegram.ts` (`BotDeps` only)**

Add the import:

```ts
import type { SettingsStore } from '../src/settings.js';
```

Add to the `BotDeps` interface (after `ollama: OllamaClient;`):

```ts
  settingsStore: SettingsStore;
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run test/daemon.test.ts && npx vitest run test/api.test.ts`
Expected: PASS — daemon tests inject a fake bot, so they don't construct `TelegramBot`; no assertion depends on the settings store.

- [ ] **Step 4: Commit**

```bash
git add src/daemon.ts bot/telegram.ts
git commit -m "feat: wire SettingsStore into the daemon and the bot"
```

---

### Task 5: `/settings` command — pure functions, handler, registration

**Files:**
- Modify: `bot/telegram.ts`
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `SETTINGS_KEYS`, `parseSettingsValue`, `type SettingsKey`, `type UserSettings` from `../src/settings.js`; `Config` (already imported).
- Produces (all exported from `bot/telegram.ts`):
  - `export type SettingsCommand = { kind: 'all' } | { kind: 'show'; key: SettingsKey } | { kind: 'set'; key: SettingsKey; value: string } | { kind: 'reset'; key: SettingsKey } | { kind: 'invalid'; reason: string }`
  - `export function parseSettingsCommand(raw: string): SettingsCommand`
  - `export const SETTINGS_LABELS: Record<SettingsKey, string>`
  - `export function formatSettingsReport(settings: UserSettings, config: Config): string`
  - `export function formatSettingsKey(key: SettingsKey, settings: UserSettings, config: Config): string`

- [ ] **Step 1: Write the failing tests**

Add to `test/telegram.test.ts` (after the `parseNewFlags` describe). Update the big import line at the top of the file to include `parseSettingsCommand, formatSettingsReport, formatSettingsKey` (append them to the existing `from '../bot/telegram.js'` import list), and add a new line `import { loadConfig } from '../src/config.js';` (it is not currently imported).

```ts
describe('parseSettingsCommand', () => {
  it('returns all for an empty argument', () => {
    expect(parseSettingsCommand('')).toEqual({ kind: 'all' });
    expect(parseSettingsCommand('   ')).toEqual({ kind: 'all' });
  });
  it('shows a single known key', () => {
    expect(parseSettingsCommand('defaultModel')).toEqual({ kind: 'show', key: 'defaultModel' });
  });
  it('sets a value, joining the rest of the line', () => {
    expect(parseSettingsCommand('defaultModel claude-opus-5')).toEqual({ kind: 'set', key: 'defaultModel', value: 'claude-opus-5' });
    expect(parseSettingsCommand('maxHeadlessSessions 3')).toEqual({ kind: 'set', key: 'maxHeadlessSessions', value: '3' });
  });
  it('resets a key', () => {
    expect(parseSettingsCommand('reset defaultEffort')).toEqual({ kind: 'reset', key: 'defaultEffort' });
  });
  it('rejects an unknown key with the known list', () => {
    const c = parseSettingsCommand('bogus');
    expect(c.kind).toBe('invalid');
  });
  it('rejects a reset without a known key', () => {
    expect(parseSettingsCommand('reset').kind).toBe('invalid');
    expect(parseSettingsCommand('reset bogus').kind).toBe('invalid');
  });
});

describe('formatSettingsReport', () => {
  const config = loadConfig({}, { defaultModel: 'claude-opus-5' });
  it('lists every curated key with its effective value and source', () => {
    const out = formatSettingsReport({ defaultModel: 'claude-opus-5' }, config);
    expect(out).toContain('defaultModel');
    expect(out).toContain('claude-opus-5');
    expect(out).toContain('settings.json');
  });
  it('marks keys that come from .env / default and escapes dynamic values', () => {
    const out = formatSettingsReport({}, config);
    expect(out).toContain('.env / default');
    expect(out).toContain('next daemon restart');
    expect(out).not.toContain('<script>');
  });
  it('formats a single key via formatSettingsKey', () => {
    const out = formatSettingsKey('defaultEffort', {}, config);
    expect(out).toContain('defaultEffort');
    expect(out).toContain('/settings reset defaultEffort');
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/telegram.test.ts`
Expected: FAIL — functions not exported / not defined.

- [ ] **Step 3: Implement the pure functions — `bot/telegram.ts`**

Add to the imports (the `../src/types.js` type-import line gains `EffortLevel`, and two new import lines are added — `EFFORT_LEVELS` is a value and must NOT go inside the `import type` line):

```ts
import type { Session, SessionKind, SessionStatus, PermissionRequest, PromptQuestion, PromptAnswer, UserDialog, EffortLevel } from '../src/types.js';
import { EFFORT_LEVELS } from '../src/types.js';
import { SETTINGS_KEYS, parseSettingsValue, type SettingsKey, type UserSettings } from '../src/settings.js';
```

(Keep the existing `import type { ... } from '../src/types.js'` line and extend its list with `EffortLevel`; add the two new import statements after it. `EFFORT_LEVELS` is used by `parseNewFlags` in Task 6.)

Add these functions after `parseNewFlags` (before `resolveHeadlessProjectDir`):

```ts
// ---------- /settings ----------

// Sottoinsieme delle chiavi curate (SettingsStore) con una riga leggibile per
// il report. La fonte si deriva dal contenuto del file: settings[key] presente
// → 'settings.json', assente → '.env / default' (il config è già fuso).
export const SETTINGS_LABELS: Record<SettingsKey, string> = {
  defaultModel: 'default model for headless sessions',
  defaultPermissionMode: 'permission mode for /new without a flag',
  maxHeadlessSessions: 'concurrent headless sessions',
  permissionTimeoutSeconds: 'unanswered permission denies after (seconds)',
  armedOnStart: 'arm the remote control on daemon start',
  noUpdateCheck: 'disable the daily GitHub release check',
  defaultEffort: 'reasoning effort for headless sessions',
};

export type SettingsCommand =
  | { kind: 'all' }
  | { kind: 'show'; key: SettingsKey }
  | { kind: 'set'; key: SettingsKey; value: string }
  | { kind: 'reset'; key: SettingsKey }
  | { kind: 'invalid'; reason: string };

export function parseSettingsCommand(raw: string): SettingsCommand {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'all' };
  if (tokens[0] === 'reset') {
    const key = tokens[1] as SettingsKey;
    if (tokens.length !== 2 || !(SETTINGS_KEYS as readonly string[]).includes(key)) {
      return { kind: 'invalid', reason: `expected /settings reset <key>; known keys: ${SETTINGS_KEYS.join(', ')}` };
    }
    return { kind: 'reset', key };
  }
  const key = tokens[0] as SettingsKey;
  if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
    return { kind: 'invalid', reason: `unknown setting "${tokens[0]}"; known keys: ${SETTINGS_KEYS.join(', ')}` };
  }
  if (tokens.length === 1) return { kind: 'show', key };
  return { kind: 'set', key, value: tokens.slice(1).join(' ') };
}

function settingsLine(key: SettingsKey, settings: UserSettings, config: Config): string {
  const value = String(config[key]);
  const source = settings[key] !== undefined ? 'settings.json' : '.env / default';
  return `<code>${htmlEscape(key)}</code> = <code>${htmlEscape(value)}</code> <i>(${htmlEscape(source)})</i> — ${htmlEscape(SETTINGS_LABELS[key])}`;
}

export function formatSettingsReport(settings: UserSettings, config: Config): string {
  const rows = SETTINGS_KEYS.map(key => settingsLine(key, settings, config)).join('\n');
  return `<b>Settings</b>\n${rows}\n\n<i>Changes apply at the next daemon restart.</i>`;
}

export function formatSettingsKey(key: SettingsKey, settings: UserSettings, config: Config): string {
  return `${settingsLine(key, settings, config)}\n\nSet it: <code>/settings ${htmlEscape(key)} &lt;value&gt;</code> · reset: <code>/settings reset ${htmlEscape(key)}</code>`;
}
```

- [ ] **Step 4: Implement the handler and registration — `bot/telegram.ts`**

Add the handler method (near `onNew`, after `onStatus` is fine — place it right before `onNew`):

```ts
  private async onSettings(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const raw = ctx.match?.toString().trim() ?? '';
    const cmd = parseSettingsCommand(raw);
    const settings = this.deps.settingsStore.load();
    switch (cmd.kind) {
      case 'all':
        await this.send(ctx, formatSettingsReport(settings, this.deps.config));
        return;
      case 'show':
        await this.send(ctx, formatSettingsKey(cmd.key, settings, this.deps.config));
        return;
      case 'set': {
        const parsed = parseSettingsValue(cmd.key, cmd.value);
        if (!parsed.ok) {
          await this.send(ctx, `❌ Invalid value for <code>${htmlEscape(cmd.key)}</code>: ${htmlEscape(parsed.error)}.`);
          return;
        }
        const next = { ...settings, ...parsed.settings };
        this.deps.settingsStore.save(next);
        await this.send(ctx, `✅ <code>${htmlEscape(cmd.key)}</code> = <code>${htmlEscape(cmd.value.trim())}</code> saved. Applies at the next daemon restart.`);
        return;
      }
      case 'reset': {
        const next = { ...settings };
        delete next[cmd.key];
        this.deps.settingsStore.save(next);
        await this.send(ctx, `↩️ <code>${htmlEscape(cmd.key)}</code> reset to the .env / default value. Applies at the next daemon restart.`);
        return;
      }
      case 'invalid':
        await this.send(ctx, `❌ ${htmlEscape(cmd.reason)}`);
        return;
    }
  }
```

In `register()`, add after the `usage` line:

```ts
    bot.command('settings', ctx => this.safe(ctx, 'settings', () => this.onSettings(ctx)));
```

In `start()` → `setMyCommands([...])`, add after the `usage` entry:

```ts
      { command: 'settings', description: 'View / change user settings' },
```

In the `/help` handler, extend the string to:

```ts
      await this.send(ctx, 'Commands: /rc [on|off|status] (no arg toggles) · /sessions · /view · /new &lt;text&gt; · /stop · /status · /attach &lt;project&gt; · /history [id] · /delete [id] · /usage · /diag · /settings · /help');
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat(bot): add /settings command"
```

---

### Task 6: `/new --effort <level>` flag

**Files:**
- Modify: `bot/telegram.ts` (`parseNewFlags`, `onNew`, the two usage strings)
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `EFFORT_LEVELS`, `EffortLevel` (imported in Task 5); `config.defaultEffort`.
- Produces: `parseNewFlags(raw: string): { mode?: 'auto' | 'standard'; model?: string; effort?: EffortLevel; text: string }`.

- [ ] **Step 1: Write the failing test**

Add to the existing `describe('parseNewFlags')` block:

```ts
  it('parses --effort alongside the other flags, in any order', () => {
    expect(parseNewFlags('--effort high think')).toEqual({ effort: 'high', text: 'think' });
    expect(parseNewFlags('--standard --effort low go')).toEqual({ mode: 'standard', effort: 'low', text: 'go' });
    expect(parseNewFlags('--effort ultra think')).toEqual({ text: '--effort ultra think' }); // livello invalido → flag non consumato
  });
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/telegram.test.ts -t "parseNewFlags"`
Expected: FAIL — `effort` is `undefined` in the parsed result.

- [ ] **Step 3: Implement — `bot/telegram.ts`**

Replace `parseNewFlags` with:

```ts
// Flag in testa di /new, in qualsiasi ordine: --auto/--standard (permessi),
// --model <name> (modello per questa sessione) e --effort <level> (effort di
// ragionamento). `mode`/`effort` restano undefined se nessun flag è presente:
// i default li decide la config (DEFAULT_PERMISSION_MODE / DEFAULT_EFFORT),
// non il parser.
export function parseNewFlags(raw: string): { mode?: 'auto' | 'standard'; model?: string; effort?: EffortLevel; text: string } {
  let mode: 'auto' | 'standard' | undefined;
  let model: string | undefined;
  let effort: EffortLevel | undefined;
  let text = raw.trim();
  for (;;) {
    const modeFlag = text.match(/^--(auto|standard)(?:\s+|$)/);
    if (modeFlag) {
      mode = modeFlag[1] === 'standard' ? 'standard' : 'auto';
      text = text.slice(modeFlag[0].length).trim();
      continue;
    }
    const modelFlag = text.match(/^--model\s+(\S+)(?:\s+|$)/);
    if (modelFlag) {
      model = modelFlag[1];
      text = text.slice(modelFlag[0].length).trim();
      continue;
    }
    const effortFlag = text.match(/^--effort\s+(\S+)(?:\s+|$)/);
    if (effortFlag && (EFFORT_LEVELS as readonly string[]).includes(effortFlag[1])) {
      effort = effortFlag[1] as EffortLevel;
      text = text.slice(effortFlag[0].length).trim();
      continue;
    }
    break;
  }
  return { ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}), text };
}
```

In `onNew`, change the destructure and the `createHeadless` call:

```ts
    const { mode, model, effort, text } = parseNewFlags(raw);
```

```ts
    const session = this.deps.manager.createHeadless({
      title: text.slice(0, 40), projectDir, model: model ?? this.deps.config.defaultModel,
      permissionMode, effort: effort ?? this.deps.config.defaultEffort,
    });
```

Update both usage strings in `onNew` (the `!raw` branch and the `!text` branch) to:

```ts
      await this.send(ctx, 'Usage: /new [--auto|--standard] [--model &lt;name&gt;] [--effort &lt;level&gt;] &lt;text&gt;');
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat(bot): /new --effort for headless sessions"
```

---

### Task 7: SDK driver passes `effort` to `query()`

**Files:**
- Modify: `src/sessions/sdk-driver.ts`
- Test: `test/sdk-driver.test.ts`

**Interfaces:**
- Consumes: `Session.effort` (Task 1), the SDK `query({ prompt, options })` shape.
- Produces: `options.effort` present in the `query()` call when `session.effort` is set; absent otherwise. The SDK ignores/downgrades the effort for models that don't support it — that's SDK behavior, not ours.

- [ ] **Step 1: Write the failing tests**

Add to `test/sdk-driver.test.ts` (using the existing `makeDriver()` harness, `assistantText`, `resultMsg` and the `queryMock`):

```ts
  it('passes the session effort to the SDK query options', async () => {
    const { sdk, session } = makeDriver();
    const s = session; // sessione base senza effort; creiamone una con effort esplicito
    queryMock.mockImplementationOnce(async function* () { yield resultMsg(s.id, 'ok'); });
    await sdk.runTurn(s.id, 'hello');
    expect(queryMock.mock.calls[0][0].options.effort).toBeUndefined();

    queryMock.mockReset();
    const { sdk: sdk2, manager } = makeDriver();
    const withEffort = manager.createHeadless({ title: 't', projectDir: '/tmp/x', model: 'm', effort: 'high' });
    queryMock.mockImplementationOnce(async function* () { yield resultMsg(withEffort.id, 'ok'); });
    await sdk2.runTurn(withEffort.id, 'hello');
    expect(queryMock.mock.calls[0][0].options.effort).toBe('high');
  });
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/sdk-driver.test.ts`
Expected: FAIL — `options.effort` is `undefined` for the `effort: 'high'` session.

- [ ] **Step 3: Implement — `src/sessions/sdk-driver.ts`**

In the `query({ prompt, options: { ... } })` call, after the `additionalDirectories: [config.inboxDir],` line, add:

```ts
          // Effort di ragionamento (se la sessione ne ha uno — default
          // DEFAULT_EFFORT per le headless). L'SDK lo ignora/declassa per i
          // modelli che non lo supportano: comportamento SDK, non nostro.
          ...(session.effort ? { effort: session.effort } : {}),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/sdk-driver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessions/sdk-driver.ts test/sdk-driver.test.ts
git commit -m "feat: pass reasoning effort to headless SDK queries"
```

---

### Task 8: discover effort for terminal sessions (`claudeEffort` + watcher)

**Files:**
- Modify: `src/sessions/tmux-inject.ts`
- Modify: `src/sessions/tmux-watcher.ts`
- Test: `test/tmux-inject.test.ts`, `test/tmux-watcher.test.ts`

**Interfaces:**
- Consumes: `EFFORT_LEVELS`, `EffortLevel` from `../types.js`; `ProcessTree` (already in the module).
- Produces: `TmuxClient.claudeEffort(target: string, tree?: ProcessTree): Promise<EffortLevel | undefined>`; `WatcherDeps.tmux` Pick gains `'claudeEffort'`; the watcher passes `effort` to `manager.registerTerminal(...)` at registration (same spot as `model`).

- [ ] **Step 1: Write the failing tests**

Add to `test/tmux-inject.test.ts`, after the `TmuxClient.claudeModel` describe, mirroring its fixtures (the `exec` mock answers `list-sessions` and `display-message`; the `sh` mock answers the `ps -o args=` call):

```ts
describe('TmuxClient.claudeEffort', () => {
  it('parses --reasoning-effort from the claude process command line', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected tmux call: ' + args.join(' '));
    };
    const sh: any = async (cmd: string, args: string[]) => {
      if (cmd === 'ps' && args[0] === '-o' && args[1] === 'args=') return { code: 0, stdout: '/Users/u/.local/bin/claude --model claude-sonnet-5 --reasoning-effort high\n', stderr: '' };
      if (cmd === 'ps') return { code: 0, stdout: '100 1 -zsh\n200 100 ollama\n300 200 /Users/u/.local/bin/claude\n', stderr: '' };
      throw new Error('unexpected sh call: ' + cmd);
    };
    const client = new TmuxClient(exec, sh);
    await expect(client.claudeEffort('claude:proj')).resolves.toBe('high');
  });
  it('returns undefined when the process has no --reasoning-effort', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected');
    };
    const sh: any = async (cmd: string, args: string[]) => {
      if (cmd === 'ps' && args[0] === '-o' && args[1] === 'args=') return { code: 0, stdout: '/Users/u/.local/bin/claude\n', stderr: '' };
      if (cmd === 'ps') return { code: 0, stdout: '100 1 -zsh\n200 100 ollama\n300 200 /Users/u/.local/bin/claude\n', stderr: '' };
      throw new Error('unexpected sh call: ' + cmd);
    };
    const client = new TmuxClient(exec, sh);
    await expect(client.claudeEffort('claude:proj')).resolves.toBeUndefined();
  });
});
```

Add to `test/tmux-watcher.test.ts` — extend the base `tmux` mock in `makeWatcher` with one line (after `claudeModel`):

```ts
    claudeEffort: vi.fn(async (_t: string, _tree?: unknown): Promise<string | undefined> => undefined), // default: nessun --reasoning-effort leggibile
```

and add a test after the existing `records the claude --model on registration when readable` test:

```ts
  it('records the claude --reasoning-effort on registration when readable', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1']);
    tmux.claudeEffort.mockResolvedValue('high');
    manager.setArmed(true);
    await (watcher as any).poll();
    const s1 = manager.findByTmuxTarget('claude:proj1');
    expect(s1?.effort).toBe('high');
  });
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/tmux-inject.test.ts test/tmux-watcher.test.ts`
Expected: FAIL — `claudeEffort` not a function / not on the type.

- [ ] **Step 3: Implement — `src/sessions/tmux-inject.ts`**

Add to the imports:

```ts
import { EFFORT_LEVELS, type EffortLevel } from '../types.js';
```

Add `claudeEffort` directly after `claudeModel` (same `ps -o args=` technique; the method's closing brace is the one right before the `injectText` comment block):

```ts
  // Effort di ragionamento del processo claude nel pane, letto dalla riga di
  // comando (`claude --reasoning-effort <livello>`). undefined se il processo
  // non c'è o non ha il flag → /diag mostra '—'. Stessa tecnica e stesso
  // best-effort di claudeModel.
  async claudeEffort(target: string, tree?: ProcessTree): Promise<EffortLevel | undefined> {
    try {
      const pid = await this.findClaudePid(target, tree);
      if (!pid) return undefined;
      const ps = await this.sh('ps', ['-o', 'args=', '-p', pid]);
      if (ps.code !== 0) return undefined;
      const m = ps.stdout.match(/(?:^|\s)--reasoning-effort\s+(\S+)/);
      const raw = m ? m[1] : undefined;
      return raw && (EFFORT_LEVELS as readonly string[]).includes(raw) ? raw as EffortLevel : undefined;
    } catch {
      return undefined;
    }
  }
```

- [ ] **Step 4: Implement — `src/sessions/tmux-watcher.ts`**

Add `'claudeEffort'` to the `WatcherDeps.tmux` Pick:

```ts
  tmux: Pick<TmuxClient, 'listSessions' | 'serverRunning' | 'paneCwd' | 'paneCommand' | 'claudeCwd' | 'claudeModel' | 'claudeEffort'>
    & Partial<Pick<TmuxClient, 'processTree'>>;
```

Add `EffortLevel` to the `../types.js` type import:

```ts
import type { EffortLevel } from '../types.js';
```

In `pollOnce`, directly after the `let model: string | undefined;` block, add:

```ts
      // Effort del processo claude (`--reasoning-effort <livello>`), per /diag.
      // Best-effort: undefined se non leggibile → la resa mostra '—'.
      let effort: EffortLevel | undefined;
      try { effort = await this.deps.tmux.claudeEffort(target, tree); } catch { /* best-effort */ }
```

and pass it to `registerTerminal`:

```ts
      this.deps.manager.registerTerminal({ title: name, projectDir, tmuxTarget: target, model, effort });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/tmux-inject.test.ts test/tmux-watcher.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sessions/tmux-inject.ts src/sessions/tmux-watcher.ts test/tmux-inject.test.ts test/tmux-watcher.test.ts
git commit -m "feat: discover reasoning effort for terminal sessions"
```

---

### Task 9: `src/git.ts` — current branch of a directory

**Files:**
- Create: `src/git.ts`
- Test: `test/git.test.ts`

**Interfaces:**
- Consumes: `createShExec`, `type ShExecFn` from `./sessions/tmux-inject.js` (generic shell exec, already exported).
- Produces: `export async function currentBranch(dir: string, sh: ShExecFn = createShExec({ timeoutMs: 2000 })): Promise<string | undefined>` — `undefined` when the dir is not a git repo, HEAD is detached, `git` is missing, or the command times out/errors.

- [ ] **Step 1: Write the failing tests**

Create `test/git.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ShExecFn } from '../src/sessions/tmux-inject.js';
import { currentBranch } from '../src/git.js';

const fakeSh = (result: { code: number; stdout: string; stderr: string }): ShExecFn => async () => result;

describe('currentBranch', () => {
  it('returns the branch when git succeeds', async () => {
    const sh = fakeSh({ code: 0, stdout: 'feat/settings-diag\n', stderr: '' });
    await expect(currentBranch('/tmp/x', sh)).resolves.toBe('feat/settings-diag');
  });
  it('returns undefined when the dir is not a git repo', async () => {
    const sh = fakeSh({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    await expect(currentBranch('/tmp/x', sh)).resolves.toBeUndefined();
  });
  it('returns undefined on a detached HEAD, an empty stdout or a throwing command', async () => {
    await expect(currentBranch('/tmp/x', fakeSh({ code: 0, stdout: '', stderr: '' }))).resolves.toBeUndefined();
    const throwing: ShExecFn = async () => { throw new Error('git not found'); };
    await expect(currentBranch('/tmp/x', throwing)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `npx vitest run test/git.test.ts`
Expected: FAIL — `../src/git.js` not found.

- [ ] **Step 3: Implement `src/git.ts`**

```ts
import { createShExec, type ShExecFn } from './sessions/tmux-inject.js';

// Branch git corrente della directory, per /diag. Best-effort: undefined se la
// dir non è in un repo git, se HEAD è detached (`symbolic-ref --short HEAD`
// fallisce), se git non è installato o se il comando va in timeout. Calcolato
// alla render di /diag (non persistito): il cwd di una sessione può spostarsi
// tra worktree, quindi la verità è quella letta ora.
export async function currentBranch(dir: string, sh: ShExecFn = createShExec({ timeoutMs: 2000 })): Promise<string | undefined> {
  try {
    const r = await sh('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
    if (r.code !== 0) return undefined;
    const branch = r.stdout.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/git.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts test/git.test.ts
git commit -m "feat: resolve the current git branch for /diag"
```

---

### Task 10: `/diag` — menu entry fix + per-session model · effort · branch

**Files:**
- Modify: `bot/telegram.ts`
- Test: `test/telegram.test.ts`

**Interfaces:**
- Consumes: `currentBranch` from `../src/git.js`; `Session.effort`; `config.defaultModel`.
- Produces: `DiagSession` gains `model?: string; effort?: EffortLevel; branch?: string`; `diagReport` renders each session line as `id · title — kind · status · tmux · transcript — model · effort · branch` (`—` when unknown); `setMyCommands` includes `diag`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('diagReport')` block in `test/telegram.test.ts`:

```ts
  it('shows model, effort and branch per session, with — when unknown', () => {
    const s = {
      ...snapshot,
      sessions: [
        { id: 'aaaaaaaa-1111', kind: 'terminal' as const, status: 'idle' as const, title: 'my-proj', transcript: 'a.jsonl', hasTmux: true, model: 'claude-sonnet-4-5', effort: 'high' as const, branch: 'main' },
        { id: 'bbbbbbbb-2222', kind: 'headless' as const, status: 'running' as const, title: 'task', hasTmux: false },
      ],
    };
    const out = diagReport(s);
    expect(out).toContain('claude-sonnet-4-5');
    expect(out).toContain('high');
    expect(out).toContain('main');
    expect(out).toMatch(/— · —/); // la headless senza dati mostra i segnaposto
  });
```

Also assert the fix itself (menu entry) cannot be unit-tested through `diagReport` — it is covered by the `setMyCommands` array change in Step 3 and verified by `npm run typecheck`.

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/telegram.test.ts -t "diagReport"`
Expected: FAIL — the new fields are dropped by the renderer (existing lines unchanged).

- [ ] **Step 3: Implement — `bot/telegram.ts`**

Add the import:

```ts
import { currentBranch } from '../src/git.js';
```

Extend `DiagSession`:

```ts
export interface DiagSession {
  id: string;
  kind: SessionKind;
  status: SessionStatus;
  title: string;
  transcript?: string;
  hasTmux: boolean;
  model?: string;
  effort?: EffortLevel;
  branch?: string;
}
```

Replace the sessions rendering inside `diagReport`:

```ts
  const sessions = s.sessions.length
    ? s.sessions.map(x => {
        const bits = [x.kind, x.status, x.hasTmux ? 'tmux' : 'no-tmux', x.transcript ? 'transcript' : 'no-transcript'];
        const modelEffortBranch = [x.model ?? '—', x.effort ?? '—', x.branch ?? '—'].map(htmlEscape).join(' · ');
        return `• <code>${htmlEscape(x.id.slice(0, 8))}</code> ${htmlEscape(x.title)} — ${htmlEscape(bits.join(' · '))} — ${modelEffortBranch}`;
      }).join('\n')
    : 'no sessions tracked';
```

Replace the `diag` command handler body so it resolves the branch per session (the handler is already `async`):

```ts
    bot.command('diag', ctx => this.safe(ctx, 'diag', async () => {
      if (!this.authorize(ctx)) return;
      const sessions = this.deps.manager.list();
      const diagSessions = await Promise.all(sessions.map(async x => ({
        id: x.id,
        kind: x.kind,
        status: x.status,
        title: x.title,
        transcript: x.transcriptFile ? basename(x.transcriptFile) : undefined,
        hasTmux: Boolean(x.tmuxTarget),
        model: x.model ?? this.deps.config.defaultModel,
        effort: x.effort,
        branch: await currentBranch(x.projectDir),
      })));
      await this.send(ctx, diagReport({
        version: CURRENT_VERSION,
        armed: this.deps.manager.isArmed(),
        chatBound: this.chatId !== undefined,
        activeSessionId: this.deps.manager.getActive(),
        sessions: diagSessions,
        pending: {
          permissions: this.deps.permissionFlow.pendingCount(),
          dialogs: this.deps.dialogFlow.pendingCount(),
          questionFlows: this.questionFlows.size,
        },
        recentErrors: log().recentErrors(),
      }));
    }));
```

In `start()` → `setMyCommands([...])`, add the `diag` entry (after `usage`, before `settings` if both exist, or anywhere in the list — order is cosmetic):

```ts
      { command: 'diag', description: 'Daemon diagnostics' },
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/telegram.test.ts`
Expected: PASS — the pre-existing `diagReport` assertions use `toContain` on content that is unchanged, and unknown fields render `—`.

- [ ] **Step 5: Commit**

```bash
git add bot/telegram.ts test/telegram.test.ts
git commit -m "feat(diag): add to command menu; report model, effort and git branch per session"
```

---

### Task 11: Docs — README, AI-GUIDE, CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `AI-GUIDE.md`
- Modify: `CHANGELOG.md`

**Interfaces:** none (docs only). Follow the four-places rule for the command list and the five-file rule for the new config option.

- [ ] **Step 1: README — Usage command table**

In `README.md`, in the command table (around line 127), update the `/new` row to:

```
| `/new [--auto\|--standard] [--model <name>] [--effort <level>] <text>` | headless session + your prompt (standard by default: approve/reject buttons) |
```

Update the `/diag` row (line 134) to:

```
| `/diag` | daemon state, sessions, pending interactions, recent errors; per session: model · effort · git branch |
```

Add a `/settings` row after the `/usage` row (line 133):

```
| `/settings [key [value]]` · `/settings reset <key>` | view / change user settings; saved to `settings.json`, applies at the next daemon restart |
```

- [ ] **Step 2: README — Configuration**

In the Configuration table (around line 284), add after the `DEFAULT_PERMISSION_MODE` row:

```
| `DEFAULT_EFFORT` | `medium` | reasoning effort for headless `/new` without a flag (per-session: `/new --effort`) |
```

Immediately after the Configuration table (before the `###` section that follows it), add:

```
Settings changed from Telegram with `/settings` are stored in
`<STATE_DIR>/settings.json` and take precedence over the `.env` values above.
They cover `DEFAULT_MODEL`, `DEFAULT_PERMISSION_MODE`,
`MAX_HEADLESS_SESSIONS`, `PERMISSION_TIMEOUT_SECONDS`, `ARMED_ON_START`,
`CLAUDE_OMNI_RC_NO_UPDATE_CHECK` and `DEFAULT_EFFORT`, and apply at the next
daemon restart.
```

- [ ] **Step 3: AI-GUIDE.md — setup matrix + command reference**

In the "Setup matrix" table, add a row (alphabetical, after the "check what sessions exist" row):

```
| check / change your settings from the phone | from Telegram: `/settings` (list), `/settings <key> <value>` (set), `/settings reset <key>` — saved to `settings.json`, applies at the next restart |
```

In the "Command reference" section, update the `/new` line to include the flag:

```
- `/new [--auto|--standard] [--model <name>] [--effort <level>] <text>` — create a headless
  session and send it the prompt (automode by default: permissions
  auto-approved; `--standard` for approve/reject buttons; `--model` to pick
  the model for this session; `--effort` to set the reasoning effort). Headless
  sessions use the provider configured in `.env` (...)
```

(keep the existing `.env` sentence unchanged).

Update the `/diag` line to:

```
- `/diag` — daemon state, sessions, pending interactions and recent errors;
  per session it shows the model, the reasoning effort and the git branch when
  available (from the structured log at `~/.claude-omni-rc/logs/daemon.jsonl`).
```

Add a `/settings` line after the `/diag` line:

```
- `/settings [key [value]]` · `/settings reset <key>` — view the curated user
  settings, change one (`/settings <key> <value>`) or reset it to the `.env`
  default (`/settings reset <key>`). Stored in `<STATE_DIR>/settings.json` with
  precedence over `.env`; changes apply at the next daemon restart.
```

- [ ] **Step 4: CHANGELOG.md**

Insert at the top of `CHANGELOG.md` (after the `# Changelog` heading, before `## [0.3.0]`):

```
## [Unreleased]

- **`/settings` command.** See and change the curated user settings from the
  phone (`/settings`, `/settings <key> <value>`, `/settings reset <key>`). They
  are stored in `<STATE_DIR>/settings.json` with precedence over `.env` and
  apply at the next daemon restart. New `DEFAULT_EFFORT` setting and a
  `--effort` flag on `/new`.
- **`/diag` in the command menu and enriched.** `/diag` now appears in the
  Telegram command autocomplete and reports, per session, the model, the
  reasoning effort and the git branch when available.
```

- [ ] **Step 5: Full verification**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all test files pass (348 existing + the new ones).

- [ ] **Step 6: Commit**

```bash
git add README.md AI-GUIDE.md CHANGELOG.md
git commit -m "docs: document /settings and the enriched /diag"
```

---

## Final verification (after all tasks)

Run: `npm run typecheck && npm test`

Expected: `tsc --noEmit` exits 0; `vitest run` reports all suites passing. Then follow `shipping-a-change` for the branch: CHANGELOG already updated in Task 11; do not push or open a PR unless asked.
