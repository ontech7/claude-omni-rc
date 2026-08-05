import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { TranscriptWatcher } from '../src/sessions/transcript-watcher.js';

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
