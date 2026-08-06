import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';

function makeManager(armedOnStart = false, idleGraceMs = 3000, stateDir?: string): { manager: SessionManager; bus: Bus; onUpdated: ReturnType<typeof vi.fn> } {
  const bus = new Bus();
  const onUpdated = vi.fn();
  bus.on('session.updated', onUpdated);
  const dir = stateDir ?? mkdtempSync(join(tmpdir(), 'orc-mgr-'));
  const state = new StateStore(join(dir, 'state.json'));
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
    const shared = mkdtempSync(join(tmpdir(), 'orc-mgr-'));
    const { manager } = makeManager(true, 3000, shared);
    expect(manager.isArmed()).toBe(true);
    manager.setArmed(false);
    manager.persist();
    const { manager: m2 } = makeManager(true, 3000, shared);
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
  it('defaults headless sessions to automode and stores the requested mode', () => {
    const { manager } = makeManager();
    const auto = manager.createHeadless({ title: 'a', projectDir: '/tmp/a' });
    expect(auto.permissionMode).toBe('auto');
    const std = manager.createHeadless({ title: 's', projectDir: '/tmp/s', permissionMode: 'standard' });
    expect(std.permissionMode).toBe('standard');
    expect(manager.get(auto.id)!.permissionMode).toBe('auto');
  });
  it('persists the active session id across reloads', () => {
    const shared = mkdtempSync(join(tmpdir(), 'orc-mgr-'));
    const { manager } = makeManager(false, 3000, shared);
    manager.setActive('abc');
    const { manager: m2 } = makeManager(false, 3000, shared);
    expect(m2.getActive()).toBe('abc');
  });
  it('clears the active session id when that session is removed', () => {
    const { manager } = makeManager();
    const s = manager.createHeadless({ title: 't', projectDir: '/tmp/x' });
    manager.setActive(s.id);
    expect(manager.remove(s.id)).toBe(true);
    expect(manager.getActive()).toBeUndefined();
  });
  it('returns undefined when no session is active', () => {
    const { manager } = makeManager();
    expect(manager.getActive()).toBeUndefined();
  });
});
