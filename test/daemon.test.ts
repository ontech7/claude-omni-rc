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
