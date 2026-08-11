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
    const backups = readdirSync(dir).filter(f => f.startsWith('settings.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, backups[0]), 'utf8')).toContain('not json'); // il contenuto originale è preservato nel backup
  });
});
