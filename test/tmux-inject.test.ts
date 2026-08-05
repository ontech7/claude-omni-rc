import { describe, it, expect } from 'vitest';
import { TmuxClient } from '../src/sessions/tmux-inject.js';

// Il buffer ha nome random per chiamata: la fake verifica solo il primo argomento
// (comando) e registra gli args reali per le asserzioni successive.
function fakeExec(script: Array<{ call: string[]; input?: string; result: { code: number; stdout?: string; stderr?: string } }>) {
  const calls: Array<{ args: string[]; input?: string }> = [];
  const exec: any = (args: string[], opts?: { input?: string }) => {
    calls.push({ args, input: opts?.input });
    const entry = script.shift()!;
    expect(args[0]).toBe(entry.call[0]);
    if (entry.input !== undefined) expect(opts?.input).toBe(entry.input);
    return Promise.resolve({ code: entry.result.code, stdout: entry.result.stdout ?? '', stderr: entry.result.stderr ?? '' });
  };
  return { exec, calls };
}

describe('TmuxClient', () => {
  it('lists session names', async () => {
    const { exec } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_name}'], result: { code: 0, stdout: 'claude:proj1\nclaude:proj2\n' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.listSessions()).resolves.toEqual(['claude:proj1', 'claude:proj2']);
  });
  it('returns empty list when tmux is not running', async () => {
    const { exec } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_name}'], result: { code: 1, stderr: 'no server running' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.listSessions()).resolves.toEqual([]);
  });
  it('injects multiline text via bracketed paste, then presses Enter (1:1)', async () => {
    const { exec, calls } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '$0 claude:proj\n' } },
      { call: ['load-buffer', '-b', 'BUF', '-'], input: 'line1\nline2', result: { code: 0 } },
      { call: ['paste-buffer', '-b', 'BUF', '-t', '$0', '-p'], result: { code: 0 } },
      { call: ['delete-buffer', '-b', 'BUF'], result: { code: 0 } },
      { call: ['send-keys', '-t', '$0', 'Enter'], result: { code: 0 } },
    ]);
    const tmux = new TmuxClient(exec);
    await tmux.injectText('claude:proj', 'line1\nline2');
    const buf = calls[1].args[2];
    expect(calls[1].args[0]).toBe('load-buffer');
    expect(buf).toMatch(/^rc-/);
    expect(calls[2].args[2]).toBe(buf);       // stesso buffer nel paste
    expect(calls[2].args).toContain('-p');     // bracketed paste
    expect(calls[3].args).toContain(buf);      // cleanup
    expect(calls[4].args).toEqual(['send-keys', '-t', '$0', 'Enter']);
  });
  it('captures the pane content, resolving the session id first', async () => {
    const { exec, calls } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '$0 claude:proj\n' } },
      { call: ['capture-pane', '-p', '-t', '$0'], result: { code: 0, stdout: 'screen\ncontent' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.capturePane('claude:proj')).resolves.toBe('screen\ncontent');
    expect(calls[1].args).toEqual(['capture-pane', '-p', '-t', '$0']);
  });
  it('throws when the session is not found', async () => {
    const { exec } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.capturePane('claude:gone')).rejects.toThrow('session not found');
  });
  it('throws when the target pane is gone', async () => {
    const { exec } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '$0 gone:pane\n' } },
      { call: ['load-buffer', '-b', 'BUF', '-'], input: 'x', result: { code: 0 } },
      { call: ['paste-buffer', '-b', 'BUF', '-t', '$0', '-p'], result: { code: 1, stderr: 'no such pane' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.injectText('gone:pane', 'x')).rejects.toThrow('paste-buffer');
  });
});
