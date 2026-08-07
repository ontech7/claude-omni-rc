import { describe, it, expect, vi } from 'vitest';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { DialogFlow } from '../src/dialogs.js';

function makeFlow(timeoutSeconds = 120): { flow: DialogFlow; bus: Bus; onDialog: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } {
  const bus = new Bus();
  const onDialog = vi.fn();
  bus.on('session.dialog', onDialog);
  const setStatus = vi.fn();
  const config = loadConfig({ PERMISSION_TIMEOUT_SECONDS: String(timeoutSeconds) });
  const flow = new DialogFlow({ bus, config, setStatus });
  return { flow, bus, onDialog, setStatus };
}

describe('DialogFlow', () => {
  it('emits a dialog request and resolves on complete', async () => {
    const { flow, onDialog, setStatus } = makeFlow();
    const p = flow.request('s1', { dialogKind: 'refusal_fallback_prompt', payload: { fallbackModel: 'm' } });
    expect(onDialog).toHaveBeenCalledTimes(1);
    const dlg = onDialog.mock.calls[0][0].dialog;
    expect(dlg.sessionId).toBeUndefined(); // la sessione è nel campo del bus event
    expect(onDialog.mock.calls[0][0].sessionId).toBe('s1');
    expect(dlg.dialogKind).toBe('refusal_fallback_prompt');
    expect(dlg.payload.fallbackModel).toBe('m');
    expect(dlg.id).toBeTruthy();
    expect(setStatus).toHaveBeenCalledWith('s1', 'waiting-permission');
    expect(flow.complete(dlg.id, { approved: true })).toBe(true);
    await expect(p).resolves.toEqual({ behavior: 'completed', result: { approved: true } });
    expect(setStatus).toHaveBeenLastCalledWith('s1', 'running');
  });
  it('resolves cancelled on cancel()', async () => {
    const { flow, onDialog } = makeFlow();
    const p = flow.request('s1', { dialogKind: 'refusal_fallback_prompt', payload: {} });
    const dlg = onDialog.mock.calls[0][0].dialog;
    expect(flow.cancel(dlg.id)).toBe(true);
    await expect(p).resolves.toEqual({ behavior: 'cancelled' });
    expect(flow.cancel(dlg.id)).toBe(false); // already resolved
  });
  it('times out to cancelled once armed', async () => {
    vi.useFakeTimers();
    try {
      const { flow, onDialog } = makeFlow(120);
      const p = flow.request('s1', { dialogKind: 'refusal_fallback_prompt', payload: {} });
      const dlg = onDialog.mock.calls[0][0].dialog;
      flow.arm(dlg.id);
      vi.advanceTimersByTime(120_000);
      await expect(p).resolves.toEqual({ behavior: 'cancelled' });
    } finally { vi.useRealTimers(); }
  });
  it('does not time out while queued (unarmed) — arming is what starts the clock', async () => {
    vi.useFakeTimers();
    try {
      const { flow, onDialog } = makeFlow(120);
      const p = flow.request('s1', { dialogKind: 'refusal_fallback_prompt', payload: {} });
      const dlg = onDialog.mock.calls[0][0].dialog;
      vi.advanceTimersByTime(10 * 60_000); // ben oltre il timeout, ma mai armato
      flow.arm(dlg.id);
      vi.advanceTimersByTime(120_000);
      await expect(p).resolves.toEqual({ behavior: 'cancelled' });
    } finally { vi.useRealTimers(); }
  });
  it('resolves cancelled when the AbortSignal fires', async () => {
    const { flow, onDialog } = makeFlow();
    const ac = new AbortController();
    const p = flow.request('s1', { dialogKind: 'refusal_fallback_prompt', payload: {} }, ac.signal);
    onDialog.mock.calls[0][0].dialog;
    ac.abort();
    await expect(p).resolves.toEqual({ behavior: 'cancelled' });
  });
  it('cancels all pending dialogs for a session', async () => {
    const { flow, onDialog } = makeFlow();
    const p = flow.request('s1', { dialogKind: 'refusal_fallback_prompt', payload: {} });
    const dlg = onDialog.mock.calls[0][0].dialog;
    expect(flow.sessionIdFor(dlg.id)).toBe('s1');
    flow.cancelAllForSession('s1');
    await expect(p).resolves.toEqual({ behavior: 'cancelled' });
    expect(flow.sessionIdFor(dlg.id)).toBeUndefined();
  });
});

describe('DialogFlow without a Telegram destination', () => {
  it('cancels immediately instead of hanging until the timeout', async () => {
    const bus = new Bus();
    const onDialog = vi.fn();
    bus.on('session.dialog', onDialog);
    const config = loadConfig({ PERMISSION_TIMEOUT_SECONDS: '120' });
    const flow = new DialogFlow({ bus, config, canNotify: () => false });
    const decision = await flow.request('s1', { dialogKind: 'refusal_fallback_prompt', payload: {} });
    expect(decision).toEqual({ behavior: 'cancelled' });
    expect(onDialog).not.toHaveBeenCalled(); // nessuno leggerebbe la notifica
  });
  it('can notify by default (no predicate configured)', () => {
    const config = loadConfig({});
    expect(new DialogFlow({ bus: new Bus(), config }).canNotify()).toBe(true);
  });
});
