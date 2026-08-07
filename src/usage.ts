import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Config } from './config.js';
import type { ShExecFn } from './sessions/tmux-inject.js';

// Stesso criterio di sdk-driver.ts per decidere il provider: ANTHROPIC_BASE_URL
// esplicito -> quel provider (Anthropic o un proxy); assente -> Ollama.
export function isOllamaProvider(config: Config, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ANTHROPIC_BASE_URL ?? config.ollamaBaseUrl) === config.ollamaBaseUrl;
}

export interface OllamaUsageWindow {
  identifier: string;
  pct_used?: number;
  reset_at?: string | null;
}

export type OllamaUsageResult =
  | { kind: 'ok'; windows: Record<string, OllamaUsageWindow> }
  | { kind: 'not-installed' }
  | { kind: 'needs-auth' }
  | { kind: 'error'; message: string };

// `ollama-usage --json` -> le due finestre (5h + weekly). Vedi
// https://github.com/ontech7/ollama-usage per il tool.
export async function fetchOllamaUsage(sh: ShExecFn): Promise<OllamaUsageResult> {
  let res;
  try {
    res = await sh('ollama-usage', ['--json']);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'not-installed' };
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  if (res.code === 2) return { kind: 'needs-auth' };
  if (res.code !== 0) return { kind: 'error', message: (res.stderr || res.stdout).trim().slice(0, 300) || `exit ${res.code}` };
  try {
    return { kind: 'ok', windows: JSON.parse(res.stdout) };
  } catch {
    return { kind: 'error', message: 'unexpected ollama-usage output' };
  }
}

export interface AnthropicUsageWindow { utilization: number | null; resetsAt: string | null; }

export type AnthropicUsageResult =
  | { kind: 'ok'; fiveHour?: AnthropicUsageWindow; sevenDay?: AnthropicUsageWindow }
  | { kind: 'unavailable' } // API key / Bedrock / Vertex: nessuna finestra di piano
  | { kind: 'error'; message: string };

// Apre una query dell'Agent SDK in streaming-input mode SENZA mandare alcun
// turno (l'iterable resta pending finché non chiudiamo noi) solo per leggere
// i dati dietro il /usage nativo di Claude Code via il control-plane della SDK.
// EXPERIMENTAL lato SDK (nome del metodo esplicito): può sparire con un bump
// della versione pinnata in package.json.
export async function fetchAnthropicUsage(timeoutMs = 15_000): Promise<AnthropicUsageResult> {
  let release: () => void = () => {};
  const gate = new Promise<void>(r => { release = r; });
  async function* heldOpen(): AsyncGenerator<SDKUserMessage> { await gate; }

  const stream = query({
    prompt: heldOpen(),
    options: {
      cwd: process.cwd(),
      env: { ...process.env },
      permissionMode: 'default',
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'usage check only' }),
    },
  });
  try {
    const usage = await Promise.race([
      stream.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs)),
    ]);
    if (!usage.rate_limits_available || !usage.rate_limits) return { kind: 'unavailable' };
    const { five_hour, seven_day } = usage.rate_limits;
    return {
      kind: 'ok',
      fiveHour: five_hour ? { utilization: five_hour.utilization, resetsAt: five_hour.resets_at } : undefined,
      sevenDay: seven_day ? { utilization: seven_day.utilization, resetsAt: seven_day.resets_at } : undefined,
    };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    release();
    await stream.return(undefined).catch(() => {});
  }
}
