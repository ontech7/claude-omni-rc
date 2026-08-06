import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
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
  const watcher = new TranscriptWatcher({
    config, manager, bus,
    ollamaModels: async () => new Set<string>(),
  });
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
    const watcher = new TranscriptWatcher({
      config, manager, bus,
      ollamaModels: async () => new Set<string>(),
    });
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
    await (watcher as any).pollSession(s, new Set());
    expect(setTranscriptFile).toHaveBeenCalledWith(s.id, wtFile);

    // il tail parte da EOF: le righe nuove del worktree arrivano in chat
    appendFileSync(wtFile, JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'ciao' }], stop_reason: 'end_turn' } }) + '\n');
    await (watcher as any).pollSession(s, new Set());
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
    await (watcher as any).pollSession(s, new Set());
    expect(setTranscriptFile).not.toHaveBeenCalled(); // niente adozione di una sessione estranea
  });
});
