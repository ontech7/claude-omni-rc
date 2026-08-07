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
  it('times out to deny once armed', async () => {
    vi.useFakeTimers();
    try {
      const { flow, onPerm } = makeFlow(120);
      const p = flow.request('s1', 'Bash', {});
      const req = onPerm.mock.calls[0][0].permission;
      flow.arm(req.id);
      vi.advanceTimersByTime(120_000);
      await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Timeout 120s' });
    } finally { vi.useRealTimers(); }
  });
  it('does not time out while queued (unarmed) — arming is what starts the clock', async () => {
    vi.useFakeTimers();
    try {
      const { flow, onPerm } = makeFlow(120);
      const p = flow.request('s1', 'Bash', {});
      const req = onPerm.mock.calls[0][0].permission;
      vi.advanceTimersByTime(10 * 60_000); // ben oltre il timeout, ma mai armata
      flow.arm(req.id); // ora la sessione viene selezionata: il countdown parte da qui
      vi.advanceTimersByTime(119_000);
      let settled = false;
      void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false); // ancora entro i 120s da arm(), non da request()
      vi.advanceTimersByTime(1_000);
      await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Timeout 120s' });
    } finally { vi.useRealTimers(); }
  });
  it('arm() is a no-op once resolved or already armed', async () => {
    vi.useFakeTimers();
    try {
      const { flow, onPerm } = makeFlow(120);
      const p = flow.request('s1', 'Bash', {});
      const req = onPerm.mock.calls[0][0].permission;
      flow.approve(req.id);
      await expect(p).resolves.toEqual({ behavior: 'allow' });
      expect(() => flow.arm(req.id)).not.toThrow(); // già risolta: nessun timer fantasma
    } finally { vi.useRealTimers(); }
  });
  it('resolves deny when the AbortSignal fires', async () => {
    const { flow, onPerm } = makeFlow();
    const ac = new AbortController();
    const p = flow.request('s1', 'Bash', {}, ac.signal);
    onPerm.mock.calls[0][0].permission;
    ac.abort();
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Interrupted' });
  });
  it('cancels all pending requests for a session', async () => {
    const { flow, onPerm } = makeFlow();
    const p = flow.request('s1', 'Bash', {});
    flow.cancelAllForSession('s1');
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Session stopped' });
  });
  it('approve with updatedInput (ExitPlanMode) resolves with it', async () => {
    const { flow, onPerm } = makeFlow();
    const p = flow.request('s1', 'ExitPlanMode', { plan: 'original' });
    const req = onPerm.mock.calls[0][0].permission;
    expect(flow.infoFor(req.id)).toEqual({ sessionId: 's1', toolName: 'ExitPlanMode', input: { plan: 'original' } });
    expect(flow.approve(req.id, { plan: 'edited' })).toBe(true);
    await expect(p).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: 'edited' } });
    expect(flow.infoFor(req.id)).toBeUndefined(); // risolta
  });
  it('approve without updatedInput stays a plain allow', async () => {
    const { flow, onPerm } = makeFlow();
    const p = flow.request('s1', 'Bash', { command: 'ls' });
    const req = onPerm.mock.calls[0][0].permission;
    expect(flow.approve(req.id)).toBe(true);
    await expect(p).resolves.toEqual({ behavior: 'allow' });
  });
});

describe('PermissionFlow without a Telegram destination', () => {
  it('denies immediately instead of hanging until the timeout', async () => {
    const bus = new Bus();
    const onPerm = vi.fn();
    bus.on('session.permission', onPerm);
    const config = loadConfig({ PERMISSION_TIMEOUT_SECONDS: '120' });
    const flow = new PermissionFlow({ bus, config, canNotify: () => false });
    const decision = await flow.request('s1', 'Bash', { command: 'ls' });
    expect(decision.behavior).toBe('deny');
    expect(onPerm).not.toHaveBeenCalled(); // nessuno leggerebbe la notifica
  });
  it('reports that it cannot notify', () => {
    const config = loadConfig({});
    expect(new PermissionFlow({ bus: new Bus(), config, canNotify: () => false }).canNotify()).toBe(false);
  });
  it('can notify by default (no predicate configured)', () => {
    const config = loadConfig({});
    expect(new PermissionFlow({ bus: new Bus(), config }).canNotify()).toBe(true);
  });
});
