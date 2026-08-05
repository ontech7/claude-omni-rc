import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Bus } from '../src/bus.js';
import type { Config } from '../src/config.js';
import type { SessionManager } from '../src/sessions/manager.js';
import type { PermissionFlow } from '../src/permissions.js';
import type { SdkDriver } from '../src/sessions/sdk-driver.js';
import type { TmuxClient } from '../src/sessions/tmux-inject.js';
import type { OllamaClient } from '../src/ollama.js';
import type { Inbox } from '../src/input.js';
import type { Session, PermissionRequest, PromptQuestion } from '../src/types.js';
import type { RecentMessage } from '../src/sessions/transcript.js';

// ---------- pure helpers ----------

export type ParsedCommand =
  | { kind: 'control'; command: 'rc' | 'help'; arg?: string }
  | { kind: 'start'; arg?: string }
  | { kind: 'session'; command: 'sessions' | 'new' | 'stop' | 'status' | 'attach'; arg?: string }
  | { kind: 'text' }
  | { kind: 'unknown' };

const CONTROL_COMMANDS = new Set(['rc', 'help', 'start']);

export function parseCommand(text: string): ParsedCommand {
  const t = text.trim();
  if (!t.startsWith('/')) return { kind: 'text' };
  const [raw, ...rest] = t.split(/\s+/);
  const command = raw.slice(1).toLowerCase();
  const arg = rest.join(' ').trim();
  // `arg` è omesso quando vuoto (campo opzionale nel tipo)
  const control = (c: 'rc' | 'help'): ParsedCommand =>
    arg ? { kind: 'control', command: c, arg } : { kind: 'control', command: c };
  const sessionCmd = (c: 'sessions' | 'new' | 'stop' | 'status' | 'attach'): ParsedCommand =>
    arg ? { kind: 'session', command: c, arg } : { kind: 'session', command: c };
  if (command === 'rc' || command === 'help') return control(command as 'rc' | 'help');
  if (command === 'start') return arg ? { kind: 'start', arg } : { kind: 'start' };
  if (['sessions', 'new', 'stop', 'status', 'attach'].includes(command)) {
    return sessionCmd(command as 'sessions' | 'new' | 'stop' | 'status' | 'attach');
  }
  return { kind: 'unknown' };
}

export interface CallbackData {
  action: 'approve' | 'deny' | 'select' | 'answer' | 'del' | 'del-yes' | 'del-no';
  id: string;
  index?: number;        // per 'answer': indice opzione
  questionIndex?: number; // per 'answer': indice domanda
}

export function parseCallbackData(data: string): CallbackData {
  const parts = data.split(':');
  if (parts.length === 3) {
    const [ns, action, id] = parts;
    if (ns === 'perm' && (action === 'approve' || action === 'deny') && id) return { action, id };
    if (ns === 'sess' && action === 'select' && id) return { action: 'select', id };
    if (ns === 'sess' && action === 'del' && id) return { action: 'del', id };
    if (ns === 'sess' && (action === 'del-yes' || action === 'del-no') && id) return { action, id };
  }
  if (parts.length === 5) {
    const [ns, action, token, q, o] = parts;
    if (ns === 'q' && action === 'answer' && token && /^\d+$/.test(q) && /^\d+$/.test(o)) {
      return { action: 'answer', id: token, questionIndex: Number(q), index: Number(o) };
    }
  }
  throw new Error(`bad callback data: ${data}`);
}

// parse_mode 'HTML' rigetta markup malformato (es. '<b' sbilanciato) e il send è
// dentro .catch(()=>{}) → il messaggio sparirebbe in silenzio. Escapare ogni frammento
// dinamico prima di interpolarlo nei template HTML.
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Rimuove le sequenze ANSI (colori, movimento cursore) dal contenuto del pane.
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\r/g, '');
}

// Render minimale markdown → HTML per i messaggi in chat.
export function mdToHtml(text: string): string {
  let out = htmlEscape(text);
  out = out.replace(/```([\s\S]*?)```/g, (_m, c: string) => `<pre>${c}</pre>`);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  out = out.replace(/^[-*]\s+(.+)$/gm, '• $1');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

export function permissionMessage(req: PermissionRequest): string {
  const input = htmlEscape(JSON.stringify(req.input, null, 2).slice(0, 1000));
  return `🔧 Permission requested — session <b>${htmlEscape(req.sessionId.slice(0, 8))}</b>\nTool: <code>${htmlEscape(req.toolName)}</code>\n<pre>${input}</pre>`;
}

// Intestazione della domanda a scelta multipla (le opzioni diventano bottoni).
export function promptMessage(questions: PromptQuestion[]): string {
  return questions
    .map(q => {
      const title = q.header ? `${q.header}: ${q.question}` : q.question;
      return `❓ <b>${htmlEscape(title)}</b>`;
    })
    .join('\n\n');
}

// Matcher per il Fix 1: sopprime l'echo di un testo che il bot ha appena
// iniettato nel pane (l'utente lo vede già). Confronto trim, finestra 60s.
export function matchesInjected(recent: { text: string; at: number }[], text: string, now: number, windowMs = 60_000): boolean {
  const t = text.trim();
  return recent.some(item => now - item.at <= windowMs && item.text.trim() === t);
}

// Blocco di storia per il Fix 5: gli ultimi messaggi renderizzati come chat.
export function renderHistory(messages: RecentMessage[], title: string, maxChars = 3000): string {
  const body = messages.map(m => `${m.role === 'user' ? '🧑' : '🤖'} ${mdToHtml(m.text)}`).join('\n\n');
  return `<b>Last messages · ${htmlEscape(title)}</b>\n\n${body.slice(0, maxChars)}`;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Una riga per sessione, con le info che servono a riconoscerla: per le
// terminali il target tmux, per le headless il modello, più l'ultima attività
// relativa (la sessione "in uso" è quella con "just now").
export function sessionListText(sessions: Session[], activeId?: string): string {
  if (!sessions.length) return 'No sessions.';
  return sessions
    .map(s => {
      const marker = s.id === activeId ? '▸' : ' ';
      const title = htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8));
      const detail = s.kind === 'terminal'
        ? (s.tmuxTarget ? `<code>${htmlEscape(s.tmuxTarget)}</code>` : 'no tmux')
        : `<code>${htmlEscape(s.model ?? 'model')}</code>`;
      return `${marker} <b>${title}</b> · ${s.kind} · ${detail} — ${s.status} · ${relativeTime(s.lastActivity)}`;
    })
    .join('\n');
}

// spec §8: mai inoltrare blocchi immagine a modelli text-only.
// Nota onesta (review finale): l'inoltro immagine è un "path reference" — il modello
// legge il file via additionalDirectories: inboxDir — NON un blocco immagine nel
// prompt, perché l'SDK query accetta solo prompt testuali. Il flag attach è
// volutamente assente (il codice non deve fingere un attach che non fa).
export function attachmentPlan(
  modelHasVision: boolean,
  kind: 'image' | 'document',
): { warning?: string } {
  if (kind === 'image' && !modelHasVision) {
    return { warning: '⚠️ This model has no vision: forwarding only the file path reference.' };
  }
  return {};
}

export class EditThrottler {
  private lastEdit = 0;
  constructor(private minIntervalMs = 1000) {}
  async throttled<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const wait = this.lastEdit + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastEdit = Date.now();
    try { return await fn(); } catch { return undefined; }
  }
}

// Aggregazione delle notifiche tool in una bubble per raffica: il primo tool_use
// crea il messaggio, i successivi lo modificano (edit) finché la raffica è aperta.
// `close()` viene chiamato su testo/domanda/permesso/errore → la raffica successiva
// apre una bubble nuova. Cap su maxLen: oltre il limite si apre una bubble nuova.
export interface ToolBurstSink {
  edit(messageId: number, text: string): Promise<boolean>;
  send(text: string): Promise<number | undefined>;
}

export class ToolBurstAggregator {
  private open?: { messageId: number; text: string; at: number };
  private lastWasTool = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private sink: ToolBurstSink, private maxLen = 3800) {}

  // Serializza le push: il bus emette in modo sincrono e due tool_use nello stesso
  // tick leggerebbero open/lastWasTool prima di ogni await — la catena rende le
  // mutazioni atomiche rispetto alle push concorrenti.
  push(line: string): Promise<void> {
    this.chain = this.chain.then(() => this.pushNow(line)).catch(() => { /* la catena sopravvive a un errore inatteso del sink */ });
    return this.chain;
  }

  private async pushNow(line: string): Promise<void> {
    const open = this.open;
    if (this.lastWasTool && open) {
      const next = `${open.text}\n${line}`;
      if (next.length <= this.maxLen && await this.sink.edit(open.messageId, next)) {
        open.text = next;
        open.at = Date.now();
        return;
      }
    }
    const id = await this.sink.send(line);
    if (id !== undefined) {
      this.open = { messageId: id, text: line, at: Date.now() };
      this.lastWasTool = true;
    } else {
      // send fallita (es. chatId assente): senza bubble aperta la prossima push
      // deve aprirne una nuova, non editare una bubble stantia.
      this.lastWasTool = false;
    }
  }

  close(): void {
    this.open = undefined;
    this.lastWasTool = false;
  }
}

// ---------- bot ----------

export interface BotDeps {
  config: Config;
  bus: Bus;
  manager: SessionManager;
  permissionFlow: PermissionFlow;
  sdk: SdkDriver;
  tmux: TmuxClient;
  inbox: Inbox;
  ollama: OllamaClient;
}

export class TelegramBot {
  private bot: Bot;
  private throttler = new EditThrottler(1000);
  private chatId?: number;
  private activeSessionId?: string;
  private lastMsg = new Map<string, { messageId: number; text: string; at: number; role: 'user' | 'assistant' }>();
  private toolBursts = new Map<string, ToolBurstAggregator>();

  constructor(private deps: BotDeps) {
    this.bot = new Bot(deps.config.telegramBotToken);
    this.register();
    this.subscribeBus();
  }

  async start(): Promise<void> {
    if (!this.deps.config.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN missing');
    await this.bot.api.setMyCommands([
      { command: 'rc', description: 'Arm / disarm remote control' },
      { command: 'sessions', description: 'List and switch sessions' },
      { command: 'view', description: 'Show the active session screen' },
      { command: 'new', description: 'Start a headless session' },
      { command: 'stop', description: 'Stop the active session' },
      { command: 'status', description: 'Active session status' },
      { command: 'attach', description: 'Attach a tmux terminal session' },
      { command: 'help', description: 'Show all commands' },
    ]).catch(() => {});
    await this.bot.start({ drop_pending_updates: true });
  }
  async stop(): Promise<void> {
    await this.bot.stop();
  }

  private send(ctx: Context, text: string): Promise<unknown> {
    return ctx.reply(text, { parse_mode: 'HTML' });
  }
  private notify(text: string): void {
    if (this.chatId) void this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
  private async forwardText(sessionId: string, text: string, role: 'user' | 'assistant'): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;
    const last = this.lastMsg.get(sessionId);
    const now = Date.now();
    // concatena solo messaggi dello stesso ruolo (un turno con più blocchi text
    // diventa una bubble unica; non mischia mai un echo utente con una risposta).
    if (last && last.role === role && now - last.at < 10_000) {
      const ok = await this.throttler.throttled(() =>
        this.bot.api.editMessageText(chatId, last.messageId, last.text + '\n' + text, { parse_mode: 'HTML' }).then(() => true).catch(() => false));
      if (ok) { last.text += '\n' + text; last.at = now; return; }
    }
    const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => undefined);
    if (msg) this.lastMsg.set(sessionId, { messageId: msg.message_id, text, at: now, role });
  }

  // Bubble di raffica per le notifiche tool (una per sessione); il sink usa
  // l'EditThrottler condiviso e l'API del bot. `close()` è chiamato dai handler
  // di testo/domanda/permesso/errore (via `toolBurst(id).close()`).
  private toolBurst(sessionId: string): ToolBurstAggregator {
    let agg = this.toolBursts.get(sessionId);
    if (!agg) {
      agg = new ToolBurstAggregator({
        edit: async (messageId, text) => {
          const chatId = this.chatId;
          if (!chatId) return false;
          const ok = await this.throttler.throttled(() =>
            this.bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' }).then(() => true).catch(() => false));
          return ok ?? false;
        },
        send: async text => {
          const chatId = this.chatId;
          if (!chatId) return undefined;
          const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => undefined);
          return msg?.message_id;
        },
      });
      this.toolBursts.set(sessionId, agg);
    }
    return agg;
  }

  private isAuthorized(ctx: Context): boolean {
    const userId = ctx.from?.id;
    return !!userId && (this.deps.config.allowedUserIds.includes(userId) || this.deps.manager.isAuthorizedUser(userId));
  }

  private authorize(ctx: Context): boolean {
    if (this.isAuthorized(ctx)) { this.chatId = ctx.chat?.id ?? this.chatId; return true; }
    void this.send(ctx, '⛔ Not authorized. Send <code>/start &lt;pairing code&gt;</code>.');
    return false;
  }

  private register(): void {
    const bot = this.bot;
    bot.command('start', ctx => this.onStart(ctx));
    bot.command('help', ctx => { if (this.authorize(ctx)) this.send(ctx, 'Commands: /rc on|off|status · /sessions · /view · /new &lt;text&gt; · /stop · /status · /attach &lt;project&gt; · /help'); });
    bot.command('rc', ctx => this.onRc(ctx));
    bot.command('sessions', ctx => this.onSessions(ctx));
    bot.command('view', ctx => this.onView(ctx));
    bot.command('new', ctx => this.onNew(ctx));
    bot.command('stop', ctx => this.onStop(ctx));
    bot.command('status', ctx => this.onStatus(ctx));
    bot.command('attach', ctx => this.onAttach(ctx));
    bot.on('callback_query:data', ctx => this.onCallback(ctx));
    bot.on('message:text', ctx => this.onMessage(ctx));
    bot.on('message:photo', ctx => this.onPhoto(ctx));
    bot.on('message:document', ctx => this.onDocument(ctx));
  }

  private async onStart(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (this.isAuthorized(ctx)) {
      this.chatId = ctx.chat?.id;
      await this.send(ctx, `👋 Welcome! State: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disarmed'}. Use /help.`);
      return;
    }
    const code = ctx.match?.toString().trim() ?? '';
    if (this.deps.config.pairingCode && code === this.deps.config.pairingCode) {
      this.deps.manager.addAuthorizedUser(userId);
      this.deps.manager.persist();
      this.chatId = ctx.chat?.id;
      await this.send(ctx, '✅ Pairing successful. Use /help.');
    } else {
      await this.send(ctx, '⛔ Not authorized. Send <code>/start &lt;pairing code&gt;</code>.');
    }
  }

  private async onRc(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    const arg = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (arg === 'on') {
      this.deps.manager.setArmed(true); this.deps.manager.persist();
      await this.send(ctx, '🔓 Remote control ARMED.');
    } else if (arg === 'off') {
      this.deps.manager.setArmed(false);
      for (const s of this.deps.manager.list()) {
        this.deps.permissionFlow.cancelAllForSession(s.id);
        this.deps.sdk.stop(s.id); // spegne anche i turni headless in corso
      }
      this.deps.manager.persist();
      await this.send(ctx, '🔒 Remote control DISARMED. No mirroring, injection or relay.');
    } else if (arg === 'status') {
      await this.send(ctx, `Switch: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disarmed'}`);
    } else {
      await this.send(ctx, 'Usage: /rc on | /rc off | /rc status');
    }
  }

  private requireArmed(ctx: Context): boolean {
    if (!this.deps.manager.isArmed()) { void this.send(ctx, '🔒 Remote control is off. Send /rc on.'); return false; }
    return true;
  }

  private async onSessions(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const list = this.deps.manager.list();
    if (!list.length) {
      await ctx.reply(
        'No sessions yet.\n\nRun Claude Code inside tmux and it will show up here automatically:\n<code>tmux new -s claude:&lt;project&gt;</code>\n\nOr start a headless session:\n<code>/new &lt;prompt&gt;</code>',
        { parse_mode: 'HTML' });
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of list) kb.text(s.id.slice(0, 6), `sess:select:${s.id}`);
    await ctx.reply(sessionListText(list, this.activeSessionId), {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }

  private async onNew(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const text = ctx.match?.toString().trim() ?? '';
    if (!text) { await this.send(ctx, 'Usage: /new &lt;text&gt;'); return; }
    const running = this.deps.manager.list().filter(s => s.kind === 'headless' && s.status === 'running').length;
    if (running >= this.deps.config.maxHeadlessSessions) { await this.send(ctx, `Reached the limit of ${this.deps.config.maxHeadlessSessions} active headless sessions.`); return; }
    const projectDir = this.deps.config.workspaceDirs[0] ?? homedir();
    const session = this.deps.manager.createHeadless({
      title: text.slice(0, 40), projectDir, model: this.deps.config.defaultModel,
    });
    this.activeSessionId = session.id;
    this.deps.manager.persist();
    await this.send(ctx, `🆕 Session <b>${htmlEscape(session.id.slice(0, 8))}</b> started.`);
    // NON await: grammy processa gli update in sequenza — aspettare un turno di minuti
    // bloccherebbe /stop, /rc off e i callback. Il driver emette gli eventi sul bus.
    void this.deps.sdk.runTurn(session.id, text);
  }

  private async onStop(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    if (this.activeSessionId) {
      this.deps.permissionFlow.cancelAllForSession(this.activeSessionId);
      this.deps.sdk.stop(this.activeSessionId); // abort del turno in corso
    }
    await this.send(ctx, '🛑 Stop requested for the active session.');
  }

  private async onStatus(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const s = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : undefined;
    await this.send(ctx, s
      ? `Active session: <b>${s.id.slice(0, 8)}</b> [${s.kind}] — ${s.status}`
      : 'No active session. Create one with /new.');
  }

  private async onAttach(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const name = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (!name) { await this.send(ctx, 'Usage: /attach &lt;project&gt;'); return; }
    const projectDir = this.resolveProjectDir(name);
    if (!projectDir) { await this.send(ctx, `Project "${htmlEscape(name)}" not found in the workspaces.`); return; }
    const session = this.deps.manager.registerTerminal({ title: name, projectDir, tmuxTarget: `claude:${name}` });
    this.activeSessionId = session.id;
    this.deps.manager.persist();
    await this.send(ctx, `📎 Terminal session <b>${htmlEscape(session.id.slice(0, 8))}</b> attached to <code>claude:${htmlEscape(name)}</code>.`);
  }

  private resolveProjectDir(name: string): string | undefined {
    for (const w of this.deps.config.workspaceDirs) {
      const candidate = join(w, name);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private async onCallback(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    // da disattivo nessuna approvazione/deny/switch (constraint 8): un permesso
    // in sospeso resta pending e scade → deny per timeout.
    if (!this.deps.manager.isArmed()) { await ctx.answerCallbackQuery({ text: '🔒 Remote control is off' }); return; }
    const data = ctx.callbackQuery?.data ?? '';
    try {
      const { action, id } = parseCallbackData(data);
      if (action === 'approve') {
        const ok = this.deps.permissionFlow.approve(id);
        await ctx.answerCallbackQuery({ text: ok ? '✓ Approved' : 'Already resolved' });
      } else if (action === 'deny') {
        const ok = this.deps.permissionFlow.deny(id);
        await ctx.answerCallbackQuery({ text: ok ? '✗ Rejected' : 'Already resolved' });
      } else {
        const s = this.deps.manager.get(id);
        if (s) this.activeSessionId = s.id;
        await ctx.answerCallbackQuery({ text: 'Session selected' });
        await ctx.editMessageText(sessionListText(this.deps.manager.list(), this.activeSessionId), { parse_mode: 'HTML' });
      }
    } catch {
      await ctx.answerCallbackQuery({ text: 'Invalid data' });
    }
  }

  private async routeMessageToSession(ctx: Context, text: string): Promise<void> {
    const session = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'No session. Create one with /new or /attach.'); return; }
    if (session.kind === 'headless') {
      if (this.deps.sdk.isBusy(session.id)) {
        await this.send(ctx, '⏳ Session busy: wait for it to go idle before forwarding.');
        return;
      }
      void this.deps.sdk.runTurn(session.id, text); // non bloccante (vedi onNew)
    } else {
      if (!session.tmuxTarget) {
        await this.send(ctx, 'This session is not running in tmux, so text can’t be injected. Start it with:\n<code>tmux new -s claude:&lt;project&gt;</code>');
        return;
      }
      await this.deps.tmux.injectText(session.tmuxTarget, text);
    }
  }

  private async onMessage(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    if (!ctx.message) return;
    // grammy 1.45: `text` è `text?: string` anche su message:text — la guardia non lo
    // restringe; `?? ''` è sicuro perché il filtro message:text scatta solo su testi.
    const text = ctx.message.text ?? '';
    if (text.startsWith('/')) return; // gestiti dai comandi
    if (!this.deps.manager.isArmed()) { await this.send(ctx, '🔒 Remote control is off. Send /rc on.'); return; }
    await this.routeMessageToSession(ctx, text);
  }

  // grammy 1.45: `ctx.getFile()` ritorna i METADATA del file ({ file_id, file_path }),
  // non i byte — i byte vanno scaricati dall'endpoint /file/bot<token>/<file_path>.
  private async downloadTelegramFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.deps.config.telegramBotToken}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async onPhoto(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const session = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'No session. Create one with /new or /attach.'); return; }
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File not downloadable.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, `image-${Date.now()}.jpg`);
    let hasVision = false;
    try { hasVision = await this.deps.ollama.hasVision(session.model ?? this.deps.config.defaultModel); } catch { /* assume no vision */ }
    const plan = attachmentPlan(hasVision, 'image');
    if (plan.warning) await this.send(ctx, plan.warning);
    await this.routeMessageToSession(ctx, `[Image attached: ${path}]`);
  }

  private async onView(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const s = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : undefined;
    if (!s) {
      await this.send(ctx, 'No session selected. Pick one with /sessions.');
      return;
    }
    if (s.kind !== 'terminal') {
      await this.send(ctx, 'This is a headless session — it has no terminal screen. Its replies stream here; send a message to chat. To view a terminal, pick a tmux session with /sessions.');
      return;
    }
    if (!s.tmuxTarget) {
      await this.send(ctx, 'This session is not running in tmux, so there is no pane to capture. Start it with:\n<code>tmux new -s claude:&lt;project&gt;</code>');
      return;
    }
    try {
      const pane = stripAnsi(await this.deps.tmux.capturePane(s.tmuxTarget)).trimEnd();
      await this.send(ctx, `<pre>${htmlEscape(pane)}</pre>`);
    } catch (e) {
      await this.send(ctx, `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
    }
  }

  private async onDocument(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const doc = ctx.message?.document;
    if (!doc) return;
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File not downloadable.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, doc.file_name ?? `doc-${Date.now()}`);
    await this.send(ctx, `📄 File saved: <code>${htmlEscape(path)}</code>`);
    await this.routeMessageToSession(ctx, `[File attached: ${path}]`);
  }

  private subscribeBus(): void {
    const bus = this.deps.bus;
    // constraint 8: da disattivo nessun relay — ogni handler del bus è gated su armed.
    bus.on('session.text', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.sessionId !== this.activeSessionId) return; // solo la sessione selezionata
      this.toolBurst(e.sessionId).close(); // il testo chiude la raffica di tool
      // sia le headless che i transcript delle terminali arrivano come markdown.
      void this.forwardText(e.sessionId, mdToHtml(e.text), e.role);
    });
    bus.on('session.prompt', ({ sessionId, questions }) => {
      if (!this.deps.manager.isArmed()) return;
      if (sessionId !== this.activeSessionId) return;
      this.toolBurst(sessionId).close();
      const blocks = questions.map(q => {
        const title = q.header ? `${q.header}: ${q.question}` : q.question;
        const opts = q.options.map((o, i) => `${i + 1}) ${htmlEscape(o.label)}${o.description ? ` — ${htmlEscape(o.description)}` : ''}`).join('\n');
        return `❓ <b>${htmlEscape(title)}</b>\n${opts}`;
      }).join('\n\n');
      this.notify(`${blocks}\n\nReply with the option number (or its text) to answer.`);
    });
    bus.on('session.tool', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.kind === 'tool_use' && e.sessionId === this.activeSessionId && e.input) {
        const line = `🔧 <code>${htmlEscape(e.toolName)}</code> — <pre>${htmlEscape(JSON.stringify(e.input).slice(0, 300))}</pre>`;
        void this.toolBurst(e.sessionId).push(line);
      }
    });
    bus.on('session.permission', ({ permission }) => {
      if (!this.deps.manager.isArmed()) return;
      this.toolBurst(permission.sessionId).close();
      const kb = new InlineKeyboard()
        .text('✓ Approve', `perm:approve:${permission.id}`)
        .text('✗ Reject', `perm:deny:${permission.id}`);
      if (this.chatId) {
        void this.bot.api.sendMessage(this.chatId, permissionMessage(permission), { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
      }
    });
    bus.on('session.result', e => {
      if (!this.deps.manager.isArmed() || e.sessionId !== this.activeSessionId) return;
      this.toolBurst(e.sessionId).close(); // fine turno headless: chiude la raffica di tool
      // solo segnale di completamento: il testo della risposta è già arrivato
      // streammato (session.text → mdToHtml). Re-inviarlo qui (come faceva la
      // vecchia notifica `✅ <result>`) duplicava l'ultimo messaggio, e senza
      // rendering markdown (htmlEscape soltanto).
      this.notify('✅ Turn complete.');
    });
    bus.on('session.error', e => {
      if (!this.deps.manager.isArmed() || e.sessionId !== this.activeSessionId) return;
      this.toolBurst(e.sessionId).close();
      this.notify(`❌ <b>${htmlEscape(e.message.slice(0, 500))}</b>`);
    });
  }
}
