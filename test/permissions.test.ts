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
