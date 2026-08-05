import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { startApi, type ApiHandle } from '../src/api.js';

function makeApi() {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-api-'));
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const api = startApi(0, { manager });
  return { manager, api, dir };
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
});
