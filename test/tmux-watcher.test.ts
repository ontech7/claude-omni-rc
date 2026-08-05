import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { TmuxWatcher } from '../src/sessions/tmux-watcher.js';

function makeWatcher(tmuxSessions: string[] = []) {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
  const config = loadConfig({ STATE_DIR: dir });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const tmux = { listSessions: vi.fn(async () => tmuxSessions) };
  const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
  return { manager, watcher, tmux };
}

describe('TmuxWatcher', () => {
  it('registers claude:* tmux sessions when armed', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1', 'claude:proj2', 'work']);
    manager.setArmed(true);
    await (watcher as any).poll();
    expect(manager.findByTmuxTarget('claude:proj1')).toBeDefined();
    expect(manager.findByTmuxTarget('claude:proj2')).toBeDefined();
    expect(manager.findByTmuxTarget('work')).toBeUndefined(); // non claude:* → ignorata
  });
  it('does nothing when disarmed', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1']);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(0);
  });
  it('does not duplicate an already-registered session', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1']);
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '~/proj1', tmuxTarget: 'claude:proj1' });
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1);
  });
});
