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
import type { Session, PermissionRequest } from '../src/types.js';

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

export function parseCallbackData(data: string): { action: 'approve' | 'deny' | 'select'; id: string } {
  const parts = data.split(':');
  if (parts.length === 3) {
    const [ns, action, id] = parts;
    if (ns === 'perm' && (action === 'approve' || action === 'deny') && id) return { action, id };
    if (ns === 'sess' && action === 'select' && id) return { action: 'select', id };
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

// Righe di `cur` dopo il prefisso comune con `prev` (diff per linee, spazi finali
// ignorati perché il terminale riempie le righe a larghezza fissa).
export function diffTail(prev: string, cur: string): string {
  const a = prev.split('\n').map(l => l.replace(/\s+$/, ''));
  const b = cur.split('\n').map(l => l.replace(/\s+$/, ''));
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return b.slice(i).join('\n').replace(/\n+$/, '');
}

// Render minimale markdown → HTML per il testo delle sessioni headless.
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

export function sessionListText(sessions: Session[], activeId?: string): string {
  if (!sessions.length) return 'No sessions.';
  return sessions
    .map(s => `${s.id === activeId ? '▸' : ' '} <b>${htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}] ${htmlEscape(s.title)} — ${s.status}`)
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
  private lastMsg = new Map<string, { messageId: number; text: string; at: number }>();
  private paneTimer?: NodeJS.Timeout;
  private lastPane = new Map<string, string>();

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
    this.paneTimer = setInterval(() => void this.streamActivePane(), this.deps.config.paneRefreshMs);
    this.paneTimer.unref();
  }
  async stop(): Promise<void> {
    if (this.paneTimer) clearInterval(this.paneTimer);
    await this.bot.stop();
  }

  private send(ctx: Context, text: string): Promise<unknown> {
    return ctx.reply(text, { parse_mode: 'HTML' });
  }
  private notify(text: string): void {
    if (this.chatId) void this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'HTML' }).catch(() => {});
  }
  private async forwardText(sessionId: string, text: string): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;
    const last = this.lastMsg.get(sessionId);
    const now = Date.now();
    if (last && now - last.at < 10_000) {
      const ok = await this.throttler.throttled(() =>
        this.bot.api.editMessageText(chatId, last.messageId, last.text + '\n' + text, { parse_mode: 'HTML' }).then(() => true).catch(() => false));
      if (ok) { last.text += '\n' + text; last.at = now; return; }
    }
    const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => undefined);
    if (msg) this.lastMsg.set(sessionId, { messageId: msg.message_id, text, at: now });
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
    if (!s || s.kind !== 'terminal' || !s.tmuxTarget) {
      await this.send(ctx, 'No tmux session selected. Pick one with /sessions, or /attach &lt;project&gt;.');
      return;
    }
    try {
      const pane = stripAnsi(await this.deps.tmux.capturePane(s.tmuxTarget)).trimEnd();
      this.lastPane.set(s.tmuxTarget, pane);
      await this.send(ctx, `<pre>${htmlEscape(pane)}</pre>`);
    } catch (e) {
      await this.send(ctx, `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
    }
  }

  // Streaming del pane tmux della sessione ATTIVA: mostra lo schermo reale
  // (markdown reso dal terminale, UI interattiva inclusa) e inoltra solo le righe
  // nuove rispetto all'ultima cattura. La prima cattura è la baseline (niente flood).
  private async streamActivePane(): Promise<void> {
    if (!this.deps.manager.isArmed()) return;
    const s = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : undefined;
    if (!s || s.kind !== 'terminal' || !s.tmuxTarget) return;
    let cur: string;
    try { cur = stripAnsi(await this.deps.tmux.capturePane(s.tmuxTarget)); } catch { return; }
    const prev = this.lastPane.get(s.tmuxTarget);
    this.lastPane.set(s.tmuxTarget, cur);
    if (prev === undefined) return;
    const lines = diffTail(prev, cur);
    if (!lines) return;
    await this.forwardText(s.id, lines.slice(-3500)); // sotto il limite dei 4096 di Telegram
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
      if (e.role !== 'assistant') return;
      if (e.sessionId !== this.activeSessionId) return; // solo la sessione selezionata
      const s = this.deps.manager.get(e.sessionId);
      const text = s?.kind === 'headless' ? mdToHtml(e.text) : htmlEscape(e.text);
      void this.forwardText(e.sessionId, text);
    });
    bus.on('session.tool', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.kind === 'tool_use' && e.sessionId === this.activeSessionId && e.input) {
        this.notify(`🔧 <code>${htmlEscape(e.toolName)}</code> — <pre>${htmlEscape(JSON.stringify(e.input).slice(0, 300))}</pre>`);
      }
    });
    bus.on('session.permission', ({ permission }) => {
      if (!this.deps.manager.isArmed()) return;
      const kb = new InlineKeyboard()
        .text('✓ Approva', `perm:approve:${permission.id}`)
        .text('✗ Rifiuta', `perm:deny:${permission.id}`);
      if (this.chatId) {
        void this.bot.api.sendMessage(this.chatId, permissionMessage(permission), { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
      }
    });
    bus.on('session.result', e => { if (this.deps.manager.isArmed() && e.sessionId === this.activeSessionId) this.notify(`✅ ${htmlEscape(e.result.slice(0, 500))}`); });
    bus.on('session.error', e => { if (this.deps.manager.isArmed() && e.sessionId === this.activeSessionId) this.notify(`❌ <b>${htmlEscape(e.message.slice(0, 500))}</b>`); });
  }
}
