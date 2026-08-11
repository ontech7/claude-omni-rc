import { describe, it, expect, vi } from 'vitest';
import { resolveHeadlessProjectDir, isPrivateChat, parseCommand, parseNewFlags, parseSettingsCommand, formatSettingsReport, formatSettingsKey, parseCallbackData, permissionMessage, permissionKeyboard, sessionListText, EditThrottler, attachmentPlan, stripAnsi, relativeTime, ToolBurstAggregator, promptMessage, promptLayout, matchesInjected, renderHistory, stopReply, TypingIndicator, narrationPlan, answerSummary, answerToKeys, answersToMessage, parseNumericReply, dialogMessage, dialogKeyboard, formatPct, formatResetAt, gateSessionEvent, diagReport, promptDedupeKey, registerPromptKey, formatPaneContext, PROMPT_DEDUPE_MAX_AGE_MS } from '../bot/telegram.js';
import type { ToolBurstSink, PromptKeyEntry } from '../bot/telegram.js';
import { truncateAtWord, mdToHtml, splitHtmlMessage } from '../bot/render.js';
import { loadConfig } from '../src/config.js';

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
    expect(parseNewFlags('--model deepseek-v4-flash:cloud refactor')).toEqual({ model: 'deepseek-v4-flash:cloud', text: 'refactor' });
    expect(parseNewFlags('--standard --model claude-sonnet-4-5 fix the bug')).toEqual({ mode: 'standard', model: 'claude-sonnet-4-5', text: 'fix the bug' });
    expect(parseNewFlags('--model m1 --auto go')).toEqual({ mode: 'auto', model: 'm1', text: 'go' });
  });
  it('parses --effort alongside the other flags, in any order', () => {
    expect(parseNewFlags('--effort high think')).toEqual({ effort: 'high', text: 'think' });
    expect(parseNewFlags('--standard --effort low go')).toEqual({ mode: 'standard', effort: 'low', text: 'go' });
    expect(parseNewFlags('--effort ultra think')).toEqual({ text: '--effort ultra think' }); // livello invalido → flag non consumato
  });
});

describe('parseSettingsCommand', () => {
  it('returns all for an empty argument', () => {
    expect(parseSettingsCommand('')).toEqual({ kind: 'all' });
    expect(parseSettingsCommand('   ')).toEqual({ kind: 'all' });
  });
  it('shows a single known key', () => {
    expect(parseSettingsCommand('defaultModel')).toEqual({ kind: 'show', key: 'defaultModel' });
  });
  it('sets a value, joining the rest of the line', () => {
    expect(parseSettingsCommand('defaultModel claude-opus-5')).toEqual({ kind: 'set', key: 'defaultModel', value: 'claude-opus-5' });
    expect(parseSettingsCommand('maxHeadlessSessions 3')).toEqual({ kind: 'set', key: 'maxHeadlessSessions', value: '3' });
  });
  it('resets a key', () => {
    expect(parseSettingsCommand('reset defaultEffort')).toEqual({ kind: 'reset', key: 'defaultEffort' });
  });
  it('rejects an unknown key with the known list', () => {
    const c = parseSettingsCommand('bogus');
    expect(c.kind).toBe('invalid');
  });
  it('rejects a reset without a known key', () => {
    expect(parseSettingsCommand('reset').kind).toBe('invalid');
    expect(parseSettingsCommand('reset bogus').kind).toBe('invalid');
  });
});

describe('formatSettingsReport', () => {
  const config = loadConfig({}, { defaultModel: 'claude-opus-5' });
  it('lists every curated key with its effective value and source', () => {
    const out = formatSettingsReport({ defaultModel: 'claude-opus-5' }, config);
    expect(out).toContain('defaultModel');
    expect(out).toContain('claude-opus-5');
    expect(out).toContain('settings.json');
  });
  it('marks keys that come from .env / default and escapes dynamic values', () => {
    const out = formatSettingsReport({}, config);
    expect(out).toContain('.env / default');
    expect(out).toContain('next daemon restart');
    expect(out).not.toContain('<script>');
  });
  it('shows the stored value, not the boot value, when a key is present in settings.json', () => {
    const boot = loadConfig({ DEFAULT_MODEL: 'from-env' }); // valore di boot diverso dal file
    const out = formatSettingsReport({ defaultModel: 'claude-opus-5' }, boot);
    expect(out).toContain('claude-opus-5');
    expect(out).not.toContain('from-env');
  });
  it('formats a single key via formatSettingsKey', () => {
    const out = formatSettingsKey('defaultEffort', {}, config);
    expect(out).toContain('defaultEffort');
    expect(out).toContain('/settings reset defaultEffort');
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
    // opzioni togglate + testo libero insieme (multi-select con Other).
    expect(answerSummary({ kind: 'option', labels: ['A'], extraText: 'custom' })).toBe('A, custom');
    expect(answerSummary({ kind: 'option', labels: [], extraText: 'custom' })).toBe('custom');
  });

  it('answerToKeys: single-select navigates Down to the option and presses Enter', () => {
    const key = (k: string) => ({ kind: 'key' as const, key: k });
    // A è la prima opzione (riga 1): nessun Down, Enter subito.
    expect(answerToKeys(q, { kind: 'option', labels: ['A'] })).toEqual([key('Enter')]);
    // B è la seconda (riga 2): un Down, poi Enter.
    expect(answerToKeys(q, { kind: 'option', labels: ['B'] })).toEqual([key('Down'), key('Enter')]);
    // C è la terza (riga 3): due Down, poi Enter.
    expect(answerToKeys(q, { kind: 'option', labels: ['C'] })).toEqual([key('Down'), key('Down'), key('Enter')]);
  });

  it('answerToKeys: multiSelect toggles by number, then Submit + confirmation', () => {
    const key = (k: string) => ({ kind: 'key' as const, key: k });
    const mq = { question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
    // N=3: toggle di B e C coi tasti 2 e 3, poi Down×(N+1)=4 fino a Submit,
    // Enter (schermata di conferma) e Enter (invia).
    expect(answerToKeys(mq, { kind: 'option', labels: ['B', 'C'] })).toEqual([
      key('2'), key('3'),
      key('Down'), key('Down'), key('Down'), key('Down'),
      key('Enter'), key('Enter'),
    ]);
    // Una sola opzione: un solo toggle, stesso percorso Submit.
    expect(answerToKeys(mq, { kind: 'option', labels: ['A'] })).toEqual([
      key('1'),
      key('Down'), key('Down'), key('Down'), key('Down'),
      key('Enter'), key('Enter'),
    ]);
  });

  it('answerToKeys: other free text goes to "Type something" and confirms', () => {
    // single-select: Down×N (riga "Type something."), testo, Enter (invia subito).
    expect(answerToKeys(q, { kind: 'other', text: 'custom' })).toEqual([
      { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Down' },
      { kind: 'text', text: 'custom' },
      { kind: 'key', key: 'Enter' },
    ]);
    // multi-select: dopo il testo, Down (→Submit), Enter (conferma), Enter (invia).
    const mq = { question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
    expect(answerToKeys(mq, { kind: 'other', text: 'x' })).toEqual([
      { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Down' },
      { kind: 'text', text: 'x' },
      { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Enter' }, { kind: 'key', key: 'Enter' },
    ]);
  });

  it('answerToKeys: unknown labels produce no keys (nothing to inject)', () => {
    expect(answerToKeys(q, { kind: 'option', labels: ['unknown'] })).toEqual([]);
  });

  it('answerToKeys: multiSelect with toggled options AND free text toggles the options, then types into "Type something"', () => {
    const key = (k: string) => ({ kind: 'key' as const, key: k });
    const mq = { question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
    // N=3: toggle di A (tasto 1), Down×3 fino a "Type something", testo,
    // Down (→Submit), Enter, Enter (review). Ultima domanda di un set di 1.
    expect(answerToKeys(mq, { kind: 'option', labels: ['A'], extraText: 'custom' })).toEqual([
      key('1'),
      key('Down'), key('Down'), key('Down'),
      { kind: 'text', text: 'custom' },
      key('Down'), key('Enter'), key('Enter'),
    ]);
    // Non-ultima di un set di 3: un solo Enter finale (su Next).
    expect(answerToKeys(mq, { kind: 'option', labels: ['A'], extraText: 'custom' }, { isLast: false, setSize: 3 })).toEqual([
      key('1'),
      key('Down'), key('Down'), key('Down'),
      { kind: 'text', text: 'custom' },
      key('Down'), key('Enter'),
    ]);
  });

  it('answerToKeys: multiSelect in a NON-last position uses a single Enter on Next (no review yet)', () => {
    const key = (k: string) => ({ kind: 'key' as const, key: k });
    const mq = { question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
    // set di 3 domande, questa è la prima: isLast=false → un solo Enter finale.
    expect(answerToKeys(mq, { kind: 'option', labels: ['B'] }, { isLast: false, setSize: 3 })).toEqual([
      key('2'),
      key('Down'), key('Down'), key('Down'), key('Down'),
      key('Enter'),
    ]);
    // last in un set di 3 → Submit + Enter (review) + Enter (conferma).
    expect(answerToKeys(mq, { kind: 'option', labels: ['B'] }, { isLast: true, setSize: 3 })).toEqual([
      key('2'),
      key('Down'), key('Down'), key('Down'), key('Down'),
      key('Enter'), key('Enter'),
    ]);
  });

  it('answerToKeys: single-select as the last question of a multi-question set adds the review Enter', () => {
    const key = (k: string) => ({ kind: 'key' as const, key: k });
    // ultima domanda di un set di 2 → select + Enter (review) + Enter (conferma).
    expect(answerToKeys(q, { kind: 'option', labels: ['B'] }, { isLast: true, setSize: 2 })).toEqual([
      key('Down'), key('Enter'), key('Enter'),
    ]);
    // domanda intermedia di un set di 3 → select + Enter, avanza soltanto.
    expect(answerToKeys(q, { kind: 'option', labels: ['B'] }, { isLast: false, setSize: 3 })).toEqual([
      key('Down'), key('Enter'),
    ]);
  });

  it('answerToKeys: other free text honors the set position too', () => {
    // other su multiSelect non-ultima: Down×N, testo, Down (→Next), Enter.
    const mq = { question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] };
    expect(answerToKeys(mq, { kind: 'other', text: 'x' }, { isLast: false, setSize: 3 })).toEqual([
      { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Down' },
      { kind: 'text', text: 'x' },
      { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Enter' },
    ]);
    // other su single-select ultima di un set di 2: Down×N, testo, Enter, Enter (review).
    expect(answerToKeys(q, { kind: 'other', text: 'custom' }, { isLast: true, setSize: 2 })).toEqual([
      { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Down' }, { kind: 'key', key: 'Down' },
      { kind: 'text', text: 'custom' },
      { kind: 'key', key: 'Enter' }, { kind: 'key', key: 'Enter' },
    ]);
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
      { id: 'aaa', kind: 'headless', title: 't1', projectDir: '/x', model: 'deepseek-v4-flash:cloud', status: 'idle', lastActivity: '2026-08-05T12:00:00.000Z', createdAt: '' },
      { id: 'bbb', kind: 'terminal', title: 't2', projectDir: '/y', tmuxTarget: 'claude:my-branch', status: 'running', lastActivity: new Date().toISOString(), createdAt: '' },
    ] as any;
    const txt = sessionListText(sessions, 'bbb');
    expect(txt).toContain('▸');
    expect(txt).toContain('running');
    expect(txt).toContain('claude:my-branch'); // per le terminali il target tmux
    expect(txt).toContain('deepseek-v4-flash:cloud'); // per le headless il modello
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
  it('marks as failed the line of the corresponding tool', async () => {
    const edits: string[] = [];
    const agg = new ToolBurstAggregator({
      edit: async (_id, text) => { edits.push(text); return true; },
      send: async () => 1,
    });
    await agg.push('📖 <b>Read</b>', 'tu-1');
    await agg.push('⚡ <b>Bash</b>', 'tu-2');
    await agg.markFailed('tu-2', 'command not found');
    const last = edits[edits.length - 1];
    expect(last).toContain('❌ ⚡ <b>Bash</b>');
    expect(last).toContain('command not found');
    expect(last).toContain('📖 <b>Read</b>');   // the healthy line stays intact
    expect(last).not.toContain('❌ 📖');
  });
  it('ignores a failure for a tool that is not in the bubble', async () => {
    const agg = new ToolBurstAggregator({ edit: async () => true, send: async () => 1 });
    await agg.push('📖 <b>Read</b>', 'tu-1');
    await expect(agg.markFailed('unknown', 'boom')).resolves.toBeUndefined();
  });
  it('ignores a failure after the bubble is closed', async () => {
    let edited = false;
    const agg = new ToolBurstAggregator({
      edit: async () => { edited = true; return true; },
      send: async () => 1,
    });
    await agg.push('⚡ <b>Bash</b>', 'tu-1');
    agg.close();
    await agg.markFailed('tu-1', 'boom');
    expect(edited).toBe(false); // reopening would break chronological order
  });
  it('collapses the bubble into an expandable blockquote with the count', async () => {
    const edits: string[] = [];
    const agg = new ToolBurstAggregator({
      edit: async (_id, t) => { edits.push(t); return true; },
      send: async () => 1,
    });
    await agg.push('📖 <b>Read</b>', 'a');
    await agg.push('⚡ <b>Bash</b>', 'b');
    await agg.collapse();
    const last = edits[edits.length - 1];
    expect(last).toContain('<blockquote expandable>');
    expect(last).toContain('2 steps');
    expect(last).toContain('📖 <b>Read</b>');
  });
  it('does not collapse a bubble with a single line', async () => {
    const edits: string[] = [];
    const agg = new ToolBurstAggregator({
      edit: async (_id, t) => { edits.push(t); return true; },
      send: async () => 1,
    });
    await agg.push('📖 <b>Read</b>', 'a');
    await agg.collapse();
    expect(edits.some(e => e.includes('<blockquote'))).toBe(false);
  });
});

describe('continuation marker', () => {
  it('does not appear with a single part', () => {
    const parts = splitHtmlMessage('short');
    expect(parts.length).toBe(1);
  });

  it('the marker space does not push past the Telegram limit', () => {
    const parts = splitHtmlMessage('x'.repeat(12_000));
    for (let i = 0; i < parts.length; i++) {
      const withLabel = `${parts[i]}\n<i>(${i + 1}/${parts.length})</i>`;
      expect(withLabel.length).toBeLessThan(4096);
    }
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

describe('gateSessionEvent', () => {
  const base = { kind: 'text' as const, armed: true, sessionId: 's1', activeSessionId: 's1' };

  it('delivers a text event for the selected session', () => {
    expect(gateSessionEvent(base)).toEqual({ deliver: true });
  });

  it('drops everything while disarmed, whatever the kind', () => {
    for (const kind of ['text', 'tool', 'error', 'result', 'prompt', 'permission', 'dialog'] as const) {
      expect(gateSessionEvent({ ...base, kind, armed: false })).toEqual({ deliver: false, reason: 'not-armed' });
    }
  });

  it('drops stream events belonging to a session that is not selected', () => {
    expect(gateSessionEvent({ ...base, sessionId: 's2' }))
      .toEqual({ deliver: false, reason: 'not-active-session' });
  });

  it('never drops a blocking interaction for being unselected — it would wedge that session', () => {
    for (const kind of ['prompt', 'permission', 'dialog'] as const) {
      expect(gateSessionEvent({ ...base, kind, sessionId: 's2' })).toEqual({ deliver: true });
    }
  });

  it('drops the echo of text the bot itself injected', () => {
    expect(gateSessionEvent({ ...base, isInjectedEcho: true }))
      .toEqual({ deliver: false, reason: 'injected-echo' });
  });

  it('reports the first applicable reason: disarmed wins over everything', () => {
    expect(gateSessionEvent({ ...base, armed: false, sessionId: 's2', isInjectedEcho: true }))
      .toEqual({ deliver: false, reason: 'not-armed' });
  });

  it('reports not-active-session over injected-echo — the echo reason must only ever describe the selected session', () => {
    expect(gateSessionEvent({ ...base, sessionId: 's2', isInjectedEcho: true }))
      .toEqual({ deliver: false, reason: 'not-active-session' });
  });
});

describe('promptDedupeKey', () => {
  const q = [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }];

  // La chiave è SEMPRE la firma del contenuto: l'hook di 2.1.227 non porta il
  // tool_use_id nel payload, quindi la firma è l'unica chiave condivisa fra la
  // copia dell'hook e quella del transcript della STESSA domanda. Se la chiave
  // dipendesse dal toolUseId, le due copie non colliderebbero mai e la domanda
  // arriverebbe due volte (bug "è arrivata doppia").
  it('keys on the content signature, ignoring any toolUseId — the hook and transcript copies of the same question must collide', () => {
    expect(promptDedupeKey('s1', q)).toBe(promptDedupeKey('s1', q));
    expect(promptDedupeKey('s1', q)).toBe(promptDedupeKey('s1', [{ question: 'Deploy now?', options: [{ label: 'Yes' }, { label: 'No' }] }]));
    expect(promptDedupeKey('s1', q)).not.toBe(promptDedupeKey('s2', q)); // sessione diversa → chiave diversa
    expect(promptDedupeKey('s1', q)).not.toBe(promptDedupeKey('s1', [{ question: 'different', options: [] }])); // contenuto diverso → chiave diversa
  });
});

describe('registerPromptKey', () => {
  const entry = (key: string, at: number): PromptKeyEntry => ({ key, at });

  it('registers a new key as not-duplicate and adds it to the seen list', () => {
    const { duplicate, seen } = registerPromptKey([], 'id:toolu_1', { now: 1000 });
    expect(duplicate).toBe(false);
    expect(seen).toEqual([entry('id:toolu_1', 1000)]);
  });

  it('reports an id: key already in the list as a permanent duplicate — a toolUseId is unique per tool call, so it is left registered exactly as before this fix (no one-shot, no age expiry)', () => {
    const { duplicate, seen } = registerPromptKey([entry('id:toolu_1', 1000)], 'id:toolu_1', { now: 2000 });
    expect(duplicate).toBe(true);
    expect(seen).toEqual([entry('id:toolu_1', 1000)]); // non consumata, timestamp intatto
  });

  it('evicts the oldest key once the cap is exceeded (FIFO)', () => {
    const { seen } = registerPromptKey([entry('a', 1), entry('b', 2)], 'c', { cap: 2, now: 3 });
    expect(seen).toEqual([entry('b', 2), entry('c', 3)]);
  });

  // Fix round 1 (Important) — reproduction dell'issue segnalata dalla review:
  // senza toolUseId, la chiave di fallback è una firma di testo+opzioni. Una
  // seconda domanda REALMENTE nuova ma con lo stesso testo e le stesse
  // opzioni (es. "Continue? Yes/No" ripetuto nella stessa sessione) deve
  // essere mostrata, non scartata come falso duplicato della prima. Prima del
  // fix (commit c75bb05) questo falliva: la chiave restava registrata per
  // sempre dopo il primo scarto e la seconda domanda genuina spariva — la
  // stessa sparizione muta che questo task esiste per eliminare, reintrodotta
  // nel percorso degradato.
  it('sig: keys are one-shot — a matching hit consumes the key, so a genuinely later identical question is shown, not dropped as a false duplicate', () => {
    let seen: PromptKeyEntry[] = [];
    const hookArrival = registerPromptKey(seen, 'sig:s1:Continue?|Yes,No', { now: 1000 });
    expect(hookArrival.duplicate).toBe(false); // prima domanda, dall'hook
    seen = hookArrival.seen;
    const transcriptArrival = registerPromptKey(seen, 'sig:s1:Continue?|Yes,No', { now: 1500 });
    expect(transcriptArrival.duplicate).toBe(true); // copia dal transcript, scartata
    seen = transcriptArrival.seen;
    expect(seen).toEqual([]); // la chiave è stata consumata, non solo "trovata"
    const secondQuestion = registerPromptKey(seen, 'sig:s1:Continue?|Yes,No', { now: 60_000 });
    expect(secondQuestion.duplicate).toBe(false); // domanda nuova, stessa firma — deve arrivare
  });

  // Se il transcript non scrive mai la sua copia (sessione finita, cancellata
  // o /stop mentre la domanda era in sospeso) la chiave 'sig:' non deve
  // restare viva per sempre: scade dopo PROMPT_DEDUPE_MAX_AGE_MS, così la
  // prossima domanda identica non trova più nulla da "consumare" e passa. Il
  // bound è volutamente largo (30 minuti): AskUserQuestion non ha un timeout
  // proprio e una risposta a mano al terminale può richiedere molti minuti.
  it('a sig: key with no matching duplicate expires after PROMPT_DEDUPE_MAX_AGE_MS, instead of blocking the next identical question forever', () => {
    const seen = [entry('sig:s1:Continue?|Yes,No', 0)];
    const stillAlive = registerPromptKey(seen, 'sig:s1:Continue?|Yes,No', { now: PROMPT_DEDUPE_MAX_AGE_MS - 1 });
    expect(stillAlive.duplicate).toBe(true); // entro il bound, ancora in attesa della sua copia
    const expired = registerPromptKey(seen, 'sig:s1:Continue?|Yes,No', { now: PROMPT_DEDUPE_MAX_AGE_MS + 1 });
    expect(expired.duplicate).toBe(false); // oltre il bound, la chiave scaduta non blocca più nulla
  });

  it('does not apply the age bound to id: keys — a toolUseId never expires by design', () => {
    const seen = [entry('id:toolu_1', 0)];
    const { duplicate } = registerPromptKey(seen, 'id:toolu_1', { now: PROMPT_DEDUPE_MAX_AGE_MS * 10 });
    expect(duplicate).toBe(true);
  });
});

describe('formatPaneContext', () => {
  it('strips ANSI, drops empty lines, and wraps the last N non-empty lines in a fixed-width block', () => {
    const pane = '\x1b[32m$ npm test\x1b[0m\n\n  passing (12)\n\n';
    const out = formatPaneContext(pane, 20);
    expect(out).toContain('<pre>');
    expect(out).toContain('$ npm test');
    expect(out).toContain('passing (12)');
    expect(out).not.toContain('\x1b');
  });

  it('keeps only the last maxLines non-empty lines', () => {
    const pane = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const out = formatPaneContext(pane, 5);
    expect(out).toContain('line 29');
    expect(out).not.toContain('line 24');
  });

  it('returns an empty string when there is nothing to show — the caller treats this as "no context", not an empty block', () => {
    expect(formatPaneContext('\n\n   \n')).toBe('');
    expect(formatPaneContext('')).toBe('');
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

describe('diagReport', () => {
  const snapshot = {
    version: '0.2.0',
    armed: true,
    chatBound: true,
    activeSessionId: 'aaaaaaaa-1111',
    sessions: [
      { id: 'aaaaaaaa-1111', kind: 'terminal' as const, status: 'idle' as const, title: 'my-proj', transcript: 'abc.jsonl', hasTmux: true },
      { id: 'bbbbbbbb-2222', kind: 'headless' as const, status: 'running' as const, title: 'task', hasTmux: false },
    ],
    pending: { permissions: 1, dialogs: 0, questionFlows: 2 },
    recentErrors: ['{"level":"error","msg":"telegram send failed"}'],
  };

  it('reports armed state, version and the selected session', () => {
    const out = diagReport(snapshot);
    expect(out).toContain('0.2.0');
    expect(out).toContain('armed');
    expect(out).toContain('aaaaaaaa'); // id abbreviato della sessione selezionata
  });

  it('lists every session with kind, status and whether it can receive input', () => {
    const out = diagReport(snapshot);
    expect(out).toContain('my-proj');
    expect(out).toContain('terminal');
    expect(out).toContain('headless');
    expect(out).toContain('running');
  });

  it('reports the pending interactions, which are what wedges a session', () => {
    const out = diagReport(snapshot);
    expect(out).toMatch(/permissions.*1/);
    expect(out).toMatch(/questions.*2/);
  });

  it('includes the recent errors and escapes them for HTML', () => {
    const out = diagReport({ ...snapshot, recentErrors: ['<script>&'] });
    expect(out).toContain('&lt;script&gt;&amp;');
    expect(out).not.toContain('<script>');
  });

  it('says so plainly when nothing is tracked', () => {
    const out = diagReport({ ...snapshot, sessions: [], recentErrors: [], pending: { permissions: 0, dialogs: 0, questionFlows: 0 } });
    expect(out).toContain('no sessions');
    expect(out).toContain('no recent errors');
  });

  // M3: un record JSON con stack trace espansa può superare largamente 300
  // caratteri — venti di questi sfondano il limite di un messaggio Telegram e
  // spaccano /diag in dieci-più chunk per un solo comando.
  it('truncates a long recent-error line with a visible marker instead of rendering it verbatim', () => {
    const longLine = JSON.stringify({ level: 'error', msg: 'boom', stack: 'x'.repeat(500) });
    const out = diagReport({ ...snapshot, recentErrors: [longLine] });
    expect(out).not.toContain(longLine);
    expect(out).toContain('(truncated)');
    // il ring stesso (recentErrors passato in input) non è quello che si tronca:
    // solo la resa — la stringa originale resta quella lunga in input, sopra.
    expect(longLine.length).toBeGreaterThan(300);
  });

  it('shows model, effort and branch per session, with — when unknown', () => {
    const s = {
      ...snapshot,
      sessions: [
        { id: 'aaaaaaaa-1111', kind: 'terminal' as const, status: 'idle' as const, title: 'my-proj', transcript: 'a.jsonl', hasTmux: true, model: 'claude-sonnet-4-5', effort: 'high' as const, branch: 'main' },
        { id: 'bbbbbbbb-2222', kind: 'headless' as const, status: 'running' as const, title: 'task', hasTmux: false },
      ],
    };
    const out = diagReport(s);
    expect(out).toContain('claude-sonnet-4-5');
    expect(out).toContain('high');
    expect(out).toContain('main');
    expect(out).toMatch(/— · —/); // la headless senza dati mostra i segnaposto
  });
});
