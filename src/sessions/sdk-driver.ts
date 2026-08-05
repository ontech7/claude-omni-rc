import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { OllamaClient } from '../ollama.js';
import type { PermissionFlow } from '../permissions.js';
import type { SessionManager } from './manager.js';

export interface SdkDriverDeps {
  bus: Bus;
  manager: SessionManager;
  config: Config;
  permissionFlow: PermissionFlow;
  ollama: Pick<OllamaClient, 'modelContext'>;
}

export class SdkDriver {
  private busy = new Set<string>();
  private aborters = new Map<string, AbortController>();

  constructor(private deps: SdkDriverDeps) {}

  isBusy(sessionId: string): boolean { return this.busy.has(sessionId); }

  // /stop (e /rc off): abort del turno in corso via AbortController (opzione SDK).
  stop(sessionId: string): boolean {
    const ac = this.aborters.get(sessionId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  async runTurn(sessionId: string, prompt: string): Promise<void> {
    const { bus, manager, config, permissionFlow } = this.deps;
    if (this.busy.has(sessionId)) throw new Error(`session ${sessionId} is busy`);
    const session = manager.get(sessionId);
    if (!session || session.kind !== 'headless') throw new Error(`no headless session ${sessionId}`);
    this.busy.add(sessionId);
    manager.setStatus(sessionId, 'running');
    const ac = new AbortController();
    this.aborters.set(sessionId, ac);
    try {
      const model = session.model ?? config.defaultModel;
      const ctx = await this.deps.ollama.modelContext(model);
      // /stop durante la finestra di modelContext: l'abort è già scattato prima
      // che query() attacchi il listener → va onorato qui, o si perderebbe.
      if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
      // L'SDK spawna `claude --model <modello>` con l'ambiente del daemon, che
      // non ha le env Ollama → il CLI fallirebbe. Replica l'ambiente che
      // `ollama launch claude` setta (verificato empiricamente): base URL +
      // auth token + mapping del modello sui default + context length reale.
      const env = {
        ...process.env,
        ANTHROPIC_BASE_URL: config.ollamaBaseUrl,
        ANTHROPIC_AUTH_TOKEN: 'ollama',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: ctx !== undefined ? String(ctx) : undefined,
      };
      const stream = query({
        prompt,
        options: {
          model,
          cwd: session.projectDir,
          resume: session.claudeSessionId,
          permissionMode: 'default',
          additionalDirectories: [config.inboxDir],
          abortController: ac,
          env,
          canUseTool: (toolName, input, opts) =>
            permissionFlow.request(sessionId, toolName, input as Record<string, unknown>, opts.signal),
        },
      });
      let finished = false;
      for await (const msg of stream) {
        if (msg.session_id) manager.setClaudeSessionId(sessionId, msg.session_id);
        if (msg.type === 'assistant') {
          manager.touch(sessionId);
          const text = msg.message.content
            .filter(b => b.type === 'text')
            .map(b => (b as { text: string }).text)
            .join('\n');
          if (text.trim()) bus.emit({ type: 'session.text', sessionId, role: 'assistant', text });
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              bus.emit({
                type: 'session.tool', sessionId, toolName: block.name, kind: 'tool_use',
                toolUseId: block.id, input: block.input as Record<string, unknown>,
              });
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message.content) {
            if (typeof block !== 'string' && block.type === 'tool_result') {
              bus.emit({
                type: 'session.tool', sessionId, toolName: '', kind: 'tool_result',
                toolUseId: block.tool_use_id, result: block.content, isError: block.is_error,
              });
            }
          }
        } else if (msg.type === 'result') {
          finished = true;
          if (msg.subtype === 'success') {
            bus.emit({ type: 'session.result', sessionId, result: msg.result, isError: false });
            manager.setStatus(sessionId, 'idle');
          } else {
            bus.emit({ type: 'session.error', sessionId, message: msg.errors.join('\n') });
            manager.setStatus(sessionId, 'error');
          }
        }
      }
      if (!finished) manager.setStatus(sessionId, 'idle');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        bus.emit({ type: 'session.error', sessionId, message: "Fermata dall'utente" });
        manager.setStatus(sessionId, 'stopped');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        bus.emit({ type: 'session.error', sessionId, message });
        manager.setStatus(sessionId, 'error');
      }
    } finally {
      this.aborters.delete(sessionId);
      this.busy.delete(sessionId);
    }
  }
}
