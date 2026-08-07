import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { OllamaClient } from '../ollama.js';
import type { PermissionFlow } from '../permissions.js';
import type { DialogFlow } from '../dialogs.js';
import type { SessionManager } from './manager.js';
import { parseAskUserQuestions } from './transcript.js';

export interface SdkDriverDeps {
  bus: Bus;
  manager: SessionManager;
  config: Config;
  permissionFlow: PermissionFlow;
  dialogFlow: DialogFlow;
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
      // /stop durante la finestra di modelContext: l'abort è già scattato prima che
      // query() attacchi il listener → va onorato qui (e dopo la fetch), o si perderebbe.
      if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
      // L'SDK spawna `claude --model <modello>` con l'ambiente del daemon. Il
      // driver è "omni": rispetta il provider configurato dall'utente via env
      // (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY in .env).
      // Solo quando il base URL è quello di Ollama replica `ollama launch claude`
      // (token placeholder + mapping dei modelli default + context length reale);
      // per ogni altro provider l'env passa intatto.
      const env = { ...process.env };
      const baseUrl = env.ANTHROPIC_BASE_URL ?? config.ollamaBaseUrl;
      env.ANTHROPIC_BASE_URL = baseUrl;
      if (baseUrl === config.ollamaBaseUrl) {
        if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_AUTH_TOKEN = 'ollama';
        if (env.ANTHROPIC_API_KEY === undefined) env.ANTHROPIC_API_KEY = '';
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
        const ctx = await this.deps.ollama.modelContext(model);
        if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (ctx !== undefined) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctx);
      }
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
          canUseTool: (toolName, input, opts) => {
            // AskUserQuestion: niente permesso — la risposta è la domanda stessa.
            if (toolName === 'AskUserQuestion') return Promise.resolve({ behavior: 'allow' });
            // automode: accetta ogni permesso senza chiedere. È opt-in esplicito
            // (/new --auto o DEFAULT_PERMISSION_MODE=auto) — una sessione senza
            // modo dichiarato (es. stato salvato da una versione precedente)
            // passa sempre dai bottoni.
            if (session.permissionMode === 'auto') return Promise.resolve({ behavior: 'allow' });
            return permissionFlow.request(sessionId, toolName, input as Record<string, unknown>, opts.signal);
          },
          // Dialoghi bloccanti (request_user_dialog): l'unico kind che il CLI
          // emette davvero è refusal_fallback_prompt (retry dopo un refusal).
          // Senza onUserDialog il CLI parcheggia il turno e l'utente resta
          // bloccato — esattamente il caso da evitare. L'approvazione del piano
          // NON passa da qui: ExitPlanMode arriva come permesso via canUseTool.
          onUserDialog: (request, opts) =>
            this.deps.dialogFlow.request(sessionId, request, opts.signal),
          supportedDialogKinds: ['refusal_fallback_prompt'],
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
              if (block.name === 'AskUserQuestion') {
                // il menu a scelta multipla diventa una domanda ❓ con bottoni
                // (stesso percorso delle terminali), non una bubble di tool col JSON.
                const questions = parseAskUserQuestions(block.input);
                if (questions.length) bus.emit({ type: 'session.prompt', sessionId, questions });
                continue;
              }
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
        bus.emit({ type: 'session.error', sessionId, message: 'Stopped by the user' });
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
