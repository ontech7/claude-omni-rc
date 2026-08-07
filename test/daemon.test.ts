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
      API_PORT: '0', // porta effimera: il test non deve collidere col daemon vero
      TELEGRAM_BOT_TOKEN: 'test-token',
      ARMED_ON_START: 'true',
      WORKSPACE_DIRS: '/tmp',
      CLAUDE_OMNI_RC_NO_UPDATE_CHECK: '1', // niente fetch reale a GitHub durante i test
    });
    const bot = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), notify: vi.fn() };
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
    const config = loadConfig({ STATE_DIR: dir, API_PORT: '0', TELEGRAM_BOT_TOKEN: 't', CLAUDE_OMNI_RC_NO_UPDATE_CHECK: '1' });
    const bot = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), notify: vi.fn() };
    const daemon = createDaemon(config, { bot: bot as any });
    await daemon.start();
    await daemon.stop();
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(state.armed).toBe(false);
  });
});
