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
