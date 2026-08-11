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
  // `nowFn`: orologio iniettabile (TranscriptWatcherDeps.now). La regola della
  // finestra di grazia confronta con l'istante REALE (`Date.now()` di
  // produzione), non solo con le mtime dei file — i test devono poter simulare
  // il tempo che passa senza sleep reali di 60s+.
  function makeWatcher(nowFn?: () => number) {
    const bus = new Bus();
    const dir = mkdtempSync(join(tmpdir(), 'orc-twatch-'));
    const config = loadConfig({ STATE_DIR: dir, PROJECTS_DIR: join(dir, 'projects') });
    const state = new StateStore(join(dir, 'state.json'));
    const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
    const watcher = new TranscriptWatcher({ config, manager, bus, now: nowFn });
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
    // continua a lavorare sul suo file.
    // Il timestamp futuro (+4s) del sibling è il dettaglio che rende il test
    // discriminante: senza di esso `newestTranscriptFile` non lo sceglierebbe
    // affatto come "più recente" e il ramo di switch non verrebbe nemmeno
    // valutato. Non rimuoverlo/appiattirlo in un refactor futuro.
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
      // Orologio iniettato: la regola confronta con l'istante reale (`this.now()`
      // in produzione), quindi qui simuliamo il tempo che passa muovendo `clock`
      // invece di dormire 60s+ nel test.
      let clock = Date.now();
      const { manager, watcher, config } = makeWatcher(() => clock);
      const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
      mkdirSync(mainDir, { recursive: true });

      const oldFile = join(mainDir, 'old.jsonl');
      writeFileSync(oldFile, JSON.stringify({ type: 'mode', sessionId: 'old' }) + '\n');
      const t0 = clock;
      utimesSync(oldFile, new Date(t0), new Date(t0));

      const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
      manager.setTranscriptFile(s.id, oldFile);
      await (watcher as any).pollSession(s); // crea il tail sul vecchio file

      // il vecchio file smette di crescere; passa più della finestra di grazia
      // (tempo reale simulato) e il nuovo compare, davvero più recente
      clock = t0 + TRANSCRIPT_SWITCH_GRACE_MS + 5_000;
      const newFile = join(mainDir, 'new.jsonl');
      writeFileSync(newFile, JSON.stringify({ type: 'mode', sessionId: 'new' }) + '\n');
      utimesSync(newFile, new Date(clock), new Date(clock));

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
    let clock = Date.now();
    const { manager, watcher, bus, config } = makeWatcher(() => clock);
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    mkdirSync(mainDir, { recursive: true });

    const oldFile = join(mainDir, 'old.jsonl');
    writeFileSync(oldFile, JSON.stringify({ type: 'mode', sessionId: 'old' }) + '\n');
    const t0 = clock;
    utimesSync(oldFile, new Date(t0), new Date(t0));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    manager.setTranscriptFile(s.id, oldFile);
    await (watcher as any).pollSession(s); // crea il tail sul vecchio file, da EOF

    // coda non ancora letta sul vecchio file: scritta ma non ancora "pollata"
    appendFileSync(oldFile, JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'coda-vecchia' }] } }) + '\n');

    // rotazione legittima: tempo reale simulato oltre la finestra di grazia
    clock = t0 + TRANSCRIPT_SWITCH_GRACE_MS + 5_000;
    const newFile = join(mainDir, 'new.jsonl');
    writeFileSync(newFile, JSON.stringify({ type: 'mode', sessionId: 'new' }) + '\n');
    utimesSync(newFile, new Date(clock), new Date(clock));

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

  it('logs a debug record when a bound file vanishes and is not found anywhere else (M1)', async () => {
    const logFile = join(mkdtempSync(join(tmpdir(), 'orc-twatch-log-')), 'daemon.jsonl');
    initLogger({ file: logFile, level: 'debug', stderr: () => {} });
    try {
      const { manager, watcher, config } = makeWatcher();
      const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
      mkdirSync(mainDir, { recursive: true });
      const gone = join(mainDir, 'gone.jsonl'); // mai scritto su disco: sempre sparito

      const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
      manager.setTranscriptFile(s.id, gone);

      await (watcher as any).pollSession(s); // nessun candidato nella dir (vuota): il poll finiva senza loggare nulla

      log().close();
      const rec = logLines(logFile).find(r => r.msg === 'transcript unbound');
      expect(rec).toMatchObject({ sessionId: s.id, previous: gone, reason: 'missing-not-relocated' });
    } finally {
      initLogger({});
    }
  });

  // Fix round 2 — issue Critica C1: la finestra di grazia è un'euristica sulle
  // mtime e PUÒ sbagliare. Il caso più comune su questo progetto: una domanda è
  // pendente su Telegram e l'umano ci mette più di 60s a rispondere, mentre nella
  // stessa dir un transcript "foreign" (un subagent, che nell'incidente reale ha
  // scritto per 25 minuti ininterrotti) resta attivo e finisce per "vincere" il
  // binding. PRIMA di questo fix, quando il binding tornava sul nostro file il
  // tail veniva ricreato a EOF: tutto ciò che era stato scritto nel frattempo
  // andava perso — lo stesso bug della causa originale, solo su scala di minuti
  // invece che di secondi. Con `tailFor` che riusa il tail invece di ricrearlo,
  // il rientro riprende esattamente da dove eravamo rimasti.
  it('recovers lines written to our own file while a foreign transcript in the same dir held the binding, in order and exactly once (C1)', async () => {
    let clock = Date.now();
    const { manager, watcher, bus, config } = makeWatcher(() => clock);
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    mkdirSync(mainDir, { recursive: true });

    const oursFile = join(mainDir, 'ours.jsonl');
    writeFileSync(oursFile, JSON.stringify({ type: 'mode', sessionId: 'ours' }) + '\n');
    const t0 = clock;
    utimesSync(oursFile, new Date(t0), new Date(t0));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    manager.setTranscriptFile(s.id, oursFile);
    await (watcher as any).pollSession(s); // tail iniziale su "ours", da EOF

    // la nostra sessione resta muta per più della finestra di grazia (l'umano
    // sta pensando alla domanda); il transcript "foreign" nella stessa dir,
    // attivo di continuo, la supera e vince il binding. Gli diamo contenuto
    // VERO (non solo la riga "mode" amministrativa) prima dello switch: così,
    // se in futuro il pin regredisse (es. tornasse a girare a EOF-al-momento-
    // dello-switch invece che a EOF-al-primo-avvistamento, o peggio rileggesse
    // la sua storia), questo test lo noterebbe — la riga 'contenuto-foreign'
    // NON deve mai comparire in `onText`, né ora né dopo.
    const foreignFile = join(mainDir, 'foreign.jsonl');
    writeFileSync(foreignFile,
      JSON.stringify({ type: 'mode', sessionId: 'foreign' }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { id: 'f1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'contenuto-foreign' }] } }) + '\n');
    clock = t0 + TRANSCRIPT_SWITCH_GRACE_MS + 5_000;
    utimesSync(foreignFile, new Date(clock), new Date(clock));

    const onText: string[] = [];
    bus.on('session.text', e => onText.push(e.text));

    await (watcher as any).pollSession(s); // il binding viene rubato dal foreign
    expect(manager.get(s.id)?.transcriptFile).toBe(foreignFile);

    // MENTRE il binding è altrove, l'umano risponde su Telegram e la nostra
    // sessione riparte: due righe vengono scritte nel NOSTRO file.
    appendFileSync(oursFile, JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'durante-1' }] } }) + '\n');
    appendFileSync(oursFile, JSON.stringify({ type: 'assistant', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: 'durante-2' }] } }) + '\n');
    clock = clock + TRANSCRIPT_SWITCH_GRACE_MS + 5_000;
    utimesSync(oursFile, new Date(clock), new Date(clock));

    await (watcher as any).pollSession(s); // il nostro file torna a essere il più recente: il binding rientra

    expect(manager.get(s.id)?.transcriptFile).toBe(oursFile);
    // toEqual, non toContain: un array ESATTO — 'contenuto-foreign' (scritto
    // sul file foreign prima dello switch) non deve comparire da nessuna
    // parte. Recuperate, in ordine, una sola volta.
    expect(onText).toEqual(['durante-1', 'durante-2']);
  });

  // Fix round 2 — issue Critica C2: con la finestra di grazia, nel momento in
  // cui una rotazione VERA viene riconosciuta il file nuovo ha già accumulato
  // fino a un minuto di conversazione NOSTRA (il prompt dell'utente dopo /clear
  // e la risposta). PRIMA di questo fix il tail veniva creato a EOF proprio in
  // quel momento, perdendo tutto quel contenuto. Il fix "pinna" un tail per il
  // candidato appena lo vediamo comparire (non quando vince), quindi quando la
  // finestra scade il tail esiste già da prima e recupera tutto.
  it('does not drop conversation already written to the new file by the time a genuine rotation crosses the grace window (C2)', async () => {
    let clock = Date.now();
    const { manager, watcher, bus, config } = makeWatcher(() => clock);
    const mainDir = join(config.projectsDir, mungedProjectDir('/Users/u/proj'));
    mkdirSync(mainDir, { recursive: true });

    const oldFile = join(mainDir, 'old.jsonl');
    writeFileSync(oldFile, JSON.stringify({ type: 'mode', sessionId: 'old' }) + '\n');
    const t0 = clock;
    utimesSync(oldFile, new Date(t0), new Date(t0));

    const s = manager.registerTerminal({ title: 'p', projectDir: '/Users/u/proj', tmuxTarget: 'claude:p' });
    manager.setTranscriptFile(s.id, oldFile);
    await (watcher as any).pollSession(s); // tail sul vecchio file

    // il vecchio file smette di crescere (rotazione, es. /clear): il nuovo
    // compare quasi subito, ma non supera ancora la finestra di grazia
    const newFile = join(mainDir, 'new.jsonl');
    writeFileSync(newFile, JSON.stringify({ type: 'mode', sessionId: 'new' }) + '\n');
    clock = t0 + 5_000;
    utimesSync(newFile, new Date(clock), new Date(clock));

    await (watcher as any).pollSession(s); // non vince ancora: ma lo pinniamo già qui

    // durante la finestra di grazia il file nuovo accumula la VERA
    // conversazione post-rotazione — esattamente ciò che andava perso prima
    appendFileSync(newFile, JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'post-rotazione' }] } }) + '\n');
    clock = t0 + TRANSCRIPT_SWITCH_GRACE_MS + 10_000; // ora supera la finestra
    utimesSync(newFile, new Date(clock), new Date(clock));

    const onText: string[] = [];
    bus.on('session.text', e => onText.push(e.text));

    await (watcher as any).pollSession(s); // rotazione riconosciuta: il tail esisteva già, non riparte da EOF

    expect(manager.get(s.id)?.transcriptFile).toBe(newFile);
    expect(onText).toEqual(['post-rotazione']); // il contenuto pre-switch non è andato perso
  });
});
