import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer, checkForUpdate, markNotified, CURRENT_VERSION } from '../src/update.js';

function statePath() {
  return join(mkdtempSync(join(tmpdir(), 'orc-update-')), 'update-check.json');
}

describe('isNewer', () => {
  it('compares dotted versions', () => {
    expect(isNewer('0.3.0', '0.2.0')).toBe(true);
    expect(isNewer('0.2.0', '0.2.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(false);
    expect(isNewer('v0.2.1', '0.2.0')).toBe(true);
  });
  it('never throws on garbage input', () => {
    expect(isNewer('not-a-version', '0.2.0')).toBe(false);
    expect(isNewer('0.2.0', 'also-garbage')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  it('returns undefined when disabled', async () => {
    const latest = await checkForUpdate({ statePath: statePath(), disabled: true, fetch: async () => '99.0.0' });
    expect(latest).toBeUndefined();
  });

  it('returns the fetched version when newer than current', async () => {
    const latest = await checkForUpdate({ statePath: statePath(), fetch: async () => '99.0.0' });
    expect(latest).toBe('99.0.0');
  });

  it('returns undefined when the fetched version is not newer', async () => {
    const latest = await checkForUpdate({ statePath: statePath(), fetch: async () => CURRENT_VERSION });
    expect(latest).toBeUndefined();
  });

  it('does not re-fetch within the 24h window, but keeps the cached latest', async () => {
    const path = statePath();
    let calls = 0;
    const fetch = async () => { calls++; return '99.0.0'; };
    const now = 1_000_000;
    await checkForUpdate({ statePath: path, fetch, now });
    const latest = await checkForUpdate({ statePath: path, fetch, now: now + 1000 });
    expect(calls).toBe(1);
    expect(latest).toBe('99.0.0');
  });

  it('never notifies the same version twice', async () => {
    const path = statePath();
    const fetch = async () => '99.0.0';
    const first = await checkForUpdate({ statePath: path, fetch, now: 1 });
    expect(first).toBe('99.0.0');
    markNotified(path, first!);
    const second = await checkForUpdate({ statePath: path, fetch, now: CHECK_INTERVAL_MS_PLUS_ONE });
    expect(second).toBeUndefined();
  });

  it('never throws when the fetch rejects', async () => {
    const latest = await checkForUpdate({ statePath: statePath(), fetch: async () => { throw new Error('offline'); } });
    expect(latest).toBeUndefined();
  });
});

const CHECK_INTERVAL_MS_PLUS_ONE = 24 * 60 * 60 * 1000 + 1;
