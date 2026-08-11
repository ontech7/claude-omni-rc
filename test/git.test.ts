import { describe, it, expect } from 'vitest';
import type { ShExecFn } from '../src/sessions/tmux-inject.js';
import { currentBranch } from '../src/git.js';

const fakeSh = (result: { code: number; stdout: string; stderr: string }): ShExecFn => async () => result;

describe('currentBranch', () => {
  it('returns the branch when git succeeds', async () => {
    const sh = fakeSh({ code: 0, stdout: 'feat/settings-diag\n', stderr: '' });
    await expect(currentBranch('/tmp/x', sh)).resolves.toBe('feat/settings-diag');
  });
  it('returns undefined when the dir is not a git repo', async () => {
    const sh = fakeSh({ code: 128, stdout: '', stderr: 'fatal: not a git repository' });
    await expect(currentBranch('/tmp/x', sh)).resolves.toBeUndefined();
  });
  it('returns undefined on a detached HEAD, an empty stdout or a throwing command', async () => {
    await expect(currentBranch('/tmp/x', fakeSh({ code: 0, stdout: '', stderr: '' }))).resolves.toBeUndefined();
    const throwing: ShExecFn = async () => { throw new Error('git not found'); };
    await expect(currentBranch('/tmp/x', throwing)).resolves.toBeUndefined();
  });
});
