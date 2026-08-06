import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { TmuxWatcher } from '../src/sessions/tmux-watcher.js';

function makeWatcher(tmuxSessions: string[] = [], serverUp = true) {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
  const config = loadConfig({ STATE_DIR: dir });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const tmux = {
    serverRunning: vi.fn(async () => serverUp),
    listSessions: vi.fn(async () => tmuxSessions),
    paneCwd: vi.fn(async (t: string) => `/home/user/${t.replace('claude:', '')}`),
    paneCommand: vi.fn(async () => 'ollama'), // default: claude attivo nel pane
  };
  const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
  return { manager, watcher, tmux };
}

describe('TmuxWatcher', () => {
  it('registers claude:* tmux sessions when armed, with the pane cwd', async () => {
    const { manager, watcher, tmux } = makeWatcher(['claude:proj1', 'claude:proj2', 'work']);
    manager.setArmed(true);
    await (watcher as any).poll();
    const s1 = manager.findByTmuxTarget('claude:proj1');
    expect(s1).toBeDefined();
    expect(s1?.projectDir).toBe('/home/user/proj1'); // cwd reale dal pane
    expect(manager.findByTmuxTarget('claude:proj2')).toBeDefined();
    expect(manager.findByTmuxTarget('work')).toBeUndefined(); // non claude:* → ignorata
    expect(tmux.paneCwd).toHaveBeenCalled();
  });
  it('does nothing when disarmed', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1']);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(0);
  });
  it('does not duplicate an already-registered session', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1']);
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1);
  });
  it('prunes a terminal session whose tmux target is gone (after the grace)', async () => {
    const sessions = ['claude:proj1'];
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
    const config = loadConfig({ STATE_DIR: dir });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const tmux = {
      serverRunning: vi.fn(async () => true),
      listSessions: vi.fn(async () => sessions),
      paneCwd: vi.fn(async () => '/home/user/proj1'),
    };
    const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    // primo poll: il target c'è → non si pruna
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1);
    // il target sparisce: entro la grace resta, oltre la grace viene rimosso
    sessions.pop();
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1); // ancora dentro la grace
    (watcher as any).missingSince.set('claude:proj1', Date.now() - 60_000);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(0);
  });
  it('does not prune when the tmux server is down', async () => {
    const { manager, watcher } = makeWatcher([], false);
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    (watcher as any).missingSince.set('claude:proj1', Date.now() - 60_000);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1);
  });
  it('removes a session whose pane is back at the shell (claude exited) after the grace', async () => {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
    const config = loadConfig({ STATE_DIR: dir });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const tmux = {
      serverRunning: vi.fn(async () => true),
      listSessions: vi.fn(async () => ['claude:proj1']),
      paneCwd: vi.fn(async () => '/home/user/proj1'),
      paneCommand: vi.fn(async () => 'zsh'), // pane tornato alla shell
    };
    const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1); // dentro la grace
    (watcher as any).exitedSince.set('claude:proj1', Date.now() - 120_001); // oltre la grace
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(0); // sessione "chiusa" rimossa
  });
  it('keeps the session while the pane runs a program (claude alive)', async () => {
    const { manager, watcher } = makeWatcher(['claude:proj1']);
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    (watcher as any).exitedSince.set('claude:proj1', Date.now() - 130_000);
    await (watcher as any).poll(); // paneCommand → 'ollama', non una shell
    expect(manager.list()).toHaveLength(1);
  });
  it('does not remove when the pane command cannot be read', async () => {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-watch-'));
    const config = loadConfig({ STATE_DIR: dir });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const tmux = {
      serverRunning: vi.fn(async () => true),
      listSessions: vi.fn(async () => ['claude:proj1']),
      paneCwd: vi.fn(async () => '/home/user/proj1'),
      paneCommand: vi.fn(async () => { throw new Error('tmux error'); }),
    };
    const watcher = new TmuxWatcher({ config, manager, tmux: tmux as any });
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj1', projectDir: '/home/user/proj1', tmuxTarget: 'claude:proj1' });
    (watcher as any).exitedSince.set('claude:proj1', Date.now() - 130_000);
    await (watcher as any).poll();
    expect(manager.list()).toHaveLength(1); // conservativo: non rimuove se non può leggere il pane
  });
});
