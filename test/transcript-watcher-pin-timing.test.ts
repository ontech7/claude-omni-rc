import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Questo file è ISOLATO dagli altri test di TranscriptWatcher (che vivono in
// transcript-watcher.test.ts) perché ha bisogno di simulare un fallimento
// transitorio di `statSync` — cosa che richiede un `vi.mock('node:fs', ...)` a
// livello di modulo, quindi valido per l'intero file. Tenerlo separato evita
// che questo mock rischi di interferire con gli 8 test preesistenti o con gli
// altri test del round 1/2 di questo fix.
//
// Fix round 2 (review) — issue Critica C2, parte residua: il pin del
// candidato (in `pollSession`) viveva in un ramo `else if` raggiunto solo
// quando, al primo avvistamento, il file legato NON supera ancora la
// finestra di grazia. Ma se il file legato è GIÀ silenzioso da prima che il
// candidato compaia — o se, come qui, un errore transitorio (EMFILE, una
// race) impedisce di valutare "supplants" proprio al primo avvistamento — il
// ramo che pinna non viene mai raggiunto: il tail del candidato nasce solo
// più tardi, nel codice di chiusura di pollSession, a EOF di quel momento —
// perdendo tutto ciò che è stato scritto nel frattempo. Il fix sposta il pin
// PRIMA di qualunque altra valutazione (compreso il controllo sul file
// legato), così avviene comunque, indipendentemente da cosa succede dopo.
let failPath: string | undefined;
let callsForFailPath = 0;
let failOnCallNumber = 0;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Sostituisce SOLO statSync, e solo per una chiamata precisa (per numero
    // progressivo) su un path scelto dal test — tutto il resto passa
    // attraverso l'implementazione reale.
    statSync: (p: unknown, ...rest: unknown[]) => {
      if (failPath && String(p) === failPath) {
        callsForFailPath++;
        if (callsForFailPath === failOnCallNumber) throw new Error('EMFILE simulated');
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

const { Bus } = await import('../src/bus.js');
const { loadConfig } = await import('../src/config.js');
const { StateStore } = await import('../src/state.js');
const { SessionManager } = await import('../src/sessions/manager.js');
const { TranscriptWatcher, TRANSCRIPT_SWITCH_GRACE_MS } = await import('../src/sessions/transcript-watcher.js');
const { mungedProjectDir } = await import('../src/sessions/transcript.js');

function makeWatcher(nowFn?: () => number) {
  const bus = new Bus();
  const dir = mkdtempSync(join(tmpdir(), 'orc-twatch-pin-'));
  const config = loadConfig({ STATE_DIR: dir, PROJECTS_DIR: join(dir, 'projects') });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const watcher = new TranscriptWatcher({ config, manager, bus, now: nowFn });
  return { manager, watcher, bus, config };
}

describe('TranscriptWatcher (pin at first sight, even when the discovering poll cannot decide)', () => {
  it('does not lose content written to a candidate between a poll that fails to evaluate it and the poll that promotes it', async () => {
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
    await (watcher as any).pollSession(s); // tail iniziale sul vecchio file

    // il vecchio file è già silenzioso oltre la finestra di grazia; il nuovo
    // compare per la prima volta esattamente ora
    clock = t0 + TRANSCRIPT_SWITCH_GRACE_MS + 10_000;
    const newFile = join(mainDir, 'new.jsonl');
    writeFileSync(newFile, JSON.stringify({ type: 'mode', sessionId: 'new' }) + '\n');
    utimesSync(newFile, new Date(clock), new Date(clock));

    // Sul poll che scopre il candidato, la lettura della mtime del file legato
    // (la chiamata esplicita `this.mtimeOf(file)` in pollSession — la SECONDA
    // chiamata a statSync(oldFile) di quel poll, la prima essendo la scansione
    // di newestTranscriptFile) fallisce in modo transitorio. pollSession non
    // decide lo switch alla cieca (I2): il binding resta quello di prima.
    failPath = oldFile;
    failOnCallNumber = 2;
    await (watcher as any).pollSession(s); // poll N: scopre il candidato, ma non riesce a valutarlo
    expect(manager.get(s.id)?.transcriptFile).toBe(oldFile); // binding invariato: nessuna decisione alla cieca

    // tra questo poll e il successivo, il candidato riceve contenuto vero
    appendFileSync(newFile, JSON.stringify({ type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'scritto-durante-il-transitorio' }] } }) + '\n');
    clock += 1_000;
    utimesSync(newFile, new Date(clock), new Date(clock));

    const onText: string[] = [];
    bus.on('session.text', e => onText.push((e as any).text));

    await (watcher as any).pollSession(s); // poll N+1: statSync torna a funzionare, il candidato vince

    expect(manager.get(s.id)?.transcriptFile).toBe(newFile);
    expect(onText).toEqual(['scritto-durante-il-transitorio']); // non perso, nonostante il poll N non l'abbia mai pinnato in tempo
  });
});
