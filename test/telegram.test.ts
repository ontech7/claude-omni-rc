import { describe, it, expect, vi } from 'vitest';
import { parseCommand, parseCallbackData, permissionMessage, sessionListText, EditThrottler, attachmentPlan, stripAnsi, mdToHtml, relativeTime, ToolBurstAggregator } from '../bot/telegram.js';
import type { ToolBurstSink } from '../bot/telegram.js';

describe('parseCommand', () => {
  it('classifies control commands', () => {
    expect(parseCommand('/rc on')).toEqual({ kind: 'control', command: 'rc', arg: 'on' });
    expect(parseCommand('/help')).toEqual({ kind: 'control', command: 'help' });
  });
  it('classifies session commands', () => {
    expect(parseCommand('/new  refactor this')).toEqual({ kind: 'session', command: 'new', arg: 'refactor this' });
    expect(parseCommand('/sessions')).toEqual({ kind: 'session', command: 'sessions' });
  });
  it('classifies plain text and unknown', () => {
    expect(parseCommand('ciao')).toEqual({ kind: 'text' });
    expect(parseCommand('/bogus')).toEqual({ kind: 'unknown' });
  });
});

describe('parseCallbackData', () => {
  it('parses approve/deny/select actions', () => {
    expect(parseCallbackData('perm:approve:abc')).toEqual({ action: 'approve', id: 'abc' });
    expect(parseCallbackData('perm:deny:abc')).toEqual({ action: 'deny', id: 'abc' });
    expect(parseCallbackData('sess:select:xyz')).toEqual({ action: 'select', id: 'xyz' });
  });
  it('throws on malformed data', () => {
    expect(() => parseCallbackData('junk')).toThrow();
  });
});

describe('permissionMessage / sessionListText', () => {
  it('renders tool name and input', () => {
    const msg = permissionMessage({ id: 'i', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, createdAt: '' });
    expect(msg).toContain('Bash');
    expect(msg).toContain('ls');
  });
  it('marks the active session and shows identifying details', () => {
    const sessions = [
      { id: 'aaa', kind: 'headless', title: 't1', projectDir: '/x', model: 'deepseek-v4-flash:0731-cloud', status: 'idle', lastActivity: '2026-08-05T12:00:00.000Z', createdAt: '' },
      { id: 'bbb', kind: 'terminal', title: 't2', projectDir: '/y', tmuxTarget: 'claude:my-branch', status: 'running', lastActivity: new Date().toISOString(), createdAt: '' },
    ] as any;
    const txt = sessionListText(sessions, 'bbb');
    expect(txt).toContain('▸');
    expect(txt).toContain('running');
    expect(txt).toContain('claude:my-branch'); // per le terminali il target tmux
    expect(txt).toContain('deepseek-v4-flash:0731-cloud'); // per le headless il modello
    expect(txt).toContain('just now');
  });
  it('formats relative time', () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 10_000).toISOString())).toBe('just now');
    expect(relativeTime(new Date(now - 2 * 60_000).toISOString())).toBe('2m ago');
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });
});

describe('attachmentPlan', () => {
  it('warns only for text-only models on images (path-reference, no image blocks)', () => {
    expect(attachmentPlan(true, 'image')).toEqual({});
    expect(attachmentPlan(false, 'image').warning).toBeTruthy();
    expect(attachmentPlan(true, 'document')).toEqual({});
  });
});

describe('pane/format helpers', () => {
  it('strips ANSI escapes and carriage returns', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m\r\nnext')).toBe('green\nnext');
  });
  it('renders markdown to HTML', () => {
    expect(mdToHtml('**bold** and `code`')).toBe('<b>bold</b> and <code>code</code>');
    expect(mdToHtml('*italic*')).toBe('<i>italic</i>');
  });
});

describe('EditThrottler', () => {
  it('paces edits at ~1/s', async () => {
    vi.useFakeTimers();
    try {
      const t = new EditThrottler(1000);
      const fn = vi.fn(async () => undefined);
      const p1 = t.throttled(fn);
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      const p2 = t.throttled(fn);
      await vi.advanceTimersByTimeAsync(500);
      expect(fn).toHaveBeenCalledTimes(1); // ancora in attesa
      await vi.advanceTimersByTimeAsync(600);
      await p1; await p2;
      expect(fn).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe('ToolBurstAggregator', () => {
  function makeAgg(maxLen = 3800) {
    const edits: { id: number; text: string }[] = [];
    const sends: string[] = [];
    let nextId = 1;
    const sink: ToolBurstSink = {
      edit: vi.fn(async (id: number, text: string) => { edits.push({ id, text }); return true; }),
      send: vi.fn(async (text: string) => { sends.push(text); return nextId++; }),
    };
    const agg = new ToolBurstAggregator(sink, maxLen);
    return { agg, sink, edits, sends };
  }
  it('sends on first push, edits on following pushes', async () => {
    const { agg, sink, edits, sends } = makeAgg();
    await agg.push('t1');
    await agg.push('t2');
    await agg.push('t3');
    expect(sends).toEqual(['t1']);
    expect(sink.send).toHaveBeenCalledTimes(1);
    expect(edits).toEqual([
      { id: 1, text: 't1\nt2' },
      { id: 1, text: 't1\nt2\nt3' },
    ]);
  });
  it('close() closes the burst: the next push starts a new bubble', async () => {
    const { agg, sink } = makeAgg();
    await agg.push('t1');
    agg.close();
    await agg.push('t2');
    expect(sink.send).toHaveBeenCalledTimes(2);
    expect(sink.edit).not.toHaveBeenCalled();
  });
  it('starts a new bubble when appending would exceed maxLen', async () => {
    const { agg, sink, edits, sends } = makeAgg(5);
    await agg.push('t1'); // send
    await agg.push('t2'); // 't1\nt2' = 5 ≤ 5 → edit
    await agg.push('t3'); // 't1\nt2\nt3' = 8 > 5 → send
    expect(sends).toEqual(['t1', 't3']);
    expect(edits).toEqual([{ id: 1, text: 't1\nt2' }]);
  });
  it('falls back to a new bubble when the edit fails', async () => {
    const { agg, sink, sends } = makeAgg();
    (sink.edit as any).mockImplementation(async () => false);
    await agg.push('t1');
    await agg.push('t2');
    expect(sends).toEqual(['t1', 't2']);
  });
  it('serializes concurrent pushes: back-to-back calls produce one bubble', async () => {
    const { agg, sink, edits, sends } = makeAgg();
    await Promise.all([agg.push('t1'), agg.push('t2'), agg.push('t3')]);
    expect(sends).toEqual(['t1']);
    expect(edits).toEqual([
      { id: 1, text: 't1\nt2' },
      { id: 1, text: 't1\nt2\nt3' },
    ]);
  });
  it('after an edit-failure fallback, the next push edits the new bubble', async () => {
    const { agg, sink, sends, edits } = makeAgg();
    (sink.edit as any).mockImplementation(async () => false);
    await agg.push('t1'); // send id=1
    await agg.push('t2'); // edit fallisce → send id=2
    (sink.edit as any).mockImplementation(async (id: number, text: string) => { edits.push({ id, text }); return true; });
    await agg.push('t3'); // deve editare la bubble 2, non ri-sendare
    expect(sends).toEqual(['t1', 't2']);
    expect(edits).toEqual([{ id: 2, text: 't2\nt3' }]);
  });
  it('when send fails (undefined), the next push starts a fresh bubble', async () => {
    const { agg, sink, sends } = makeAgg();
    (sink.send as any).mockImplementationOnce(async () => undefined).mockImplementation(async () => { sends.push('ok'); return 9; });
    await agg.push('t1'); // send fallisce → nessuna bubble aperta
    await agg.push('t2'); // send ok → bubble nuova
    expect(sends).toEqual(['ok']);
  });
});
