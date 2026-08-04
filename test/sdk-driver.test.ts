import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { PermissionFlow } from '../src/permissions.js';
import { SdkDriver } from '../src/sessions/sdk-driver.js';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...args: unknown[]) => queryMock(...args) }));

function makeDriver() {
  const bus = new Bus();
  const events: unknown[] = [];
  for (const t of ['session.text', 'session.tool', 'session.result', 'session.error', 'session.updated'] as const) {
    bus.on(t, e => events.push(e));
  }
  const config = loadConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' });
  const state = new StateStore(join(mkdtempSync(join(tmpdir(), 'orc-sdk-')), 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const permissionFlow = new PermissionFlow({ bus, config, setStatus: (id, s) => manager.setStatus(id, s) });
  const sdk = new SdkDriver({ bus, manager, config, permissionFlow });
  const session = manager.createHeadless({ title: 'test', projectDir: '/tmp/x' });
  return { bus, events, manager, sdk, session };
}

function assistantText(sessionId: string, text: string) {
  return {
    type: 'assistant', uuid: 'u', session_id: sessionId,
    message: { id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  };
}
function resultMsg(sessionId: string, result: string, isError = false) {
  return { type: 'result', subtype: 'success', uuid: 'u', session_id: sessionId, is_error: isError, result, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] };
}

describe('SdkDriver', () => {
  beforeEach(() => queryMock.mockReset());

  it('maps assistant text, tool_use and result to bus events', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield assistantText(session.id, 'ciao');
      yield {
        type: 'assistant', uuid: 'u', session_id: session.id,
        message: { id: 'm2', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        parent_tool_use_id: null,
      };
      yield resultMsg(session.id, 'done');
    });
    await sdk.runTurn(session.id, 'saluta');
    const texts = events.filter(e => (e as any).type === 'session.text');
    expect(texts).toHaveLength(1);
    expect((texts[0] as any).text).toBe('ciao');
    const tools = events.filter(e => (e as any).type === 'session.tool');
    expect(tools).toHaveLength(1);
    expect((tools[0] as any).toolName).toBe('Bash');
    const res = events.find(e => (e as any).type === 'session.result');
    expect((res as any).result).toBe('done');
    expect(events.some(e => (e as any).type === 'session.error')).toBe(false);
  });

  it('stores the session_id for resume and passes resume on next turn', async () => {
    const { sdk, session, manager } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield assistantText(session.id, 'primo');
      yield resultMsg(session.id, 'ok');
    });
    await sdk.runTurn(session.id, 'a');
    expect(manager.get(session.id)!.claudeSessionId).toBe(session.id);
    queryMock.mockImplementationOnce(async function* () { yield resultMsg(session.id, 'ok2'); });
    await sdk.runTurn(session.id, 'b');
    const opts = queryMock.mock.calls[1][0].options;
    expect(opts.resume).toBe(session.id);
    expect(opts.permissionMode).toBe('default');
  });

  it('emits error and sets status error when the query throws', async () => {
    const { sdk, session, events, manager } = makeDriver();
    queryMock.mockImplementationOnce(async function* () { throw new Error('ollama giu'); });
    await sdk.runTurn(session.id, 'x');
    const err = events.find(e => (e as any).type === 'session.error');
    expect((err as any).message).toBe('ollama giu');
    expect(manager.get(session.id)!.status).toBe('error');
  });

  it('rejects concurrent turns on the same session', async () => {
    const { sdk, session } = makeDriver();
    queryMock.mockImplementationOnce(() => (async function* () { await new Promise(() => {}); })());
    const p1 = sdk.runTurn(session.id, 'a');
    expect(sdk.isBusy(session.id)).toBe(true);
    await expect(sdk.runTurn(session.id, 'b')).rejects.toThrow('busy');
    void p1;
  });
});
