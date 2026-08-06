import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { TranscriptWatcher } from '../src/sessions/transcript-watcher.js';
import { mungedProjectDir } from '../src/sessions/transcript.js';

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
    expect(onError).toHaveBeenCalledWith({ type: 'session.error', sessionId: s.id, message: msg });
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
    expect(onText).toHaveBeenCalledWith({ type: 'session.text', sessionId: s.id, role: 'assistant', text: 'ciao' });
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
    expect(onText).toHaveBeenCalledWith({ type: 'session.text', sessionId: s.id, role: 'assistant', text: 'ciao' });
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
