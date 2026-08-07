import { describe, it, expect, vi } from 'vitest';
import { resolveHeadlessProjectDir, isPrivateChat, splitHtmlMessage, parseCommand, parseNewFlags, parseCallbackData, permissionMessage, permissionKeyboard, sessionListText, EditThrottler, attachmentPlan, stripAnsi, mdToHtml, relativeTime, ToolBurstAggregator, promptMessage, promptLayout, matchesInjected, renderHistory, balanceHtml, truncateAtWord, stopReply, TypingIndicator, summarizeTool, narrationPlan, SummarizeQueue, answerSummary, answerToInjection, answersToMessage, parseNumericReply, dialogMessage, dialogKeyboard, formatPct, formatResetAt } from '../bot/telegram.js';
import type { ToolBurstSink } from '../bot/telegram.js';

describe('formatPct / formatResetAt', () => {
  it('formats a rounded percentage, or an em-dash when absent', () => {
    expect(formatPct(42.5)).toBe('43%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(null)).toBe('—');
    expect(formatPct(undefined)).toBe('—');
  });
  it('formats an ISO reset timestamp as HH:MM DD/MM, or an em-dash when absent/invalid', () => {
    expect(formatResetAt(null)).toBe('—');
    expect(formatResetAt('not-a-date')).toBe('—');
    expect(formatResetAt('2026-08-07T16:30:00Z')).toMatch(/^\d{2}:\d{2} \d{2}\/\d{2}$/);
  });
});

describe('parseCommand', () => {
  it('classifies control commands', () => {
    expect(parseCommand('/rc on')).toEqual({ kind: 'control', command: 'rc', arg: 'on' });
    expect(parseCommand('/rc')).toEqual({ kind: 'control', command: 'rc' }); // no arg → toggle
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

describe('parseNewFlags', () => {
  it('parses --model and --auto/--standard in any order', () => {
    expect(parseNewFlags('write a haiku')).toEqual({ text: 'write a haiku' }); // nessun flag → decide la config
    expect(parseNewFlags('--standard review this')).toEqual({ mode: 'standard', text: 'review this' });
    expect(parseNewFlags('--model deepseek-v4-flash:0731-cloud refactor')).toEqual({ model: 'deepseek-v4-flash:0731-cloud', text: 'refactor' });
    expect(parseNewFlags('--standard --model claude-sonnet-4-5 fix the bug')).toEqual({ mode: 'standard', model: 'claude-sonnet-4-5', text: 'fix the bug' });
    expect(parseNewFlags('--model m1 --auto go')).toEqual({ mode: 'auto', model: 'm1', text: 'go' });
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

describe('parseCallbackData extensions', () => {
  it('parses question answer callbacks', () => {
    expect(parseCallbackData('q:answer:tok1:0:2')).toEqual({ action: 'answer', id: 'tok1', questionIndex: 0, index: 2 });
  });
  it('parses done/other/cancel callbacks (4 parts)', () => {
    expect(parseCallbackData('q:done:tok1:0')).toEqual({ action: 'done', id: 'tok1', questionIndex: 0 });
    expect(parseCallbackData('q:other:tok1:1')).toEqual({ action: 'other', id: 'tok1', questionIndex: 1 });
    expect(parseCallbackData('q:cancel:tok1:2')).toEqual({ action: 'cancel', id: 'tok1', questionIndex: 2 });
  });
  it('parses delete callbacks', () => {
    expect(parseCallbackData('sess:del:abc')).toEqual({ action: 'del', id: 'abc' });
    expect(parseCallbackData('sess:del-yes:abc')).toEqual({ action: 'del-yes', id: 'abc' });
    expect(parseCallbackData('sess:del-no:abc')).toEqual({ action: 'del-no', id: 'abc' });
  });
  it('parses dialog callbacks', () => {
    expect(parseCallbackData('dlg:retry:d1')).toEqual({ action: 'dlg-retry', id: 'd1' });
    expect(parseCallbackData('dlg:skip:d1')).toEqual({ action: 'dlg-skip', id: 'd1' });
    expect(parseCallbackData('perm:edit:p1')).toEqual({ action: 'perm-edit', id: 'p1' });
  });
});

describe('dialog helpers', () => {
  it('dialogMessage renders a refusal fallback with the model', () => {
    const dlg = { id: 'd1', dialogKind: 'refusal_fallback_prompt', payload: { fallbackModel: 'claude-haiku-4-5', guidanceText: 'refused' } };
    const msg = dialogMessage(dlg, { title: 'my-proj' } as any);
    expect(msg).toContain('Model refused');
    expect(msg).toContain('my-proj');
    expect(msg).toContain('claude-haiku-4-5');
  });
  it('dialogMessage renders an unknown kind without crashing', () => {
    const dlg = { id: 'd1', dialogKind: 'brand_new_kind', payload: {} };
    const msg = dialogMessage(dlg);
    expect(msg).toContain('brand_new_kind');
  });
  it('dialogKeyboard builds the right buttons per kind', () => {
    const ref = dialogKeyboard({ id: 'd1', dialogKind: 'refusal_fallback_prompt', payload: {} });
    const refRows = (ref as any).inline_keyboard.flat().map((b: any) => b.text);
    expect(refRows).toEqual(['🔄 Retry', 'Skip']);
    const unknown = dialogKeyboard({ id: 'd1', dialogKind: 'other', payload: {} });
    const unknownRows = (unknown as any).inline_keyboard.flat().map((b: any) => b.text);
    expect(unknownRows).toEqual(['Cancel']);
  });
});

describe('permissionMessage / permissionKeyboard for ExitPlanMode', () => {
  it('shows the plan text instead of the raw JSON', () => {
    const req = { id: 'p1', sessionId: 'sess12345678', toolName: 'ExitPlanMode', input: { plan: 'step 1\nstep 2' }, createdAt: '' };
    const msg = permissionMessage(req);
    expect(msg).toContain('Plan approval');
    expect(msg).toContain('step 1');
    expect(msg).not.toContain('"plan"');
  });
  it('adds an Edit button for ExitPlanMode', () => {
    const req = { id: 'p1', sessionId: 's1', toolName: 'ExitPlanMode', input: { plan: 'p' }, createdAt: '' };
    const kb = permissionKeyboard(req);
    const rows = (kb as any).inline_keyboard.flat().map((b: any) => b.text);
    expect(rows).toEqual(['✓ Approve', '✗ Reject', '✏️ Edit']);
  });
  it('keeps Approve/Reject only for other tools', () => {
    const req = { id: 'p1', sessionId: 's1', toolName: 'Bash', input: { command: 'ls' }, createdAt: '' };
    const kb = permissionKeyboard(req);
    const rows = (kb as any).inline_keyboard.flat().map((b: any) => b.text);
    expect(rows).toEqual(['✓ Approve', '✗ Reject']);
  });
});

describe('question flow helpers', () => {
  const q = { question: 'Pick', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };

  it('answerSummary renders option labels and free text', () => {
    expect(answerSummary({ kind: 'option', labels: ['A', 'C'] })).toBe('A, C');
    expect(answerSummary({ kind: 'other', text: 'custom' })).toBe('custom');
  });

  it('answerToInjection maps labels to 1-based numbers, comma-separated for multi', () => {
    expect(answerToInjection(q, { kind: 'option', labels: ['B'] })).toBe('2');
    expect(answerToInjection(q, { kind: 'option', labels: ['A', 'C'] })).toBe('1, 3');
    expect(answerToInjection(q, { kind: 'other', text: 'custom' })).toBe('custom');
    expect(answerToInjection(q, { kind: 'option', labels: ['unknown'] })).toBe('');
  });

  it('answersToMessage builds one line per question with the answer summary', () => {
    const out = answersToMessage(
      [{ header: 'Lens', question: 'Which?', options: [] }, { question: 'Notes', options: [] }],
      [{ kind: 'option', labels: ['A'] }, { kind: 'other', text: 'free' }],
    );
    expect(out).toContain('Lens: Which? → A');
    expect(out).toContain('Notes → free');
  });

  it('parseNumericReply accepts numbers and comma lists, rejects other text', () => {
    expect(parseNumericReply('2')).toEqual([2]);
    expect(parseNumericReply('1, 3')).toEqual([1, 3]);
    expect(parseNumericReply(' 2 , 4 ')).toEqual([2, 4]);
    expect(parseNumericReply('abc')).toBeUndefined();
    expect(parseNumericReply('0')).toBeUndefined();
    expect(parseNumericReply('')).toBeUndefined();
  });
});

describe('promptMessage', () => {
  it('renders the header with HTML escaping', () => {
    const qs = [{ header: 'Lens', question: 'Pick <one>?', options: [{ label: 'a' }] }];
    const out = promptMessage(qs);
    expect(out).toContain('Lens');
    expect(out).toContain('Pick &lt;one&gt;?');
  });
});

describe('matchesInjected', () => {
  it('matches recent injected text and ignores old or different text', () => {
    const now = 1_000_000;
    const recent = [{ text: 'ciao', at: now - 1_000 }, { text: 'vecchio', at: now - 61_000 }];
    expect(matchesInjected(recent, 'ciao', now)).toBe(true);
    expect(matchesInjected(recent, '  ciao  ', now)).toBe(true); // trim
    expect(matchesInjected(recent, 'vecchio', now)).toBe(false);  // fuori finestra
    expect(matchesInjected(recent, 'altro', now)).toBe(false);
  });
});

describe('renderHistory', () => {
  it('renders messages with role icons and markdown', () => {
    const html = renderHistory([{ role: 'user', text: 'ciao' }, { role: 'assistant', text: '**ok**' }], 'proj');
    expect(html).toContain('🧑 ciao');
    expect(html).toContain('<b>ok</b>');
    expect(html).toContain('proj');
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
      { id: 1, text: 't1\n\nt2' }, // riga vuota tra una tool call e l'altra
      { id: 1, text: 't1\n\nt2\n\nt3' },
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
    const { agg, sink, edits, sends } = makeAgg(6);
    await agg.push('t1'); // send
    await agg.push('t2'); // 't1\n\nt2' = 6 ≤ 6 → edit
    await agg.push('t3'); // 't1\n\nt2\n\nt3' = 10 > 6 → send
    expect(sends).toEqual(['t1', 't3']);
    expect(edits).toEqual([{ id: 1, text: 't1\n\nt2' }]);
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
      { id: 1, text: 't1\n\nt2' },
      { id: 1, text: 't1\n\nt2\n\nt3' },
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
    expect(edits).toEqual([{ id: 2, text: 't2\n\nt3' }]);
  });
  it('when send fails (undefined), the next push starts a fresh bubble', async () => {
    const { agg, sink, sends } = makeAgg();
    (sink.send as any).mockImplementationOnce(async () => undefined).mockImplementation(async () => { sends.push('ok'); return 9; });
    await agg.push('t1'); // send fallisce → nessuna bubble aperta
    await agg.push('t2'); // send ok → bubble nuova
    expect(sends).toEqual(['ok']);
  });
  it('a stale burst (past the time window) opens a new bubble', async () => {
    vi.useFakeTimers();
    try {
      const { agg, sink, sends } = makeAgg();
      await agg.push('t1'); // send
      await vi.advanceTimersByTimeAsync(6000); // oltre la finestra di 5s
      await agg.push('t2'); // deve aprire una bubble nuova, non editare t1
      expect(sends).toEqual(['t1', 't2']);
      expect(sink.edit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('close() during a pending send does not reopen the burst', async () => {
    const sends: string[] = [];
    let nextId = 1;
    const sink: ToolBurstSink = {
      edit: vi.fn(async () => true),
      send: vi.fn(async (text: string) => { sends.push(text); return nextId++; }),
    };
    const agg = new ToolBurstAggregator(sink, 3800);
    const p1 = agg.push('t1'); // send1 parte (promise in volo)
    agg.close(); // chiude mentre send1 è in volo
    const p2 = agg.push('t2');
    await Promise.all([p1, p2]);
    // t1 è stato inviato ma la bubble non si riapre; t2 apre una bubble nuova.
    expect(sends).toEqual(['t1', 't2']);
    expect(sink.edit).not.toHaveBeenCalled();
  });
});

describe('SummarizeQueue', () => {
  function makeQueue() {
    const lines: string[] = [];
    const q = new SummarizeQueue(line => lines.push(line));
    return { q, lines };
  }
  it('flushes summaries in order even when they resolve out of order', () => {
    const { q, lines } = makeQueue();
    const a = q.add(); // indice 0
    const b = q.add(); // indice 1
    b('line2'); // risolve prima: deve aspettare l'indice 0
    expect(lines).toEqual([]);
    a('line1');
    expect(lines).toEqual(['line1', 'line2']);
  });
  it('reset() discards summaries that resolve after a turn boundary', () => {
    const { q, lines } = makeQueue();
    const a = q.add();
    q.reset();
    a('line1');
    expect(lines).toEqual([]);
  });
  it('reset() clears the buffer so stale entries do not block new ones', () => {
    const { q, lines } = makeQueue();
    const a = q.add(); // indice 0
    const b = q.add(); // indice 1
    b('line2'); // bufferizzata, in attesa dell'indice 0
    q.reset(); // scarta l'indice 1 stantio
    const c = q.add(); // indice 2
    c('line3');
    expect(lines).toEqual(['line3']);
  });
});

describe('mdToHtml v2 / balanceHtml', () => {
  it('renders bold, italic and nested ***both***', () => {
    expect(mdToHtml('**bold** and *it*')).toBe('<b>bold</b> and <i>it</i>');
    expect(mdToHtml('***both***')).toBe('<b><i>both</i></b>');
  });
  it('protects code blocks and inline code from formatting', () => {
    expect(mdToHtml('`**code**`')).toBe('<code>**code**</code>');
    expect(mdToHtml('```js\n# h\n**x**\n```')).toBe('<pre>js\n# h\n**x**\n</pre>');
  });
  it('converts headings outside code to bold', () => {
    expect(mdToHtml('# not a heading')).toBe('<b>not a heading</b>');
  });
  it('does not double-wrap a heading that contains bold', () => {
    expect(mdToHtml('# **title**')).toBe('# <b>title</b>');
    expect(mdToHtml('# plain')).toBe('<b>plain</b>');
  });
  it('leaves unclosed markers literal (no unbalanced HTML)', () => {
    expect(mdToHtml('**unclosed')).toBe('**unclosed');
  });
  it('escapes raw HTML and renders links', () => {
    expect(mdToHtml('<b>')).toBe('&lt;b&gt;');
    expect(mdToHtml('[t](https://x.com)')).toBe('<a href="https://x.com">t</a>');
  });
  it('balanceHtml closes unclosed tags, drops orphan closes, keeps valid HTML', () => {
    expect(balanceHtml('<b>a')).toBe('<b>a</b>');
    expect(balanceHtml('<b><i>x</b>')).toBe('<b><i>x</i></b>');
    expect(balanceHtml('x</i>y')).toBe('xy');
    expect(balanceHtml('<b>ok</b>')).toBe('<b>ok</b>');
  });
});

describe('promptMessage v2 / promptLayout', () => {
  it('lists every option with its number and description, HTML-escaped', () => {
    const qs = [{ header: 'Lens', question: 'Pick <one>?', options: [{ label: 'a', description: 'desc <x>' }, { label: 'b' }] }];
    const out = promptMessage(qs);
    expect(out).toContain('Pick &lt;one&gt;?');
    expect(out).toContain('1. a');
    expect(out).toContain('— <i>desc &lt;x&gt;</i>');
    expect(out).toContain('2. b');
  });
  it('builds buttons under the cap with short labels and number-reply hint', () => {
    const qs = [{ question: 'q', options: [{ label: 'long label that exceeds forty chars for sure ok' }, { label: 'b' }] }];
    const { options, hint } = promptLayout(qs, 'tok1');
    expect(options).toHaveLength(2);
    expect(options[0].label).toBe('long label that exceeds forty chars for…');
    expect(options[0].callback).toBe('q:answer:tok1:0:0');
    expect(options[1].callback).toBe('q:answer:tok1:0:1');
    expect(hint).toContain('number');
  });
  it('falls back to a numbered list only above the button cap', () => {
    const options = Array.from({ length: 13 }, (_, i) => ({ label: `opt ${i}` }));
    const { options: btns, hint } = promptLayout([{ question: 'q', options }], 'tok1');
    expect(btns).toEqual([]);
    expect(hint).toContain('number');
  });
});

describe('renderHistory v2 / truncateAtWord', () => {
  it('caps by whole messages, never splitting one in half', () => {
    const html = renderHistory(
      [{ role: 'user', text: 'a'.repeat(200) }, { role: 'assistant', text: 'b'.repeat(200) }],
      'proj', 100);
    expect(html).toContain('(truncated)');
    expect(html).toContain('b'.repeat(60)); // il messaggio più recente c'è (troncato)
  });
  it('truncates at a late word boundary with an explicit marker', () => {
    expect(truncateAtWord('aaaa bbb ccc', 10)).toBe('aaaa bbb… (truncated)');
    expect(truncateAtWord('short', 100)).toBe('short');
  });
  it('produces balanced HTML when a truncated message opens a tag', () => {
    const html = renderHistory([{ role: 'assistant', text: '**' + 'a'.repeat(200) + '**' }], 'proj', 100);
    expect(html).toContain('… (truncated)');
    const opens = (html.match(/<b>/g) ?? []).length;
    const closes = (html.match(/<\/b>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});

describe('stopReply', () => {
  it('reports the real outcome for headless sessions', () => {
    expect(stopReply({ kind: 'headless', id8: 'abc12345', aborted: true })).toContain('abc12345');
    expect(stopReply({ kind: 'headless', id8: 'abc', aborted: false, status: 'idle' })).toContain('status: idle');
  });
  it('reports the target for terminal sessions and the no-pane case', () => {
    expect(stopReply({ kind: 'terminal', id8: 'abc', target: 'claude:proj' })).toContain('Ctrl+C');
    expect(stopReply({ kind: 'terminal', id8: 'abc' })).toContain('no tmux');
  });
});

describe('TypingIndicator', () => {
  it('sends immediately and repeats on the interval until stopped', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => {});
      const t = new TypingIndicator(send, 4000);
      t.start();
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4000);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4000);
      expect(send).toHaveBeenCalledTimes(3);
      t.stop();
      await vi.advanceTimersByTimeAsync(8000);
      expect(send).toHaveBeenCalledTimes(3); // fermo dopo stop
    } finally { vi.useRealTimers(); }
  });
  it('start is idempotent', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => {});
      const t = new TypingIndicator(send, 4000);
      t.start();
      t.start();
      expect(send).toHaveBeenCalledTimes(1);
      t.stop();
    } finally { vi.useRealTimers(); }
  });
  it('auto-stops after the safety ceiling when the state gets wedged', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => {});
      const t = new TypingIndicator(send, 4000, 12_000);
      t.start();
      await vi.advanceTimersByTimeAsync(20_000); // ben oltre il ceiling
      const afterCeiling = send.mock.calls.length;
      expect(afterCeiling).toBeGreaterThan(0); // ha inviato prima di fermarsi
      await vi.advanceTimersByTimeAsync(60_000); // poi resta fermo per sempre
      expect(send.mock.calls.length).toBe(afterCeiling);
    } finally { vi.useRealTimers(); }
  });
  it('an active turn keeps re-arming the ceiling, so it does not auto-stop', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn(async () => {});
      const t = new TypingIndicator(send, 4000, 10_000);
      t.start();
      await vi.advanceTimersByTimeAsync(9000);
      t.start(); // nuovo tool_use → re-arm
      await vi.advanceTimersByTimeAsync(9000);
      t.start();
      await vi.advanceTimersByTimeAsync(9000);
      expect(send).toHaveBeenCalledTimes(7); // 1 + (27s / 4s) → sempre attivo, mai auto-stoppato
      t.stop();
    } finally { vi.useRealTimers(); }
  });
  it('stop without start is a no-op', () => {
    const t = new TypingIndicator(async () => {});
    expect(() => t.stop()).not.toThrow();
  });
});

describe('summarizeTool', () => {
  it('identifies every tool call with the gear, then the key field', () => {
    expect(summarizeTool('Bash', { command: 'npm test' })).toBe('⚙️ npm test');
    expect(summarizeTool('WebFetch', { url: 'https://x.com' })).toBe('⚙️ https://x.com');
    expect(summarizeTool('Grep', { pattern: 'TODO' })).toBe('⚙️ TODO');
  });
  it('prefixes Read/Write/Edit with a verb — same path, different action', () => {
    expect(summarizeTool('Read', { file_path: 'src/foo.ts' })).toBe('⚙️ Read src/foo.ts');
    expect(summarizeTool('Write', { file_path: 'src/foo.ts' })).toBe('⚙️ Write src/foo.ts');
    expect(summarizeTool('Edit', { file_path: 'src/foo.ts' })).toBe('⚙️ Edit src/foo.ts');
    expect(summarizeTool('MultiEdit', { file_path: 'src/foo.ts' })).toBe('⚙️ Edit src/foo.ts');
    expect(summarizeTool('NotebookEdit', { notebook_path: 'nb.ipynb' })).toBe('⚙️ Edit nb.ipynb');
  });
  it('summarizes Task (sub-agent) with its description', () => {
    expect(summarizeTool('Task', { description: 'Fix flaky tests', prompt: 'x'.repeat(500) })).toBe('⚙️ Agent: Fix flaky tests');
    expect(summarizeTool('Task', { prompt: 'x'.repeat(500) })).toBe('⚙️ Agent');
  });
  it('summarizes TodoWrite/TodoRead without dumping the todo list', () => {
    expect(summarizeTool('TodoWrite', { todos: [{ content: 'a' }] })).toBe('⚙️ Updates the task list');
    expect(summarizeTool('TodoRead', {})).toBe('⚙️ Updates the task list');
  });
  it('falls back to the tool name and the first string value', () => {
    expect(summarizeTool('SomeTool', { a: 1, b: 'hello' })).toBe('⚙️ SomeTool — hello');
    expect(summarizeTool('SomeTool', { a: 1 })).toBe('⚙️ SomeTool');
  });
  it('truncates long values with an explicit marker', () => {
    const long = 'x'.repeat(200);
    expect(summarizeTool('Bash', { command: long })).toBe(`⚙️ ${'x'.repeat(80)}…`);
  });
});

describe('narrationPlan', () => {
  it('merges short assistant narration into an open burst', () => {
    expect(narrationPlan('assistant', 'Ora leggo X', true)).toBe('merge');
    expect(narrationPlan('assistant', 'x'.repeat(149), true)).toBe('merge');
  });
  it('keeps long text, user text, and closed bursts separate', () => {
    expect(narrationPlan('assistant', 'x'.repeat(150), true)).toBe('separate');
    expect(narrationPlan('assistant', 'Ora leggo X', false)).toBe('separate');
    expect(narrationPlan('user', 'Ora leggo X', true)).toBe('separate');
  });
});

describe('ToolBurstAggregator with throttled sink', () => {
  it('5 consecutive pushes → 1 send + 4 edits (real throttler pacing)', async () => {
    vi.useFakeTimers();
    try {
      const throttler = new EditThrottler(1000);
      const sends: string[] = [];
      const edits: { id: number; text: string }[] = [];
      let nextId = 1;
      const sink: ToolBurstSink = {
        edit: async (id, text) => {
          const ok = await throttler.throttled(async () => { edits.push({ id, text }); return true; });
          return ok ?? false;
        },
        send: async text => {
          const id = await throttler.throttled(async () => { sends.push(text); return nextId++; });
          return id;
        },
      };
      const agg = new ToolBurstAggregator(sink, 3800);
      const p1 = agg.push('t1');
      await vi.advanceTimersByTimeAsync(0);
      const p2 = agg.push('t2');
      await vi.advanceTimersByTimeAsync(1100);
      const p3 = agg.push('t3');
      await vi.advanceTimersByTimeAsync(1100);
      const p4 = agg.push('t4');
      await vi.advanceTimersByTimeAsync(1100);
      const p5 = agg.push('t5');
      await vi.advanceTimersByTimeAsync(1100);
      await Promise.all([p1, p2, p3, p4, p5]);
      expect(sends).toHaveLength(1);
      expect(edits).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  });
});

describe('splitHtmlMessage', () => {
  it('returns a single chunk when the text fits', () => {
    expect(splitHtmlMessage('hello', 100)).toEqual(['hello']);
  });
  it('never emits a chunk longer than max', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    for (const c of splitHtmlMessage(long, 200)) expect(c.length).toBeLessThanOrEqual(200);
  });
  it('loses no visible text across the split', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const joined = splitHtmlMessage(long, 100).join('\n');
    expect(joined.replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });
  it('prefers breaking at a newline', () => {
    const text = `${'a'.repeat(40)}\n${'b'.repeat(40)}`;
    const parts = splitHtmlMessage(text, 50);
    expect(parts[0]).toBe('a'.repeat(40));
    expect(parts[1]).toBe('b'.repeat(40));
  });
  it('closes and reopens an open tag across the boundary', () => {
    const text = `<pre>${'a'.repeat(60)}\n${'b'.repeat(60)}</pre>`;
    const parts = splitHtmlMessage(text, 80);
    expect(parts).toHaveLength(2);
    expect(parts[0].startsWith('<pre>')).toBe(true);
    expect(parts[0].endsWith('</pre>')).toBe(true);
    expect(parts[1].startsWith('<pre>')).toBe(true);
    expect(parts[1].endsWith('</pre>')).toBe(true);
  });
  it('never splits inside a tag', () => {
    const text = `<a href="https://example.com/very/long/path">${'x'.repeat(80)}</a>`;
    for (const c of splitHtmlMessage(text, 60)) {
      expect((c.match(/</g) ?? []).length).toBe((c.match(/>/g) ?? []).length);
    }
  });
  it('hard-splits a single word with no break opportunity', () => {
    const parts = splitHtmlMessage('x'.repeat(250), 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe('x'.repeat(250));
  });
});

describe('isPrivateChat', () => {
  it('accepts a private chat', () => {
    expect(isPrivateChat({ type: 'private' })).toBe(true);
  });
  it('rejects groups, supergroups and channels', () => {
    expect(isPrivateChat({ type: 'group' })).toBe(false);
    expect(isPrivateChat({ type: 'supergroup' })).toBe(false);
    expect(isPrivateChat({ type: 'channel' })).toBe(false);
  });
  it('rejects a missing chat', () => {
    expect(isPrivateChat(undefined)).toBe(false);
  });
});

describe('resolveHeadlessProjectDir', () => {
  it('uses the first configured workspace', () => {
    expect(resolveHeadlessProjectDir(['/tmp/proj', '/tmp/other'])).toEqual({ dir: '/tmp/proj' });
  });
  it('refuses to fall back to the home directory when no workspace is configured', () => {
    const r = resolveHeadlessProjectDir([]);
    expect(r.dir).toBeUndefined();
    expect(r.error).toContain('WORKSPACE_DIRS');
  });
});
