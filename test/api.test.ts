import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { StateStore } from '../src/state.js';
import { loadConfig } from '../src/config.js';
import { SessionManager } from '../src/sessions/manager.js';
import { PermissionFlow } from '../src/permissions.js';
import { startApi, type ApiHandle } from '../src/api.js';

function makeApi(env: Record<string, string> = {}) {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-api-'));
  const config = loadConfig({ STATE_DIR: dir, ...env });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const permissionFlow = new PermissionFlow({
    bus, config,
    setStatus: (id, s) => manager.setStatus(id, s),
  });
  const api = startApi(0, { manager, permissionFlow, config });
  return { manager, permissionFlow, api, dir, bus };
}

describe('startApi', () => {
  const open: ApiHandle[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map(a => a.close())); });

  it('attaches a terminal session via POST /api/attach', async () => {
    const { manager, api } = makeApi();
    open.push(api);
    await api.ready;
    const base = `http://127.0.0.1:${api.port()}`;
    const res = await fetch(`${base}/api/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir: '/tmp/proj', tmuxTarget: 'claude:proj', title: 'proj' }),
    });
    expect(res.status).toBe(200);
    const session = manager.findByTmuxTarget('claude:proj');
    expect(session).toBeDefined();
    expect(session!.projectDir).toBe('/tmp/proj');
  });

  it('lists sessions via GET /api/sessions', async () => {
    const { manager, api } = makeApi();
    open.push(api);
    await api.ready;
    manager.registerTerminal({ title: 'proj', projectDir: '/tmp/proj', tmuxTarget: 'claude:proj' });
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/sessions`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sessions: unknown[] };
    expect(data.sessions.length).toBe(1);
  });

  it('rejects an attach without projectDir', async () => {
    const { api } = makeApi();
    open.push(api);
    await api.ready;
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/attach`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('answers ask when disarmed', async () => {
    const { api } = makeApi();
    open.push(api);
    await api.ready;
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' } }),
    });
    expect(await res.text()).toBe('ask');
  });

  it('holds a permission request open until approved, using the tracked session id', async () => {
    const { manager, permissionFlow, api, bus } = makeApi();
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    manager.registerTerminal({ title: 'proj', projectDir: '/tmp/proj', tmuxTarget: 'claude:proj' });
    const session = manager.findByTmuxTarget('claude:proj')!;
    let captured: { id: string; sessionId: string } | undefined;
    let resolveCapture: (() => void) | undefined;
    const capturedPromise = new Promise<void>(r => { resolveCapture = r; });
    bus.on('session.permission', ({ permission }) => {
      captured = permission;
      resolveCapture?.();
    });
    const req = fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' }, sessionId: 'claude:proj' }),
    });
    // la risposta non arriva finché non si approva (long-poll)
    const settled = await Promise.race([req.then(() => 'done'), new Promise(r => setTimeout(() => r('pending'), 100))]);
    expect(settled).toBe('pending');
    await capturedPromise;
    expect(captured?.sessionId).toBe(session.id); // mappa il target tmux alla sessione tracciata
    permissionFlow.approve(captured!.id);
    const res = await req;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('allow');
  });

  it('denies on timeout when nobody answers', async () => {
    const { manager, api } = makeApi({ PERMISSION_TIMEOUT_SECONDS: '1' });
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'Bash', input: { command: 'ls' }, sessionId: 'claude:proj' }),
    });
    expect(await res.text()).toBe('deny');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('auto-allows AskUserQuestion without a permission request', async () => {
    const { manager, api, bus } = makeApi();
    open.push(api);
    await api.ready;
    manager.setArmed(true);
    let permissionEvents = 0;
    bus.on('session.permission', () => { permissionEvents++; });
    const res = await fetch(`http://127.0.0.1:${api.port()}/api/permission`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'AskUserQuestion', input: { questions: [{ question: 'x', options: [{ label: 'a' }] }] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('allow');
    expect(permissionEvents).toBe(0); // nessuna notifica di permesso
  });
});
