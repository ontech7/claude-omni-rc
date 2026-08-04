import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string; }
export type ExecFn = (args: string[], opts?: { input?: string }) => Promise<ExecResult>;

export function createExec(): ExecFn {
  return (args, opts) => new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts?.input) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

export class TmuxClient {
  constructor(private exec: ExecFn = createExec()) {}

  async listSessions(): Promise<string[]> {
    const r = await this.exec(['list-sessions', '-F', '#{session_name}']);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  }

  async sessionAlive(target: string): Promise<boolean> {
    return (await this.listSessions()).includes(target);
  }

  async injectText(target: string, text: string): Promise<void> {
    const buf = `rc-${randomBytes(4).toString('hex')}`;
    const set = await this.exec(['set-buffer', '-b', buf, '-'], { input: text });
    if (set.code !== 0) throw new Error(`tmux set-buffer failed: ${set.stderr}`);
    const paste = await this.exec(['paste-buffer', '-b', buf, '-t', target, '-p']);
    if (paste.code !== 0) throw new Error(`tmux paste-buffer failed: ${paste.stderr}`);
    await this.exec(['delete-buffer', '-b', buf]);
  }
}
