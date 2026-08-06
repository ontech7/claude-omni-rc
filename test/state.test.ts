import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, emptyState } from '../src/state.js';

function tmpState(): { store: StateStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orc-state-'));
  const path = join(dir, 'state.json');
  return { store: new StateStore(path), path };
}

describe('StateStore', () => {
  it('returns empty defaults for a missing file with existed=false', () => {
    const { store } = tmpState();
    const { state, existed } = store.load();
    expect(existed).toBe(false);
    expect(state).toEqual(emptyState());
  });
  it('returns defaults for corrupt json with existed=true', () => {
    const { store, path } = tmpState();
    writeFileSync(path, '{{{not json');
    const { state, existed } = store.load();
    expect(existed).toBe(true);
    expect(state.armed).toBe(false);
    expect(state.sessions).toEqual([]);
  });
  it('round-trips saved state', () => {
    const { store } = tmpState();
    const { state } = store.load();
    state.armed = true;
    store.save(state);
    const again = store.load();
    expect(again.existed).toBe(true);
    expect(again.state.armed).toBe(true);
    expect(existsSync((store as any).filePath)).toBe(true);
  });
  it('merges partial state onto defaults', () => {
    const { store, path } = tmpState();
    writeFileSync(path, JSON.stringify({ armed: true }));
    const { state } = store.load();
    expect(state.armed).toBe(true);
    expect(state.sessions).toEqual([]);
    expect(state.mirrorOffsets).toEqual({});
  });
  it('keeps an optional activeSessionId through a round-trip', () => {
    const { store } = tmpState();
    const { state } = store.load();
    state.activeSessionId = 'abc';
    store.save(state);
    const again = store.load();
    expect(again.state.activeSessionId).toBe('abc');
  });
});
