import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { TmuxClient } from '../src/sessions/tmux-inject.js';
import { createExec } from '../src/sessions/tmux-inject.js';

// vi.mock viene sollevato sopra le dichiarazioni const: la funzione mock deve
// vivere in vi.hoisted per evitare un ReferenceError da TDZ.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

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
  it('sends keys to the pane (C-c interrupt)', async () => {
    const { exec, calls } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '$0 claude:proj\n' } },
      { call: ['send-keys', '-t', '$0', 'C-c'], result: { code: 0 } },
    ]);
    const tmux = new TmuxClient(exec);
    await tmux.sendKeys('claude:proj', 'C-c');
    expect(calls[1].args).toEqual(['send-keys', '-t', '$0', 'C-c']);
  });
  it('sendKeySeq sends keys one at a time, resolving the session id first', async () => {
    const { exec, calls } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '$0 claude:proj\n' } },
      { call: ['send-keys', '-t', '$0', 'Down'], result: { code: 0 } },
      { call: ['send-keys', '-t', '$0', '4'], result: { code: 0 } },
      { call: ['send-keys', '-t', '$0', 'Enter'], result: { code: 0 } },
    ]);
    const tmux = new TmuxClient(exec);
    await tmux.sendKeySeq('claude:proj', [
      { kind: 'key', key: 'Down' },
      { kind: 'key', key: '4' },
      { kind: 'key', key: 'Enter' },
    ], { delayMs: 0 });
    expect(calls.slice(1).map(c => c.args[3])).toEqual(['Down', '4', 'Enter']);
  });
  it('sendKeySeq types literal text with -l for text items', async () => {
    const { exec, calls } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '$0 claude:proj\n' } },
      { call: ['send-keys', '-l', '-t', '$0', 'my answer'], result: { code: 0 } },
      { call: ['send-keys', '-t', '$0', 'Enter'], result: { code: 0 } },
    ]);
    const tmux = new TmuxClient(exec);
    await tmux.sendKeySeq('claude:proj', [
      { kind: 'text', text: 'my answer' },
      { kind: 'key', key: 'Enter' },
    ], { delayMs: 0 });
    expect(calls[1].args).toEqual(['send-keys', '-l', '-t', '$0', 'my answer']);
    expect(calls[2].args).toEqual(['send-keys', '-t', '$0', 'Enter']);
  });
  it('sendKeySeq throws when send-keys fails', async () => {
    const { exec } = fakeExec([
      { call: ['list-sessions', '-F', '#{session_id} #{session_name}'], result: { code: 0, stdout: '$0 gone:pane\n' } },
      { call: ['send-keys', '-t', '$0', 'Down'], result: { code: 1, stderr: 'no such pane' } },
    ]);
    const tmux = new TmuxClient(exec);
    await expect(tmux.sendKeySeq('gone:pane', [{ kind: 'key', key: 'Down' }], { delayMs: 0 })).rejects.toThrow('send-keys');
  });
});

describe('TmuxClient.claudeCwd', () => {
  it('finds the cwd of the claude process running in the pane (worktree)', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected tmux call: ' + args.join(' '));
    };
    const sh: any = async (cmd: string, args: string[]) => {
      if (cmd === 'ps') return { code: 0, stdout: '100 1 -zsh\n200 100 ollama\n300 200 /Users/u/.local/bin/claude\n', stderr: '' };
      if (cmd === 'lsof') return { code: 0, stdout: 'p300\nfcwd\nn/Users/u/proj/.claude/worktrees/fix\n', stderr: '' };
      throw new Error('unexpected sh call: ' + cmd);
    };
    const client = new TmuxClient(exec, sh);
    await expect(client.claudeCwd('claude:proj')).resolves.toBe('/Users/u/proj/.claude/worktrees/fix');
  });
  it('returns undefined when no claude process runs in the pane', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected');
    };
    const sh: any = async (cmd: string) => {
      if (cmd === 'ps') return { code: 0, stdout: '100 1 -zsh\n200 100 ollama\n', stderr: '' };
      throw new Error('unexpected sh call: ' + cmd);
    };
    const client = new TmuxClient(exec, sh);
    await expect(client.claudeCwd('claude:proj')).resolves.toBeUndefined();
  });
  it('returns undefined when ps/lsof fail', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected');
    };
    const sh: any = async () => ({ code: 1, stdout: '', stderr: 'boom' });
    const client = new TmuxClient(exec, sh);
    await expect(client.claudeCwd('claude:proj')).resolves.toBeUndefined();
  });
});

describe('TmuxClient.claudeModel', () => {
  it('parses --model from the claude process command line', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected tmux call: ' + args.join(' '));
    };
    const sh: any = async (cmd: string, args: string[]) => {
      if (cmd === 'ps' && args[0] === '-o' && args[1] === 'args=') return { code: 0, stdout: '/Users/u/.local/bin/claude --model claude-sonnet-5\n', stderr: '' };
      if (cmd === 'ps') return { code: 0, stdout: '100 1 -zsh\n200 100 ollama\n300 200 /Users/u/.local/bin/claude\n', stderr: '' };
      throw new Error('unexpected sh call: ' + cmd);
    };
    const client = new TmuxClient(exec, sh);
    await expect(client.claudeModel('claude:proj')).resolves.toBe('claude-sonnet-5');
  });
  it('returns undefined when the claude process has no --model (ollama launch claude)', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected');
    };
    const sh: any = async (cmd: string, args: string[]) => {
      if (cmd === 'ps' && args[0] === '-o' && args[1] === 'args=') return { code: 0, stdout: '/Users/u/.local/bin/claude\n', stderr: '' };
      if (cmd === 'ps') return { code: 0, stdout: '100 1 -zsh\n200 100 ollama\n300 200 /Users/u/.local/bin/claude\n', stderr: '' };
      throw new Error('unexpected sh call: ' + cmd);
    };
    const client = new TmuxClient(exec, sh);
    await expect(client.claudeModel('claude:proj')).resolves.toBeUndefined();
  });
  it('returns undefined when no claude process runs in the pane', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected');
    };
    const sh: any = async (cmd: string) => {
      if (cmd === 'ps') return { code: 0, stdout: '100 1 -zsh\n200 100 ollama\n', stderr: '' };
      throw new Error('unexpected sh call: ' + cmd);
    };
    const client = new TmuxClient(exec, sh);
    await expect(client.claudeModel('claude:proj')).resolves.toBeUndefined();
  });
});

describe('TmuxClient.processTree', () => {
  it('parses the process table once into a reusable snapshot', async () => {
    let psCalls = 0;
    const exec: any = async () => ({ code: 0, stdout: '', stderr: '' });
    const sh: any = async (cmd: string) => {
      if (cmd === 'ps') { psCalls++; return { code: 0, stdout: '100 1 -zsh\n200 100 ollama\n300 200 /Users/u/.local/bin/claude\n', stderr: '' }; }
      throw new Error('unexpected sh call: ' + cmd);
    };
    const tree = await new TmuxClient(exec, sh).processTree();
    expect(psCalls).toBe(1);
    expect(tree?.comms.get('300')).toBe('/Users/u/.local/bin/claude');
    expect(tree?.children.get('200')).toEqual(['300']);
  });
});

describe('TmuxClient.claudeCwd with a shared snapshot', () => {
  it('does not spawn ps again when given a snapshot', async () => {
    const exec: any = async (args: string[]) => {
      if (args[0] === 'list-sessions') return { code: 0, stdout: '$0 claude:proj\n', stderr: '' };
      if (args[0] === 'display-message') return { code: 0, stdout: '100\n', stderr: '' };
      throw new Error('unexpected');
    };
    const sh: any = async (cmd: string) => {
      if (cmd === 'ps') throw new Error('ps must not be spawned again');
      if (cmd === 'lsof') return { code: 0, stdout: 'p300\nfcwd\nn/Users/u/proj/wt\n', stderr: '' };
      throw new Error('unexpected sh call: ' + cmd);
    };
    const tree = {
      comms: new Map([['100', '-zsh'], ['200', 'ollama'], ['300', '/Users/u/.local/bin/claude']]),
      children: new Map([['1', ['100']], ['100', ['200']], ['200', ['300']]]),
    };
    await expect(new TmuxClient(exec, sh).claudeCwd('claude:proj', tree)).resolves.toBe('/Users/u/proj/wt');
  });
});

function fakeChild(): any {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter() as any;
  child.stderr = new EventEmitter() as any;
  child.stdin = { write: vi.fn(), end: vi.fn() } as any;
  child.kill = vi.fn(() => { child.emit('close', null); });
  return child;
}

describe('createExec timeout', () => {
  it('resolves when the child exits before the timeout', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = createExec({ timeoutMs: 1000 })(['list-sessions']);
    child.emit('close', 0);
    await expect(p).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
  });
  it('rejects when the child never exits', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValueOnce(child);
      const p = createExec({ timeoutMs: 1000 })(['list-sessions']);
      // Handler attaccato PRIMA di far scattare il timer: se il rifiuto avviene
      // mentre il timer avanza e il .rejects arriva dopo, vitest segnala una
      // PromiseRejectionHandledWarning ("unhandled rejection") in output.
      const assertion = expect(p).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
