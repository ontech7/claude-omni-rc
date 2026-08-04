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

export function permissionMessage(req: PermissionRequest): string {
  const input = htmlEscape(JSON.stringify(req.input, null, 2).slice(0, 1000));
  return `🔧 Permesso richiesto — sessione <b>${htmlEscape(req.sessionId.slice(0, 8))}</b>\nTool: <code>${htmlEscape(req.toolName)}</code>\n<pre>${input}</pre>`;
}

export function sessionListText(sessions: Session[], activeId?: string): string {
  if (!sessions.length) return 'Nessuna sessione.';
  return sessions
    .map(s => `${s.id === activeId ? '▸' : ' '} <b>${htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}] ${htmlEscape(s.title)} — ${s.status}`)
    .join('\n');
}

// spec §8: mai inoltrare blocchi immagine a modelli text-only
export function attachmentPlan(
  modelHasVision: boolean,
  kind: 'image' | 'document',
): { attach: boolean; warning?: string } {
  if (kind === 'image' && modelHasVision) return { attach: true };
  if (kind === 'image') return { attach: false, warning: '⚠️ Modello senza vision: inoltro solo il riferimento al file.' };
  return { attach: false };
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

  constructor(private deps: BotDeps) {
    this.bot = new Bot(deps.config.telegramBotToken);
    this.register();
    this.subscribeBus();
  }

  async start(): Promise<void> {
    if (!this.deps.config.telegramBotToken) throw new Error('TELEGRAM_BOT_TOKEN mancante');
    await this.bot.start({ drop_pending_updates: true });
  }
  async stop(): Promise<void> { await this.bot.stop(); }

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
        this.bot.api.editMessageText(chatId, last.messageId, last.text + '\n' + text).then(() => true).catch(() => false));
      if (ok) { last.text += '\n' + text; last.at = now; return; }
    }
    const msg = await this.bot.api.sendMessage(chatId, text).catch(() => undefined);
    if (msg) this.lastMsg.set(sessionId, { messageId: msg.message_id, text, at: now });
  }

  private isAuthorized(ctx: Context): boolean {
    const userId = ctx.from?.id;
    return !!userId && (this.deps.config.allowedUserIds.includes(userId) || this.deps.manager.isAuthorizedUser(userId));
  }

  private authorize(ctx: Context): boolean {
    if (this.isAuthorized(ctx)) { this.chatId = ctx.chat?.id ?? this.chatId; return true; }
    void this.send(ctx, '⛔ Non autorizzato. Inviami <code>/start &lt;codice di pairing&gt;</code>.');
    return false;
  }

  private register(): void {
    const bot = this.bot;
    bot.command('start', ctx => this.onStart(ctx));
    bot.command('help', ctx => { if (this.authorize(ctx)) this.send(ctx, 'Comandi: /rc on|off|status · /sessions · /new &lt;testo&gt; · /stop · /status · /attach &lt;progetto&gt; · /help'); });
    bot.command('rc', ctx => this.onRc(ctx));
    bot.command('sessions', ctx => this.onSessions(ctx));
    bot.command('new', ctx => this.onNew(ctx));
    bot.command('stop', ctx => this.onStop(ctx));
    bot.command('status', ctx => this.onStatus(ctx));
    bot.command('attach', ctx => this.onAttach(ctx));
    bot.on('callback_query:data', ctx => this.onCallback(ctx));
    bot.on('message:text', ctx => this.onMessage(ctx));
    bot.on('message:photo', ctx => this.onPhoto(ctx));
    bot.on('message:voice', ctx => this.onVoice(ctx));
    bot.on('message:document', ctx => this.onDocument(ctx));
  }

  private async onStart(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (this.isAuthorized(ctx)) {
      this.chatId = ctx.chat?.id;
      await this.send(ctx, `👋 Benvenuto! Stato: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disattivato'}. Usa /help.`);
      return;
    }
    const code = ctx.match?.toString().trim() ?? '';
    if (this.deps.config.pairingCode && code === this.deps.config.pairingCode) {
      this.deps.manager.addAuthorizedUser(userId);
      this.deps.manager.persist();
      this.chatId = ctx.chat?.id;
      await this.send(ctx, '✅ Pairing riuscito. Usa /help.');
    } else {
      await this.send(ctx, '⛔ Non autorizzato. Inviami <code>/start &lt;codice di pairing&gt;</code>.');
    }
  }

  private async onRc(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    const arg = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (arg === 'on') {
      this.deps.manager.setArmed(true); this.deps.manager.persist();
      await this.send(ctx, '🔓 Remote control ARMATO.');
    } else if (arg === 'off') {
      this.deps.manager.setArmed(false);
      for (const s of this.deps.manager.list()) this.deps.permissionFlow.cancelAllForSession(s.id);
      this.deps.manager.persist();
      await this.send(ctx, '🔒 Remote control DISATTIVATO. Nessun mirror, iniezione o relay.');
    } else if (arg === 'status') {
      await this.send(ctx, `Interruttore: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disattivato'}`);
    } else {
      await this.send(ctx, 'Uso: /rc on | /rc off | /rc status');
    }
  }

  private requireArmed(ctx: Context): boolean {
    if (!this.deps.manager.isArmed()) { void this.send(ctx, '🔒 Remote control disattivato. Usa /rc on.'); return false; }
    return true;
  }

  private async onSessions(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const kb = new InlineKeyboard();
    for (const s of this.deps.manager.list()) kb.text(s.id.slice(0, 6), `sess:select:${s.id}`);
    await ctx.reply(sessionListText(this.deps.manager.list(), this.activeSessionId), {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }

  private async onNew(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const text = ctx.match?.toString().trim() ?? '';
    if (!text) { await this.send(ctx, 'Uso: /new &lt;testo&gt;'); return; }
    const running = this.deps.manager.list().filter(s => s.kind === 'headless' && s.status === 'running').length;
    if (running >= this.deps.config.maxHeadlessSessions) { await this.send(ctx, `Limite di ${this.deps.config.maxHeadlessSessions} sessioni headless attive raggiunto.`); return; }
    const projectDir = this.deps.config.workspaceDirs[0] ?? homedir();
    const session = this.deps.manager.createHeadless({
      title: text.slice(0, 40), projectDir, model: this.deps.config.defaultModel,
    });
    this.activeSessionId = session.id;
    this.deps.manager.persist();
    await this.send(ctx, `🆕 Sessione <b>${htmlEscape(session.id.slice(0, 8))}</b> avviata.`);
    // NON await: grammy processa gli update in sequenza — aspettare un turno di minuti
    // bloccherebbe /stop, /rc off e i callback. Il driver emette gli eventi sul bus.
    void this.deps.sdk.runTurn(session.id, text);
  }

  private async onStop(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    if (this.activeSessionId) this.deps.permissionFlow.cancelAllForSession(this.activeSessionId);
    await this.send(ctx, '🛑 Fermata richiesta per la sessione attiva.');
  }

  private async onStatus(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const s = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : undefined;
    await this.send(ctx, s
      ? `Sessione attiva: <b>${s.id.slice(0, 8)}</b> [${s.kind}] — ${s.status}`
      : 'Nessuna sessione attiva. Crea con /new.');
  }

  private async onAttach(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const name = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (!name) { await this.send(ctx, 'Uso: /attach &lt;progetto&gt;'); return; }
    const projectDir = this.resolveProjectDir(name);
    if (!projectDir) { await this.send(ctx, `Progetto "${name}" non trovato nei workspace.`); return; }
    const session = this.deps.manager.registerTerminal({ title: name, projectDir, tmuxTarget: `claude:${name}` });
    this.activeSessionId = session.id;
    this.deps.manager.persist();
    await this.send(ctx, `📎 Sessione terminale <b>${htmlEscape(session.id.slice(0, 8))}</b> collegata a <code>claude:${htmlEscape(name)}</code>.`);
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
    if (!this.deps.manager.isArmed()) { await ctx.answerCallbackQuery({ text: '🔒 Remote control disattivato' }); return; }
    const data = ctx.callbackQuery?.data ?? '';
    try {
      const { action, id } = parseCallbackData(data);
      if (action === 'approve') {
        const ok = this.deps.permissionFlow.approve(id);
        await ctx.answerCallbackQuery({ text: ok ? '✓ Approvato' : 'Già risolto' });
      } else if (action === 'deny') {
        const ok = this.deps.permissionFlow.deny(id);
        await ctx.answerCallbackQuery({ text: ok ? '✗ Rifiutato' : 'Già risolto' });
      } else {
        const s = this.deps.manager.get(id);
        if (s) this.activeSessionId = s.id;
        await ctx.answerCallbackQuery({ text: 'Sessione selezionata' });
        await ctx.editMessageText(sessionListText(this.deps.manager.list(), this.activeSessionId), { parse_mode: 'HTML' });
      }
    } catch {
      await ctx.answerCallbackQuery({ text: 'Dato non valido' });
    }
  }

  private async routeMessageToSession(ctx: Context, text: string): Promise<void> {
    const session = this.activeSessionId ? this.deps.manager.get(this.activeSessionId) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'Nessuna sessione. Crea con /new o /attach.'); return; }
    if (session.kind === 'headless') {
      if (this.deps.sdk.isBusy(session.id)) {
        await this.send(ctx, '⏳ Sessione occupata: aspetta che diventi idle prima di inoltrare.');
        return;
      }
      void this.deps.sdk.runTurn(session.id, text); // non bloccante (vedi onNew)
    } else {
      if (!this.deps.manager.isIdle(session.id)) {
        await this.send(ctx, '⏳ Sessione occupata: aspetta che diventi idle prima di iniettare.');
        return;
      }
      await this.deps.tmux.injectText(session.tmuxTarget!, text);
    }
  }

  private async onMessage(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    if (!ctx.message) return;
    // grammy 1.45: `text` è `text?: string` anche su message:text — la guardia non lo
    // restringe; `?? ''` è sicuro perché il filtro message:text scatta solo su testi.
    const text = ctx.message.text ?? '';
    if (text.startsWith('/')) return; // gestiti dai comandi
    if (!this.deps.manager.isArmed()) { await this.send(ctx, '🔒 Remote control disattivato. Usa /rc on.'); return; }
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
    if (!session) { await this.send(ctx, 'Nessuna sessione. Crea con /new o /attach.'); return; }
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File non scaricabile.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, `image-${Date.now()}.jpg`);
    let hasVision = false;
    try { hasVision = await this.deps.ollama.hasVision(session.model ?? this.deps.config.defaultModel); } catch { /* assume no vision */ }
    const plan = attachmentPlan(hasVision, 'image');
    if (plan.warning) await this.send(ctx, plan.warning);
    await this.routeMessageToSession(ctx, `[Immagine allegata: ${path}]`);
  }

  private async onVoice(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    if (!ctx.message?.voice) return;
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File non scaricabile.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, `voice-${Date.now()}.ogg`);
    await this.send(ctx, '🎙️ Trascrizione in corso…');
    try {
      const text = await this.deps.inbox.voiceToText(path);
      if (!text.trim()) { await this.send(ctx, 'Trascrizione vuota.'); return; }
      await this.routeMessageToSession(ctx, text);
    } catch (e) {
      await this.send(ctx, `❌ Trascrizione fallita: ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
    }
  }

  private async onDocument(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const doc = ctx.message?.document;
    if (!doc) return;
    const file = await ctx.getFile();
    if (!file.file_path) { await this.send(ctx, 'File non scaricabile.'); return; }
    const buf = await this.downloadTelegramFile(file.file_path);
    const path = await this.deps.inbox.saveAttachment(buf, doc.file_name ?? `doc-${Date.now()}`);
    await this.send(ctx, `📄 File salvato: <code>${htmlEscape(path)}</code>`);
    await this.routeMessageToSession(ctx, `[File allegato: ${path}]`);
  }

  private subscribeBus(): void {
    const bus = this.deps.bus;
    // constraint 8: da disattivo nessun relay — ogni handler del bus è gated su armed.
    bus.on('session.text', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.role === 'assistant') void this.forwardText(e.sessionId, e.text);
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
