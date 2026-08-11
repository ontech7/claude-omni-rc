import { createShExec, type ShExecFn } from './sessions/tmux-inject.js';

// Branch git corrente della directory, per /diag. Best-effort: undefined se la
// dir non è in un repo git, se HEAD è detached (`symbolic-ref --short HEAD`
// fallisce), se git non è installato o se il comando va in timeout. Calcolato
// alla render di /diag (non persistito): il cwd di una sessione può spostarsi
// tra worktree, quindi la verità è quella letta ora.
export async function currentBranch(dir: string, sh: ShExecFn = createShExec({ timeoutMs: 2000 })): Promise<string | undefined> {
  try {
    const r = await sh('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
    if (r.code !== 0) return undefined;
    const branch = r.stdout.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}
