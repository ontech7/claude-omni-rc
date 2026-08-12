import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Bus } from '../bus.js';
import { newEventId } from '../bus.js';
import { log } from '../log.js';
import type { Config } from '../config.js';
import type { OllamaClient } from '../ollama.js';
import type { PermissionFlow } from '../permissions.js';
import type { DialogFlow } from '../dialogs.js';
import type { SessionManager } from './manager.js';
import { parseAskUserQuestions } from './transcript.js';
import { resolveProvider } from '../usage.js';

// Tool di sola lettura che il CLI nativo autorizza senza prompt: la headless deve
// comportarsi come una sessione tmux, dove il modello non viene bloccato per
// leggere. Ogni tool che cambia stato resta sui bottoni di approvazione.
const READ_ONLY_TOOLS = new Set(['Read', 'ReadFile', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);

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
      // driver è "omni": stesso criterio di omni-rc.sh (resolveProvider) —
      // ANTHROPIC_BASE_URL esplicito (≠ Ollama) vince per ogni modello; un
      // modello Anthropic (claude-*) va su Anthropic nativo; tutto il resto
      // replica `ollama launch claude` (token placeholder + mapping dei modelli
      // default + context length reale).
      const env = { ...process.env };
      const provider = resolveProvider(config, model, env);
      if (provider === 'ollama') {
        env.ANTHROPIC_BASE_URL = config.ollamaBaseUrl;
        if (!env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_API_KEY) env.ANTHROPIC_AUTH_TOKEN = 'ollama';
        if (env.ANTHROPIC_API_KEY === undefined) env.ANTHROPIC_API_KEY = '';
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
        const ctx = await this.deps.ollama.modelContext(model);
        if (ac.signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (ctx !== undefined) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(ctx);
      } else if (provider === 'anthropic') {
        // Anthropic nativo: base URL esplicito, credenziali (ANTHROPIC_AUTH_TOKEN
        // / ANTHROPIC_API_KEY) già nell'env del daemon passano intatte.
        env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
      }
      // 'custom': l'env passa intatto (ANTHROPIC_BASE_URL già impostato).
      const stream = query({
        prompt,
        options: {
          model,
          cwd: session.projectDir,
          resume: session.claudeSessionId,
          permissionMode: 'default',
          additionalDirectories: [config.inboxDir],
          // Effort di ragionamento (se la sessione ne ha uno — default
          // DEFAULT_EFFORT per le headless). L'SDK lo ignora/declassa per i
          // modelli che non lo supportano: comportamento SDK, non nostro.
          ...(session.effort ? { effort: session.effort } : {}),
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
            // parità col CLI nativo (tmux): i tool read-only non fanno scattare il prompt
            if (READ_ONLY_TOOLS.has(toolName)) return Promise.resolve({ behavior: 'allow' });
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
        // The SDK marks every message produced by a subagent with
        // parent_tool_use_id, and by default already emits its tool_use /
        // tool_result blocks. Propagating it is what lets the bot keep those
        // out of the main stream; ignoring it was the cause of the mixing.
        const parentToolUseId = ('parent_tool_use_id' in msg && msg.parent_tool_use_id) ? msg.parent_tool_use_id : undefined;
        if (msg.session_id) manager.setClaudeSessionId(sessionId, msg.session_id);
        if (msg.type === 'assistant') {
          manager.touch(sessionId);
          const text = msg.message.content
            .filter(b => b.type === 'text')
            .map(b => (b as { text: string }).text)
            .join('\n');
          if (text.trim()) {
            const eventId = newEventId();
            // stesso schema del watcher per 'text': role e chars, non solo l'id —
            // altrimenti un filtro su questi campi salterebbe in silenzio gli eventi sdk.
            log().info('event emitted', { eventId, sessionId, source: 'sdk', kind: 'text', role: 'assistant', chars: text.length, parentToolUseId });
            bus.emit({ type: 'session.text', sessionId, role: 'assistant', text, eventId, parentToolUseId });
          }
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              if (block.name === 'AskUserQuestion') {
                // il menu a scelta multipla diventa una domanda ❓ con bottoni
                // (stesso percorso delle terminali), non una bubble di tool col JSON.
                const questions = parseAskUserQuestions(block.input);
                if (questions.length) {
                  const eventId = newEventId();
                  log().info('event emitted', { eventId, sessionId, source: 'sdk', kind: 'prompt', questions: questions.length });
                  bus.emit({ type: 'session.prompt', sessionId, questions, eventId });
                }
                continue;
              }
              {
                const eventId = newEventId();
                // kind: 'tool' allinea il campo log al vocabolario del bot (GateKind),
                // lo stesso usato dal transcript-watcher: toolUseId distingue comunque
                // una tool_use da un tool_result senza bisogno di due valori diversi.
                log().info('event emitted', { eventId, sessionId, source: 'sdk', kind: 'tool', toolName: block.name, toolUseId: block.id, parentToolUseId });
                bus.emit({
                  type: 'session.tool', sessionId, toolName: block.name, kind: 'tool_use',
                  toolUseId: block.id, input: block.input as Record<string, unknown>, eventId, parentToolUseId,
                });
              }
            }
          }
        } else if (msg.type === 'user') {
          for (const block of msg.message.content) {
            if (typeof block !== 'string' && block.type === 'tool_result') {
              const eventId = newEventId();
              // stesso schema del watcher per 'tool_result': la chiave toolName c'è
              // sempre, qui vuota perché l'SDK non lo riporta sul blocco tool_result
              // (lo stesso motivo per cui l'evento emesso sotto ha toolName: '').
              log().debug('event emitted', { eventId, sessionId, source: 'sdk', kind: 'tool', toolName: '', toolUseId: block.tool_use_id, isError: block.is_error, parentToolUseId });
              bus.emit({
                type: 'session.tool', sessionId, toolName: '', kind: 'tool_result',
                toolUseId: block.tool_use_id, result: block.content, isError: block.is_error, eventId, parentToolUseId,
              });
            }
          }
        } else if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_progress' || msg.subtype === 'task_updated')) {
          const eventId = newEventId();
          if (msg.subtype === 'task_updated') {
            const status = msg.patch?.status;
            // Only terminal states close the card: 'running'/'pending'/'paused'
            // add nothing to what task_progress already says.
            if (status !== 'completed' && status !== 'failed' && status !== 'killed') continue;
            bus.emit({
              type: 'session.agent', sessionId, taskId: msg.task_id, phase: 'done',
              status, error: msg.patch?.error, eventId,
            });
          } else if (msg.subtype === 'task_started') {
            bus.emit({
              type: 'session.agent', sessionId, taskId: msg.task_id, toolUseId: msg.tool_use_id,
              phase: 'started', subagentType: msg.subagent_type, description: msg.description, eventId,
            });
          } else {
            bus.emit({
              type: 'session.agent', sessionId, taskId: msg.task_id, toolUseId: msg.tool_use_id,
              phase: 'progress', subagentType: msg.subagent_type, description: msg.description,
              toolUses: msg.usage?.tool_uses, durationMs: msg.usage?.duration_ms,
              lastToolName: msg.last_tool_name, eventId,
            });
          }
          log().debug('event emitted', { eventId, sessionId, source: 'sdk', kind: 'agent', taskId: msg.task_id, phase: msg.subtype });
        } else if (msg.type === 'result') {
          finished = true;
          if (msg.subtype === 'success') {
            bus.emit({ type: 'session.result', sessionId, result: msg.result, isError: false });
            manager.setStatus(sessionId, 'idle');
          } else {
            const eventId = newEventId();
            const message = msg.errors.join('\n');
            log().warn('event emitted', { eventId, sessionId, source: 'sdk', kind: 'error', message });
            bus.emit({ type: 'session.error', sessionId, message, eventId });
            manager.setStatus(sessionId, 'error');
          }
        }
      }
      if (!finished) manager.setStatus(sessionId, 'idle');
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        const eventId = newEventId();
        log().warn('event emitted', { eventId, sessionId, source: 'sdk', kind: 'error', message: 'Stopped by the user' });
        bus.emit({ type: 'session.error', sessionId, message: 'Stopped by the user', eventId });
        manager.setStatus(sessionId, 'stopped');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        const eventId = newEventId();
        log().warn('event emitted', { eventId, sessionId, source: 'sdk', kind: 'error', message });
        bus.emit({ type: 'session.error', sessionId, message, eventId });
        manager.setStatus(sessionId, 'error');
      }
    } finally {
      this.aborters.delete(sessionId);
      this.busy.delete(sessionId);
    }
  }
}
