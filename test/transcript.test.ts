import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mungedProjectDir,
  transcriptDirCandidates,
  resolveTranscriptDir,
  newestTranscriptFile,
  TranscriptParser,
  TranscriptTail,
  peekTranscriptState,
  transcriptModel,
  parseAskUserQuestions,
  readRecentMessages,
  resolveSessionTranscript,
  findTranscriptFile,
  transcriptSessionId,
} from '../src/sessions/transcript.js';

function tmpDir(): string { return mkdtempSync(join(tmpdir(), 'orc-tr-')); }

const thinkingLine = JSON.stringify({
  type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'hmm' }], stop_reason: null },
});
const textLine = (id: string, text: string, stop: string | null) => JSON.stringify({
  type: 'assistant', message: { id, model: 'deepseek-v4-flash:0731', content: [{ type: 'text', text }], stop_reason: stop },
});
const toolLine = JSON.stringify({
  type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use' },
});
const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
// linee "user" scritte dal CLI per comandi locali / compattazione — NON prompt
const metaLine = (fields: Record<string, unknown>, text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, ...fields });
const resultLine = JSON.stringify({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
});
const endTurn = textLine('msg_9', 'done', 'end_turn');
const maxTokensLine = JSON.stringify({
  type: 'assistant', message: { id: 'msg_9', content: [], stop_reason: 'max_tokens' },
});

describe('path munging', () => {
  it('munges an absolute path like Claude Code', () => {
    expect(mungedProjectDir('/Users/ontech7/Documents/foo')).toBe('-Users-ontech7-Documents-foo');
    expect(mungedProjectDir('/')).toBe('-');
  });
  it('offers a dots-to-dash variant', () => {
    expect(transcriptDirCandidates('~/.claude/projects', '/home/u/my.app')).toEqual([
      '-home-u-my.app', '-home-u-my-app',
    ]);
  });
});

describe('resolveTranscriptDir / newestTranscriptFile', () => {
  it('resolves the munged dir and picks the newest jsonl', () => {
    const base = tmpDir();
    const dir = join(base, mungedProjectDir('/Users/u/proj'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.jsonl'), '');
    expect(resolveTranscriptDir(base, '/Users/u/proj')).toBe(dir);
    expect(newestTranscriptFile(dir)).toBe(join(dir, 'a.jsonl'));
  });
});

describe('TranscriptParser', () => {
  it('emits assistant text once per message id', () => {
    const p = new TranscriptParser();
    expect(p.consumeLine(thinkingLine)).toEqual([]); // thinking non è testo
    expect(p.consumeLine(textLine('msg_1', 'hello', 'tool_use'))).toEqual([
      { type: 'text', role: 'assistant', text: 'hello' },
    ]);
    expect(p.consumeLine(textLine('msg_1', 'hello', 'tool_use'))).toEqual([]); // già visto
    expect(p.consumeLine(toolLine)).toEqual([
      { type: 'tool', kind: 'tool_use', name: 'Bash', id: 'call_1', input: { command: 'ls' } },
    ]);
  });
  it('emits user text and tool results', () => {
    const p = new TranscriptParser();
    expect(p.consumeLine(userLine('ciao'))).toEqual([{ type: 'text', role: 'user', text: 'ciao' }]);
    expect(p.consumeLine(resultLine)).toEqual([
      { type: 'tool', kind: 'tool_result', name: 'call_1', id: 'call_1', result: 'ok', isError: false },
    ]);
  });
  it('tracks working vs awaiting state', () => {
    const p = new TranscriptParser();
    p.consumeLine(userLine('q'));
    expect(p.state).toBe('working');
    p.consumeLine(toolLine);
    expect(p.state).toBe('working');
    p.consumeLine(endTurn);
    expect(p.state).toBe('awaiting');
  });
  it('emits AskUserQuestion as a prompt and waits for the human', () => {
    const askLine = JSON.stringify({
      type: 'assistant', message: {
        id: 'msg_3',
        content: [{
          type: 'tool_use', id: 'call_m7up16lr', name: 'AskUserQuestion',
          input: { questions: [{ header: 'Lingua', multiSelect: false, question: 'Che lingua?', options: [{ label: 'Italiano', description: 'IT' }, { label: 'Inglese' }] }] },
        }],
        stop_reason: 'tool_use',
      },
    });
    const p = new TranscriptParser();
    const events = p.consumeLine(askLine);
    expect(events).toEqual([{
      type: 'prompt',
      questions: [{ header: 'Lingua', question: 'Che lingua?', multiSelect: false, options: [{ label: 'Italiano', description: 'IT' }, { label: 'Inglese', description: undefined }] }],
    }]);
    expect(p.state).toBe('awaiting');
    expect(p.consumeLine(askLine)).toEqual([]); // già visto
  });
  it('emits an error event and goes awaiting on max_tokens', () => {
    const p = new TranscriptParser();
    const events = p.consumeLine(maxTokensLine);
    expect(events).toEqual([{ type: 'error', message: 'Claude hit the output limit (max_tokens). Ask it to continue.' }]);
    expect(p.state).toBe('awaiting');
    expect(p.consumeLine(maxTokensLine)).toEqual([]); // dedupe: già visto
  });
  it('does not emit an error for end_turn or tool_use lines', () => {
    const p = new TranscriptParser();
    const a = p.consumeLine(toolLine);
    const b = p.consumeLine(endTurn);
    expect(a.some(e => e.type === 'error')).toBe(false);
    expect(b.some(e => e.type === 'error')).toBe(false);
  });
  it('ignores local slash commands (/compact) — no event, state untouched', () => {
    const p = new TranscriptParser();
    p.consumeLine(endTurn); // turno finito → awaiting
    expect(p.state).toBe('awaiting');
    expect(p.consumeLine(userLine('/compact'))).toEqual([]);
    expect(p.state).toBe('awaiting'); // niente end_turn segue: lo stato non deve restare "working"
  });
  it('ignores compaction bookkeeping lines (summary, meta, command echoes)', () => {
    const p = new TranscriptParser();
    p.consumeLine(endTurn);
    expect(p.consumeLine(metaLine({ isCompactSummary: true }, 'This session is being continued from a previous conversation…'))).toEqual([]);
    expect(p.consumeLine(metaLine({ isMeta: true }, '<local-command-caveat>Caveat: …</local-command-caveat>'))).toEqual([]);
    expect(p.consumeLine(userLine('<command-name>/compact</command-name>\n<command-message>compact</command-message>'))).toEqual([]);
    expect(p.consumeLine(userLine('<local-command-stdout>Compacted</local-command-stdout>'))).toEqual([]);
    expect(p.state).toBe('awaiting');
  });
  it('a real user prompt after meta lines still goes through', () => {
    const p = new TranscriptParser();
    p.consumeLine(metaLine({ isCompactSummary: true }, 'summary'));
    expect(p.consumeLine(userLine('fix the bug'))).toEqual([{ type: 'text', role: 'user', text: 'fix the bug' }]);
    expect(p.state).toBe('working');
  });
});

describe('parseAskUserQuestions', () => {
  it('extracts questions and options, skipping garbage', () => {
    expect(parseAskUserQuestions({ questions: [
      { question: 'A?', options: [{ label: '1' }] },
      { header: 'H', question: 'B?', multiSelect: true, options: [{ label: 'x', description: 'd' }] },
      { question: 42 },
    ] })).toEqual([
      { header: undefined, question: 'A?', multiSelect: false, options: [{ label: '1', description: undefined }] },
      { header: 'H', question: 'B?', multiSelect: true, options: [{ label: 'x', description: 'd' }] },
    ]);
  });
  it('returns empty on missing/invalid questions', () => {
    expect(parseAskUserQuestions({})).toEqual([]);
    expect(parseAskUserQuestions(undefined)).toEqual([]);
  });
});

describe('TranscriptTail', () => {
  it('starts at the end (no replay) and streams new lines', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, userLine('old') + '\n' + textLine('m0', 'old reply', 'end_turn') + '\n');
    const tail = new TranscriptTail(file);
    expect(tail.poll().events).toEqual([]); // la storia non si riproduce
    appendFileSync(file, userLine('new') + '\n');
    const { events, state } = tail.poll();
    expect(events).toEqual([{ type: 'text', role: 'user', text: 'new' }]);
    expect(state).toBe('working');
  });
  it('handles a trailing partial line', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, '');
    const tail = new TranscriptTail(file);
    appendFileSync(file, userLine('half')); // senza newline: riga ancora in scrittura
    expect(tail.poll().events).toEqual([]);
    appendFileSync(file, '\n'); // ora la riga è completa
    expect(tail.poll().events).toEqual([{ type: 'text', role: 'user', text: 'half' }]);
  });
  it('recovers from a rewritten (shrunk) file without replaying', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, userLine('a') + '\n' + userLine('b') + '\n');
    const tail = new TranscriptTail(file);
    expect(tail.poll().events).toEqual([]);
    writeFileSync(file, userLine('c') + '\n'); // riscritto e accorciato
    const { events } = tail.poll();
    expect(events).toEqual([]); // salta al nuovo EOF
    appendFileSync(file, userLine('d') + '\n');
    expect(tail.poll().events).toEqual([{ type: 'text', role: 'user', text: 'd' }]);
  });
});

describe('peekTranscriptState / transcriptModel', () => {
  it('peeks the last line state', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, userLine('a') + '\n' + endTurn + '\n');
    expect(peekTranscriptState(file)).toBe('awaiting');
  });
  it('peeks awaiting after a max_tokens line', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, userLine('a') + '\n' + maxTokensLine + '\n');
    expect(peekTranscriptState(file)).toBe('awaiting');
  });
  it('peeks the previous real state (not "working") when the last line is a compact summary', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, userLine('a') + '\n' + endTurn + '\n' + metaLine({ isCompactSummary: true }, 'summary…') + '\n');
    // la riga meta è ignorata e lo stato precedente (end_turn → awaiting) vince:
    // non deve riaccendere "sta scrivendo…"
    expect(peekTranscriptState(file)).toBe('awaiting');
  });
  it('peeks the previous real state (not "working") when the last line is a slash command', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, endTurn + '\n' + userLine('/compact') + '\n');
    expect(peekTranscriptState(file)).toBe('awaiting');
  });
  it('reads the model from the first assistant message', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, userLine('a') + '\n' + textLine('m1', 'hi', 'end_turn') + '\n');
    expect(transcriptModel(file)).toBe('deepseek-v4-flash:0731');
  });
});

describe('readRecentMessages / resolveSessionTranscript', () => {
  it('returns the last text messages, skipping tools and thinking', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, [
      userLine('primo'),
      textLine('m1', 'risposta 1', 'tool_use'),
      toolLine,
      textLine('m2', 'risposta 2', 'end_turn'),
      userLine('secondo'),
      textLine('m3', 'risposta 3', 'end_turn'),
    ].join('\n') + '\n');
    const msgs = readRecentMessages(file, 10);
    expect(msgs).toEqual([
      { role: 'user', text: 'primo' },
      { role: 'assistant', text: 'risposta 1' },
      { role: 'assistant', text: 'risposta 2' },
      { role: 'user', text: 'secondo' },
      { role: 'assistant', text: 'risposta 3' },
    ]);
  });
  it('respects max, keeping the newest messages', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, [userLine('a'), userLine('b'), userLine('c')].join('\n') + '\n');
    expect(readRecentMessages(file, 2)).toEqual([{ role: 'user', text: 'b' }, { role: 'user', text: 'c' }]);
  });
  it('skips slash commands and compaction noise in history', () => {
    const dir = tmpDir();
    const file = join(dir, 's.jsonl');
    writeFileSync(file, [
      endTurn,
      userLine('/compact'),
      metaLine({ isCompactSummary: true }, 'huge summary'),
      metaLine({ isMeta: true }, '<local-command-caveat>…'),
      userLine('<local-command-stdout>Compacted</local-command-stdout>'),
      userLine('real question'),
    ].join('\n') + '\n');
    expect(readRecentMessages(file, 10)).toEqual([{ role: 'assistant', text: 'done' }, { role: 'user', text: 'real question' }]);
  });
  it('returns [] for missing/empty files', () => {
    expect(readRecentMessages(join(tmpDir(), 'nope.jsonl'))).toEqual([]);
  });
  it('resolves by claudeSessionId, falling back to the newest file', () => {
    const base = tmpDir();
    const dir = join(base, mungedProjectDir('/Users/u/proj'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'abc.jsonl'), '');
    writeFileSync(join(dir, 'xyz.jsonl'), '');
    // mtime espliciti: due file creati in rapida successione possono avere
    // mtime identici (granularità del fs) → l'ordine di readdir vincerebbe.
    utimesSync(join(dir, 'abc.jsonl'), new Date(), new Date(Date.now() - 10_000));
    utimesSync(join(dir, 'xyz.jsonl'), new Date(), new Date());
    expect(resolveSessionTranscript(base, '/Users/u/proj', 'abc')).toBe(join(dir, 'abc.jsonl'));
    expect(resolveSessionTranscript(base, '/Users/u/proj')).toBe(join(dir, 'xyz.jsonl')); // più recente
    expect(resolveSessionTranscript(base, '/Users/u/other')).toBeUndefined();
  });
  it('does not fall back to a PREVIOUS session transcript for a fresh session', () => {
    const base = tmpDir();
    const dir = join(base, mungedProjectDir('/Users/u/proj'));
    mkdirSync(dir, { recursive: true });
    const prev = join(dir, 'prev.jsonl');
    writeFileSync(prev, '');
    const sessionCreatedMs = Date.now();
    utimesSync(prev, new Date(sessionCreatedMs - 60_000), new Date(sessionCreatedMs - 60_000));
    // il file è più vecchio della sessione → appartiene a una sessione precedente
    expect(resolveSessionTranscript(base, '/Users/u/proj', undefined, sessionCreatedMs)).toBeUndefined();
    // senza guardia (param omesso) il comportamento resta quello storico
    expect(resolveSessionTranscript(base, '/Users/u/proj', undefined)).toBe(prev);
  });
  it('falls back to the newest file when it was created after the session', () => {
    const base = tmpDir();
    const dir = join(base, mungedProjectDir('/Users/u/proj'));
    mkdirSync(dir, { recursive: true });
    const prev = join(dir, 'prev.jsonl');
    writeFileSync(prev, '');
    const own = join(dir, 'own.jsonl');
    writeFileSync(own, '');
    utimesSync(prev, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    utimesSync(own, new Date(), new Date());
    expect(resolveSessionTranscript(base, '/Users/u/proj', undefined, Date.now() - 5000)).toBe(own);
  });
});

describe('findTranscriptFile / transcriptSessionId', () => {
  it('finds a relocated transcript by basename across project dirs (git worktree)', () => {
    const base = tmpDir();
    const wt = join(base, mungedProjectDir('/Users/u/proj/.claude/worktrees/fix'));
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'abc.jsonl'), '');
    expect(findTranscriptFile(base, 'abc.jsonl')).toBe(join(wt, 'abc.jsonl'));
  });
  it('returns undefined when the file is nowhere', () => {
    const base = tmpDir();
    expect(findTranscriptFile(base, 'abc.jsonl')).toBeUndefined();
  });
  it('rejects unsafe basenames (traversal, subdirs, wrong extension)', () => {
    const base = tmpDir();
    expect(findTranscriptFile(base, '../evil.jsonl')).toBeUndefined();
    expect(findTranscriptFile(base, 'a/b.jsonl')).toBeUndefined();
    expect(findTranscriptFile(base, 'x.txt')).toBeUndefined();
    expect(findTranscriptFile(base, '')).toBeUndefined();
  });
  it('reads the session id from a transcript', () => {
    const dir = tmpDir();
    const file = join(dir, 'abc.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'mode', sessionId: 'abc-123' }) + '\n');
    expect(transcriptSessionId(file)).toBe('abc-123');
  });
  it('returns undefined for a transcript without a sessionId', () => {
    const dir = tmpDir();
    const file = join(dir, 'abc.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'assistant', message: {} }) + '\n');
    expect(transcriptSessionId(file)).toBeUndefined();
  });
  it('returns undefined for a missing file', () => {
    expect(transcriptSessionId(join(tmpDir(), 'nope.jsonl'))).toBeUndefined();
  });
});

describe('resolveSessionTranscript with recordedFile', () => {
  it('keeps returning the recorded file while it exists', () => {
    const base = tmpDir();
    const main = join(base, mungedProjectDir('/Users/u/proj'));
    mkdirSync(main, { recursive: true });
    const recorded = join(main, 'abc.jsonl');
    writeFileSync(recorded, '');
    expect(resolveSessionTranscript(base, '/Users/u/proj', undefined, undefined, recorded)).toBe(recorded);
  });
  it('re-resolves a stale recorded path to the relocated transcript (worktree)', () => {
    const base = tmpDir();
    const main = join(base, mungedProjectDir('/Users/u/proj'));
    const wt = join(base, mungedProjectDir('/Users/u/proj/.claude/worktrees/fix'));
    mkdirSync(main, { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'abc.jsonl'), '');
    const recorded = join(main, 'abc.jsonl'); // registrato, ormai non esiste
    expect(resolveSessionTranscript(base, '/Users/u/proj', undefined, undefined, recorded)).toBe(join(wt, 'abc.jsonl'));
  });
  it('falls back to the newest project transcript when the recorded file is gone everywhere', () => {
    const base = tmpDir();
    const main = join(base, mungedProjectDir('/Users/u/proj'));
    mkdirSync(main, { recursive: true });
    const recorded = join(main, 'abc.jsonl'); // non esiste da nessuna parte
    writeFileSync(join(main, 'def.jsonl'), '');
    expect(resolveSessionTranscript(base, '/Users/u/proj', undefined, undefined, recorded)).toBe(join(main, 'def.jsonl'));
  });
});
