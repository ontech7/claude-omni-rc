import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { TranscriptWatcher, TRANSCRIPT_SWITCH_GRACE_MS } from '../src/sessions/transcript-watcher.js';
import { mungedProjectDir } from '../src/sessions/transcript.js';
import { initLogger, log } from '../src/log.js';

function makeWatcher() {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-twatch-'));
  const config = loadConfig({ STATE_DIR: dir });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const watcher = new TranscriptWatcher({ config, manager, bus });
  return { manager, watcher, bus };
}

describe('TranscriptWatcher', () => {
  it('forwards a max_tokens error event as session.error', () => {
    const { manager, watcher, bus } = makeWatcher();
    const onError = vi.fn();
    const setStatus = vi.spyOn(manager, 'setStatus');
    bus.on('session.error', onError);
    const s = manager.registerTerminal({ title: 'p', projectDir: '/tmp/p', tmuxTarget: 'claude:p' });
    const msg = 'Claude hit the output limit (max_tokens). Ask it to continue.';
    (watcher as any).emit(s, { type: 'error', message: msg });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.error', sessionId: s.id, message: msg }));
    // spec §4.3: nessun setStatus('error') — lo stato resta gestito da applyState
    expect(setStatus).not.toHaveBeenCalled();
  });
});

describe('TranscriptWatcher (worktree relocation)', () => {
  function makeWatcher() {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-twatch-'));
    const config = loadConfig({ STATE_DIR: dir, PROJECTS_DIR: join(dir, 'projects') });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const watcher = new TranscriptWatcher({ config, manager, bus });
    return { manager, watcher, bus, config };
  }

  it('re-adopts a transcript that moved to a git worktree and keeps streaming it', async () => {
    const { manager, watcher, bus, config } = makeWatcher();
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    const wtDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj/.claude/worktrees/fix'));
    mkdirSync(mainDir, { recursive: true });
    mkdirSync(wtDir, { recursive: true });
    // un'altra sessione attiva nella dir principale: il fallback "newest" non deve prevalere
    const other = join(mainDir, 'other.jsonl');
    writeFileSync(other, JSON.stringify({ type: 'mode', sessionId: 'other' }) + '\n');
    utimesSync(other, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    const wtFile = join(wtDir, 'abc.jsonl');
    writeFileSync(wtFile, JSON.stringify({ type: 'mode', sessionId: 'abc' }) + '\n');

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    manager.setTranscriptFile(s.id, join(mainDir, 'abc.jsonl')); // path registrato, ormai stale

    const setTranscriptFile = vi.spyOn(manager, 'setTranscriptFile');
    const onText = vi.fn();
    bus.on('session.text', onText);

    // primo poll: adotta il file traslocato (non l'"other" più recente nella dir)
    await (watcher as any).pollSession(s);
    expect(setTranscriptFile).toHaveBeenCalledWith(s.id, wtFile);

    // il tail parte da EOF: le righe nuove del worktree arrivano in chat
    appendFileSync(wtFile, JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ciao' }], stop_reason: 'end_turn' } }) + '\n');
    await (watcher as any).pollSession(s);
    expect(onText).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.text', sessionId: s.id, role: 'assistant', text: 'ciao' }));
  });

  it('does NOT adopt the newest transcript of another session when its own is gone', async () => {
    const { manager, watcher, config } = makeWatcher();
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    mkdirSync(mainDir, { recursive: true });
    const other = join(mainDir, 'other.jsonl');
    writeFileSync(other, JSON.stringify({ type: 'mode', sessionId: 'other' }) + '\n');
    utimesSync(other, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    manager.setTranscriptFile(s.id, join(mainDir, 'abc.jsonl')); // stale: non esiste da nessuna parte

    const setTranscriptFile = vi.spyOn(manager, 'setTranscriptFile');
    await (watcher as any).pollSession(s);
    expect(setTranscriptFile).not.toHaveBeenCalled(); // niente adozione di una sessione estranea
  });
});

describe('TranscriptWatcher (Ollama-launched Claude models + binding)', () => {
  function makeWatcher() {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-twatch-'));
    const config = loadConfig({ STATE_DIR: dir, PROJECTS_DIR: join(dir, 'projects') });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const watcher = new TranscriptWatcher({ config, manager, bus });
    return { manager, watcher, bus, config, stateDir: dir };
  }

  // La sessione è lanciata con `ollama launch claude --model claude-opus-5`: il
  // transcript dice "claude-opus-5", che NON è in `ollama list` e inizia con
  // "claude-". Il gate sul modello non deve bloccarne lo streaming — sono le
  // sessioni del nostro Ollama, solo servite con un modello Anthropic.
  it('streams a terminal session whose transcript model is claude-*', async () => {
    const { manager, watcher, bus, config } = makeWatcher();
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    mkdirSync(mainDir, { recursive: true });
    const tf = join(mainDir, 'sess1.jsonl');
    writeFileSync(tf,
      JSON.stringify({ type: 'mode', sessionId: 'sess1' }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { id: 'm0', model: 'claude-opus-5', content: [{ type: 'text', text: 'setup' }], stop_reason: 'end_turn' } }) + '\n');
    utimesSync(tf, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    const onText = vi.fn();
    bus.on('session.text', onText);

    // Il vecchio gate sul modello avrebbe scartato un transcript claude-* non in `ollama list`.
    await (watcher as any).pollSession(s);
    expect(manager.get(s.id)?.transcriptFile).toBe(tf); // adottato

    appendFileSync(tf, JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ciao' }], stop_reason: 'end_turn' } }) + '\n');
    await (watcher as any).pollSession(s);
    expect(onText).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.text', sessionId: s.id, role: 'assistant', text: 'ciao' }));
  });

  // Al riavvio il transcript-watcher può adottare il transcript di un'ALTRA
  // sessione nella dir principale prima che il tmux-watcher aggiorni projectDir
  // al worktree. Quando projectDir diventa il worktree, il binding stale nella
  // dir vecchia va scartato e il transcript ri-scoperto nella dir nuova.
  it('re-binds to the worktree transcript when projectDir moves to it (stale binding)', async () => {
    const { manager, watcher, config } = makeWatcher();
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    const wtDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj/.claude/worktrees/fix'));
    mkdirSync(mainDir, { recursive: true });
    mkdirSync(wtDir, { recursive: true });
    // il binding sbagliato punta al transcript di un'altra sessione nella dir principale
    const other = join(mainDir, 'other.jsonl');
    writeFileSync(other, JSON.stringify({ type: 'mode', sessionId: 'other' }) + '\n');
    utimesSync(other, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    const wtFile = join(wtDir, 'abc.jsonl');
    writeFileSync(wtFile, JSON.stringify({ type: 'mode', sessionId: 'abc' }) + '\n');
    // mtime futuro: il transcript del worktree è "attivo" (più recente della
    // creazione della sessione) — altrimenti il guard createdAt lo scarterebbe
    // e il test diventerebbe flaky (race sul millisecondo tra write e register).
    utimesSync(wtFile, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    manager.setTranscriptFile(s.id, other); // binding stale
    manager.setProjectDir(s.id, '/Users/u/proj/.claude/worktrees/fix'); // projectDir aggiornato al worktree

    const setTranscriptFile = vi.spyOn(manager, 'setTranscriptFile');
    await (watcher as any).pollSession(s);
    expect(setTranscriptFile).toHaveBeenCalledWith(s.id, wtFile);
  });

  // Il binding transcriptFile va perso al riavvio del daemon: persisterlo quando
  // viene adottato permette al relocation per basename di funzionare dopo un restart.
  it('persists the transcriptFile binding once adopted', async () => {
    const { manager, watcher, config, stateDir } = makeWatcher();
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    mkdirSync(mainDir, { recursive: true });
    const tf = join(mainDir, 'sess1.jsonl');
    writeFileSync(tf, JSON.stringify({ type: 'mode', sessionId: 'sess1' }) + '\n');
    utimesSync(tf, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    await (watcher as any).pollSession(s);
    const saved = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    expect(saved.sessions.find((x: any) => x.id === s.id)?.transcriptFile).toBe(tf);
  });
});

describe('TranscriptWatcher — identità degli eventi', () => {
  it('stamps every emitted event with an eventId', () => {
    const { manager, watcher, bus } = makeWatcher();
    const seen: unknown[] = [];
    bus.on('session.text', e => seen.push(e.eventId));
    bus.on('session.prompt', e => seen.push(e.eventId));
    const s = manager.registerTerminal({ title: 'p', projectDir: '/tmp/p', tmuxTarget: 'claude:p' });
    (watcher as any).emit(s, { type: 'text', role: 'assistant', text: 'ciao' });
    (watcher as any).emit(s, { type: 'prompt', questions: [{ question: 'q', options: [{ label: 'a' }] }] });
    expect(seen).toHaveLength(2);
    for (const id of seen) expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('gives a different id to each event', () => {
    const { manager, watcher, bus } = makeWatcher();
    const ids: unknown[] = [];
    bus.on('session.text', e => ids.push(e.eventId));
    const s = manager.registerTerminal({ title: 'p', projectDir: '/tmp/p', tmuxTarget: 'claude:p' });
    (watcher as any).emit(s, { type: 'text', role: 'assistant', text: 'uno' });
    (watcher as any).emit(s, { type: 'text', role: 'assistant', text: 'due' });
    expect(ids[0]).not.toBe(ids[1]);
  });
});

// Riproduzione del 2026-08-10: una AskUserQuestion scritta sul transcript legato
// non arrivava su Telegram perché il watcher, vedendo comparire nella stessa dir
// il transcript di un subagent appena più recente, lo seguiva senza guardia e
// rientrava sul file nostro con un tail nuovo posizionato a EOF — saltando la
// riga. Riusa lo schema di `TranscriptWatcher (worktree relocation)` (vera dir
// di progetto su disco, `PROJECTS_DIR` passato a `loadConfig`).
describe('TranscriptWatcher (transcript rebind grace window)', () => {
  function makeWatcher() {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-twatch-'));
    const config = loadConfig({ STATE_DIR: dir, PROJECTS_DIR: join(dir, 'projects') });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const watcher = new TranscriptWatcher({ config, manager, bus });
    return { manager, watcher, bus, config, stateDir: dir };
  }

  function logLines(file: string): Record<string, unknown>[] {
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  it('does NOT let a same-instant subagent transcript in the same dir supplant a bound, still-growing file (reproduces the missed AskUserQuestion)', async () => {
    const { manager, watcher, bus, config } = makeWatcher();
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    mkdirSync(mainDir, { recursive: true });

    const boundFile = join(mainDir, 'd62b532d.jsonl');
    writeFileSync(boundFile, JSON.stringify({ type: 'mode', sessionId: 'd62b532d' }) + '\n');
    const now = Date.now();
    utimesSync(boundFile, new Date(now), new Date(now));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    manager.setTranscriptFile(s.id, boundFile);

    // primo poll: crea il tail sul file legato (parte da EOF)
    await (watcher as any).pollSession(s);

    // il transcript di un subagent (Task) compare nella STESSA dir, 4s dopo —
    // ben dentro la finestra di grazia di 60s — mentre la nostra sessione
    // continua a lavorare sul suo file
    const subagentFile = join(mainDir, '897fa8b0.jsonl');
    writeFileSync(subagentFile, JSON.stringify({ type: 'mode', sessionId: '897fa8b0' }) + '\n');
    utimesSync(subagentFile, new Date(now + 4_000), new Date(now + 4_000));

    // la AskUserQuestion arriva sul file legato
    appendFileSync(boundFile, JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { questions: [{ question: 'Quale?', options: [{ label: 'A' }, { label: 'B' }] }] } }] },
    }) + '\n');

    const setTranscriptFile = vi.spyOn(manager, 'setTranscriptFile');
    const onPrompt = vi.fn();
    bus.on('session.prompt', onPrompt);

    await (watcher as any).pollSession(s);

    expect(setTranscriptFile).not.toHaveBeenCalled(); // il binding resta sul file nostro
    expect(onPrompt).toHaveBeenCalledWith(expect.objectContaining({ sessionId: s.id, questions: [expect.objectContaining({ question: 'Quale?' })] }));
  });

  it('treats a real rotation as legitimate once the newer file is past the grace window, and logs the rebind with its reason', async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'orc-twatch-log-')), 'daemon.jsonl');
    initLogger({ file: logFile, level: 'info', stderr: () => {} });
    try {
      const { manager, watcher, config } = makeWatcher();
      const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
      mkdirSync(mainDir, { recursive: true });

      const oldFile = join(mainDir, 'old.jsonl');
      writeFileSync(oldFile, JSON.stringify({ type: 'mode', sessionId: 'old' }) + '\n');
      const now = Date.now();
      utimesSync(oldFile, new Date(now), new Date(now));

      const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
      manager.setTranscriptFile(s.id, oldFile);
      await (watcher as any).pollSession(s); // crea il tail sul vecchio file

      // il vecchio file smette di crescere; il nuovo compare ben oltre la finestra di grazia
      const newFile = join(mainDir, 'new.jsonl');
      writeFileSync(newFile, JSON.stringify({ type: 'mode', sessionId: 'new' }) + '\n');
      utimesSync(newFile, new Date(now + TRANSCRIPT_SWITCH_GRACE_MS + 5_000), new Date(now + TRANSCRIPT_SWITCH_GRACE_MS + 5_000));

      const setTranscriptFile = vi.spyOn(manager, 'setTranscriptFile');
      await (watcher as any).pollSession(s);

      expect(setTranscriptFile).toHaveBeenCalledWith(s.id, newFile);
      expect(manager.get(s.id)?.transcriptFile).toBe(newFile);

      log().close();
      const rec = logLines(logFile).find(r => r.msg === 'transcript bound' && r.reason === 'file-switch');
      expect(rec).toMatchObject({ sessionId: s.id, previous: oldFile, next: newFile, reason: 'file-switch' });
    } finally {
      initLogger({});
    }
  });

  it('drains the old file residual events on a legitimate rotation, and they reach the bus before any event from the new file', async () => {
    const { manager, watcher, bus, config } = makeWatcher();
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    mkdirSync(mainDir, { recursive: true });

    const oldFile = join(mainDir, 'old.jsonl');
    writeFileSync(oldFile, JSON.stringify({ type: 'mode', sessionId: 'old' }) + '\n');
    const now = Date.now();
    utimesSync(oldFile, new Date(now), new Date(now));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    manager.setTranscriptFile(s.id, oldFile);
    await (watcher as any).pollSession(s); // crea il tail sul vecchio file, da EOF

    // coda non ancora letta sul vecchio file: scritta ma non ancora "pollata"
    appendFileSync(oldFile, JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'coda-vecchia' }] } }) + '\n');

    // rotazione legittima: il nuovo file compare oltre la finestra di grazia
    const newFile = join(mainDir, 'new.jsonl');
    writeFileSync(newFile, JSON.stringify({ type: 'mode', sessionId: 'new' }) + '\n');
    utimesSync(newFile, new Date(now + TRANSCRIPT_SWITCH_GRACE_MS + 5_000), new Date(now + TRANSCRIPT_SWITCH_GRACE_MS + 5_000));

    const order: string[] = [];
    bus.on('session.text', e => order.push(e.text));

    await (watcher as any).pollSession(s); // drena la coda del vecchio file, poi passa al nuovo (senza replay)
    expect(order).toEqual(['coda-vecchia']); // la coda non è andata persa

    appendFileSync(newFile, JSON.stringify({ type: 'assistant', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'nuovo-file' }] } }) + '\n');
    await (watcher as any).pollSession(s); // il tail nuovo, ora esistente, legge la riga aggiunta

    expect(order).toEqual(['coda-vecchia', 'nuovo-file']); // ordine preservato: vecchio prima di nuovo
  });

  it('logs every transcript rebind with the previous path, the new path and a reason distinguishing the case', async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'orc-twatch-log-')), 'daemon.jsonl');
    initLogger({ file: logFile, level: 'info', stderr: () => {} });
    try {
      const { manager, watcher, config } = makeWatcher();
      const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
      mkdirSync(mainDir, { recursive: true });
      const tf = join(mainDir, 'sess1.jsonl');
      writeFileSync(tf, JSON.stringify({ type: 'mode', sessionId: 'sess1' }) + '\n');
      utimesSync(tf, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));

      const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
      await (watcher as any).pollSession(s); // prima adozione: nessun file legato ancora

      log().close();
      const rec = logLines(logFile).find(r => r.msg === 'transcript bound' && r.reason === 'first-adoption');
      expect(rec).toMatchObject({ sessionId: s.id, next: tf, reason: 'first-adoption' });
      expect(rec).not.toHaveProperty('previous'); // JSON.stringify omette i campi undefined: nessun binding precedente
      expect(manager.get(s.id)?.transcriptFile).toBe(tf);
    } finally {
      initLogger({});
    }
  });
});
