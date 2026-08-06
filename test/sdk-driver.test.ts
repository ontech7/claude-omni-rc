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
  const ollama = { modelContext: vi.fn(async () => 1048576) };
  const sdk = new SdkDriver({ bus, manager, config, permissionFlow, ollama: ollama as any });
  const session = manager.createHeadless({ title: 'test', projectDir: '/tmp/x' });
  return { bus, events, manager, sdk, session, ollama, permissionFlow };
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
  it('stop() aborts an in-flight turn and sets status stopped', async () => {
    const { sdk, session, manager } = makeDriver();
    let ac: AbortController | undefined;
    queryMock.mockImplementationOnce(async function* (config: any) {
      ac = config.options.abortController;
      await new Promise<void>((_, reject) => {
        ac!.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const p = sdk.runTurn(session.id, 'x');
    expect(sdk.stop(session.id)).toBe(true);
    await p;
    expect(manager.get(session.id)!.status).toBe('stopped');
    expect(sdk.stop(session.id)).toBe(false); // già fermata
  });
  it('maps user tool_result blocks to session.tool', async () => {
    const { sdk, session, events } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: 'user', uuid: 'u', session_id: session.id,
        message: { id: 'm', type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: false }] },
        parent_tool_use_id: null,
      };
      yield resultMsg(session.id, 'ok');
    });
    await sdk.runTurn(session.id, 'x');
    const tools = events.filter(e => (e as any).type === 'session.tool');
    expect(tools).toHaveLength(1);
    expect((tools[0] as any).kind).toBe('tool_result');
    expect((tools[0] as any).result).toBe('out');
  });
  it('auto-allows AskUserQuestion in canUseTool without a permission request', async () => {
    const { sdk, session } = makeDriver();
    queryMock.mockImplementationOnce(async function* () { yield resultMsg(session.id, 'ok'); });
    await sdk.runTurn(session.id, 'x');
    const opts = queryMock.mock.calls[0][0].options;
    const decision = await opts.canUseTool('AskUserQuestion', { questions: [{ question: 'x', options: [{ label: 'a' }] }] }, {});
    expect(decision).toEqual({ behavior: 'allow' });
  });

  it('automode (default): canUseTool auto-allows without a permission request', async () => {
    const { sdk, session, bus } = makeDriver();
    const perms: unknown[] = [];
    bus.on('session.permission', e => perms.push(e));
    queryMock.mockImplementationOnce(async function* () { yield resultMsg(session.id, 'ok'); });
    await sdk.runTurn(session.id, 'x');
    const opts = queryMock.mock.calls[0][0].options;
    const decision = await opts.canUseTool('Bash', { command: 'ls' }, {});
    expect(decision).toEqual({ behavior: 'allow' });
    expect(perms).toHaveLength(0); // nessuna notifica di permesso
  });

  it('standard mode: canUseTool routes to the permission flow', async () => {
    const { sdk, bus, manager, permissionFlow } = makeDriver();
    const std = manager.createHeadless({ title: 'std', projectDir: '/tmp/s', permissionMode: 'standard' });
    const perms: unknown[] = [];
    bus.on('session.permission', e => perms.push(e));
    queryMock.mockImplementationOnce(async function* () { yield resultMsg(std.id, 'ok'); });
    await sdk.runTurn(std.id, 'x');
    const opts = queryMock.mock.calls[0][0].options;
    const pending = opts.canUseTool('Bash', { command: 'ls' }, {});
    expect(perms).toHaveLength(1); // la richiesta arriva al flusso permessi
    permissionFlow.approve((perms[0] as any).permission.id);
    await expect(pending).resolves.toEqual({ behavior: 'allow' });
  });

  it('emits session.prompt for AskUserQuestion tool_use instead of a tool bubble', async () => {
    const { sdk, session, bus, events } = makeDriver();
    const prompts: unknown[] = [];
    bus.on('session.prompt', e => prompts.push(e));
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: 'assistant', uuid: 'u', session_id: session.id,
        message: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: 'q', options: [{ label: 'a' }, { label: 'b' }] }] } }] },
        parent_tool_use_id: null,
      };
      yield resultMsg(session.id, 'ok');
    });
    await sdk.runTurn(session.id, 'x');
    expect(prompts).toHaveLength(1);
    expect((prompts[0] as any).questions[0].options).toHaveLength(2);
    const toolBubbles = events.filter(e => (e as any).type === 'session.tool' && (e as any).kind === 'tool_use');
    expect(toolBubbles).toHaveLength(0);
  });

  it('emits the joined SDK errors on an error result', async () => {
    const { sdk, session, events, manager } = makeDriver();
    queryMock.mockImplementationOnce(async function* () {
      yield {
        type: 'result', subtype: 'error_during_execution', uuid: 'u', session_id: session.id,
        is_error: true, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
        errors: ['boom1', 'boom2'],
      };
    });
    await sdk.runTurn(session.id, 'x');
    const err = events.find(e => (e as any).type === 'session.error');
    expect((err as any).message).toBe('boom1\nboom2');
    expect(manager.get(session.id)!.status).toBe('error');
  });
  it('passes the Ollama env (as ollama launch claude sets it) to the SDK query', async () => {
    const { sdk, session, ollama } = makeDriver();
    queryMock.mockImplementationOnce(async function* () { yield resultMsg(session.id, 'ok'); });
    await sdk.runTurn(session.id, 'a');
    const opts = queryMock.mock.calls[0][0].options;
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
    expect(opts.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(opts.model);
    expect(opts.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(opts.model);
    expect(opts.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(opts.model);
    expect(opts.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1048576');
    expect(ollama.modelContext).toHaveBeenCalledWith(opts.model);
  });
  it('omits CLAUDE_CODE_MAX_CONTEXT_TOKENS when the context length is unknown', async () => {
    const prev = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS; // l'env della shell non deve inquinare il test
    try {
      const { sdk, session, ollama } = makeDriver();
      (ollama.modelContext as any).mockResolvedValue(undefined);
      queryMock.mockImplementationOnce(async function* () { yield resultMsg(session.id, 'ok'); });
      await sdk.runTurn(session.id, 'a');
      const opts = queryMock.mock.calls[0][0].options;
      expect(opts.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
      expect(opts.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS; else process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = prev;
    }
  });
  it('passes through a non-Ollama provider env untouched (no Ollama overrides)', async () => {
    const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS'] as const;
    const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com';
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token';
    process.env.ANTHROPIC_API_KEY = 'proxy-key';
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'env-haiku';
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'env-opus';
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'env-sonnet';
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '12345';
    try {
      const { sdk, session, ollama } = makeDriver();
      queryMock.mockImplementationOnce(async function* () { yield resultMsg(session.id, 'ok'); });
      await sdk.runTurn(session.id, 'a');
      const opts = queryMock.mock.calls[0][0].options;
      expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
      expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-token');
      expect(opts.env.ANTHROPIC_API_KEY).toBe('proxy-key');
      // i default del CLI e il context length NON vengono toccati in modalità non-Ollama
      expect(opts.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('env-haiku');
      expect(opts.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('env-opus');
      expect(opts.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('env-sonnet');
      expect(opts.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('12345');
      expect(ollama.modelContext).not.toHaveBeenCalled();
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
      }
    }
  });
});
