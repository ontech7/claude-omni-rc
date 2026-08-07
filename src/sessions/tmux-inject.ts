import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface ExecResult { code: number; stdout: string; stderr: string; }
export type ExecFn = (args: string[], opts?: { input?: string }) => Promise<ExecResult>;
export type ShExecFn = (cmd: string, args: string[], opts?: { input?: string }) => Promise<ExecResult>;

// Esegue un comando di sistema (ps, lsof, …) con lo stesso contratto di ExecFn
// (codice d'uscita + stdout/stderr + timeout). Serve a ispezionare i processi,
// che il solo client tmux non può fare.
export function createShExec(opts: { timeoutMs?: number } = {}): ShExecFn {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return (cmd, args, o) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // timeout di sicurezza: un comando appeso non deve stallare un handler.
    const timer = setTimeout(() => {
      reject(new Error(`${cmd} command timed out after ${timeoutMs}ms`));
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    if (o?.input) child.stdin.write(o.input);
    child.stdin.end();
  });
}

export function createExec(opts: { timeoutMs?: number } = {}): ExecFn {
  const sh = createShExec(opts);
  return (args, o) => sh('tmux', args, o);
}

// Fotografia della tabella dei processi: ppid → figli e pid → eseguibile.
// Costruirla costa uno spawn di `ps`, quindi va presa una volta e riusata per
// tutte le sessioni dello stesso giro di polling.
export interface ProcessTree {
  children: Map<string, string[]>;
  comms: Map<string, string>;
}

export class TmuxClient {
  constructor(
    private exec: ExecFn = createExec(),
    private sh: ShExecFn = createShExec(),
  ) {}

  async processTree(): Promise<ProcessTree | undefined> {
    const ps = await this.sh('ps', ['-o', 'pid=,ppid=,comm=']);
    if (ps.code !== 0) return undefined;
    const children = new Map<string, string[]>(); // ppid → [figli]
    const comms = new Map<string, string>();      // pid → eseguibile
    for (const line of ps.stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
      if (!m) continue;
      const [, pid, ppid, comm] = m;
      comms.set(pid, comm);
      const kids = children.get(ppid) ?? [];
      kids.push(pid);
      children.set(ppid, kids);
    }
    return { children, comms };
  }

  async listSessions(): Promise<string[]> {
    const r = await this.exec(['list-sessions', '-F', '#{session_name}']);
    if (r.code !== 0) return [];
    return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  }

  // Il server tmux è attivo? (list-sessions vuoto può essere "nessuna sessione"
  // o "server spento" — il pruning delle sessioni morte non deve scattare nel
  // secondo caso.)
  async serverRunning(): Promise<boolean> {
    const r = await this.exec(['list-sessions']);
    return r.code === 0;
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

  // Directory di lavoro corrente del pane — serve a risolvere il transcript del
  // CLI per le sessioni tmux scoperte (il nome `claude:<progetto>` da solo non
  // basta a trovare ~/.claude/projects).
  async paneCwd(target: string): Promise<string> {
    const t = await this.resolveTarget(target);
    const r = await this.exec(['display-message', '-p', '-t', t, '#{pane_current_path}']);
    if (r.code !== 0) throw new Error(`tmux display-message failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  // Nome del comando attivo nel pane. Quando Claude Code esce (senza chiudere
  // la finestra) il pane torna alla shell: il comando passa da "ollama"/"claude"
  // a "zsh"/"bash"… — è il segnale che la sessione è finita davvero.
  async paneCommand(target: string): Promise<string> {
    const t = await this.resolveTarget(target);
    const r = await this.exec(['display-message', '-p', '-t', t, '#{pane_current_command}']);
    if (r.code !== 0) throw new Error(`tmux display-message failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  // Cwd REALE del processo claude nel pane. Quando il CLI sposta la sessione in
  // un git worktree (`cd .claude/worktrees/<nome>`), il cwd del PANE resta
  // quello di partenza: `pane_current_path` non basta a risolvere il transcript,
  // che finisce nella dir worktree-encoded di ~/.claude/projects. Il processo
  // claude (figlio di `ollama launch claude`) invece ha il cwd vero.
  //
  // Dal pane_pid (la radice del pane) scende nell'albero dei processi fino al
  // primo il cui eseguibile è `claude` e ne legge il cwd con lsof. undefined se
  // il processo non c'è o non è leggibile → il chiamante ripiega sul cwd del pane.
  async claudeCwd(target: string, tree?: ProcessTree): Promise<string | undefined> {
    try {
      const t = await this.resolveTarget(target);
      const pidRes = await this.exec(['display-message', '-p', '-t', t, '#{pane_pid}']);
      if (pidRes.code !== 0) return undefined;
      const root = pidRes.stdout.trim();
      if (!/^\d+$/.test(root)) return undefined;

      // Lo snapshot può arrivare dal chiamante: il watcher ne prende UNO per
      // poll e lo condivide fra le sessioni, invece di uno `ps` per sessione.
      const snapshot = tree ?? await this.processTree();
      if (!snapshot) return undefined;
      const { children, comms } = snapshot;

      // BFS dalla radice: il primo processo con eseguibile `claude` è quello che
      // sta scrivendo il transcript di questa sessione.
      const queue = [root];
      const seen = new Set<string>();
      while (queue.length) {
        const pid = queue.shift()!;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const comm = comms.get(pid) ?? '';
        if (comm.split('/').pop() === 'claude') {
          const lsof = await this.sh('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']);
          if (lsof.code !== 0) return undefined;
          for (const line of lsof.stdout.split('\n')) {
            const n = line.match(/^n(.*)$/);
            if (n) return n[1];
          }
          return undefined;
        }
        queue.push(...(children.get(pid) ?? []));
      }
      return undefined;
    } catch {
      return undefined;
    }
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

  // Invia tasti grezzi al pane (es. 'C-c' per interrompere la generazione come ESC).
  async sendKeys(target: string, keys: string): Promise<void> {
    const t = await this.resolveTarget(target);
    const r = await this.exec(['send-keys', '-t', t, keys]);
    if (r.code !== 0) throw new Error(`tmux send-keys failed: ${r.stderr}`);
  }
}
