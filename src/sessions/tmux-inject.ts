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

  // I nomi sessione `claude:<progetto>` contengono ":" e tmux li leggerebbe come
  // session:window → fallisce. Ogni operazione risolve il nome nel session id
  // corrente (`$0`…), che è sempre univoco e resta valido anche dopo i restart.
  private async resolveTarget(target: string): Promise<string> {
    if (/^\$[0-9]+$/.test(target)) return target;
    const r = await this.exec(['list-sessions', '-F', '#{session_id} #{session_name}']);
    if (r.code !== 0) throw new Error(`tmux list-sessions failed: ${r.stderr}`);
    for (const line of r.stdout.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const sp = t.indexOf(' ');
      if (sp === -1) continue;
      const id = t.slice(0, sp);
      const name = t.slice(sp + 1);
      if (name === target) return id;
    }
    throw new Error(`tmux session not found: ${target}`);
  }

  // Contenuto corrente del pane (raw, con sequenze ANSI da strippare in lettura).
  async capturePane(target: string): Promise<string> {
    const t = await this.resolveTarget(target);
    const r = await this.exec(['capture-pane', '-p', '-t', t]);
    if (r.code !== 0) throw new Error(`tmux capture-pane failed: ${r.stderr}`);
    return r.stdout;
  }

  // 1:1: incolla il testo (bracketed paste, niente interpretazione shell) e preme
  // Invio — invia un prompt o risponde a una domanda interattiva (scelta multipla).
  // load-buffer (non set-buffer) legge davvero il testo da stdin: set-buffer tratta
  // "-" come contenuto letterale.
  async injectText(target: string, text: string): Promise<void> {
    const t = await this.resolveTarget(target);
    const buf = `rc-${randomBytes(4).toString('hex')}`;
    const load = await this.exec(['load-buffer', '-b', buf, '-'], { input: text });
    if (load.code !== 0) throw new Error(`tmux load-buffer failed: ${load.stderr}`);
    const paste = await this.exec(['paste-buffer', '-b', buf, '-t', t, '-p']);
    if (paste.code !== 0) throw new Error(`tmux paste-buffer failed: ${paste.stderr}`);
    await this.exec(['delete-buffer', '-b', buf]);
    await this.exec(['send-keys', '-t', t, 'Enter']);
  }
}
