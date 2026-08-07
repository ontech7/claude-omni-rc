import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Bus } from '../src/bus.js';
import type { Config } from '../src/config.js';
import type { SessionManager } from '../src/sessions/manager.js';
import type { PermissionFlow } from '../src/permissions.js';
import type { DialogFlow } from '../src/dialogs.js';
import type { SdkDriver } from '../src/sessions/sdk-driver.js';
import type { TmuxClient } from '../src/sessions/tmux-inject.js';
import type { OllamaClient } from '../src/ollama.js';
import type { Inbox } from '../src/input.js';
import type { Session, PermissionRequest, PromptQuestion, PromptAnswer, UserDialog } from '../src/types.js';
import type { RecentMessage } from '../src/sessions/transcript.js';
import { readRecentMessages, resolveSessionTranscript } from '../src/sessions/transcript.js';

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

// Flag in testa di /new, in qualsiasi ordine: --auto/--standard (permessi) e
// --model <name> (modello per questa sessione, default da DEFAULT_MODEL).
// `mode` resta undefined se nessun flag è presente: il default lo decide la
// config (DEFAULT_PERMISSION_MODE), non il parser.
export function parseNewFlags(raw: string): { mode?: 'auto' | 'standard'; model?: string; text: string } {
  let mode: 'auto' | 'standard' | undefined;
  let model: string | undefined;
  let text = raw.trim();
  for (;;) {
    const modeFlag = text.match(/^--(auto|standard)(?:\s+|$)/);
    if (modeFlag) {
      mode = modeFlag[1] === 'standard' ? 'standard' : 'auto';
      text = text.slice(modeFlag[0].length).trim();
      continue;
    }
    const modelFlag = text.match(/^--model\s+(\S+)(?:\s+|$)/);
    if (modelFlag) {
      model = modelFlag[1];
      text = text.slice(modelFlag[0].length).trim();
      continue;
    }
    break;
  }
  return { ...(mode ? { mode } : {}), ...(model ? { model } : {}), text };
}

// Dove gira una sessione headless. Senza WORKSPACE_DIRS il vecchio fallback era
// la home: un agente con accesso a Bash radicato su TUTTI i file dell'utente.
// Meglio rifiutare e chiedere una configurazione esplicita.
export function resolveHeadlessProjectDir(workspaceDirs: string[]): { dir?: string; error?: string } {
  const dir = workspaceDirs[0];
  if (!dir) {
    return { error: 'No workspace configured. Set <code>WORKSPACE_DIRS</code> in .env to the project roots headless sessions may run in, then restart the daemon.' };
  }
  return { dir };
}

export interface CallbackData {
  action: 'approve' | 'deny' | 'select' | 'answer' | 'done' | 'other' | 'cancel' | 'del' | 'del-yes' | 'del-no'
    | 'perm-edit' | 'dlg-retry' | 'dlg-skip';
  id: string;
  index?: number;        // per 'answer': indice opzione
  questionIndex?: number; // per 'answer'/'done'/'other': indice domanda
}

export function parseCallbackData(data: string): CallbackData {
  const parts = data.split(':');
  if (parts.length === 3) {
    const [ns, action, id] = parts;
    if (ns === 'perm' && (action === 'approve' || action === 'deny') && id) return { action, id };
    if (ns === 'perm' && action === 'edit' && id) return { action: 'perm-edit', id };
    if (ns === 'sess' && action === 'select' && id) return { action: 'select', id };
    if (ns === 'sess' && action === 'del' && id) return { action: 'del', id };
    if (ns === 'sess' && (action === 'del-yes' || action === 'del-no') && id) return { action, id };
    if (ns === 'dlg' && (action === 'retry' || action === 'skip') && id) {
      return { action: `dlg-${action}` as CallbackData['action'], id };
    }
  }
  if (parts.length === 4) {
    const [ns, action, token, q] = parts;
    if (ns === 'q' && (action === 'done' || action === 'other' || action === 'cancel') && token && /^\d+$/.test(q)) {
      return { action, id: token, questionIndex: Number(q) };
    }
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

// Rende il markdown del modello in HTML per Telegram, correggendo il markup:
// blocchi di codice protetti (niente formattazione dentro <pre>/<code>), nesting
// grassetto/corsivo gestito, e passata finale di bilanciamento → l'output è
// sempre HTML valido accettato da Telegram (mai un messaggio scartato).
export function mdToHtml(text: string): string {
  const blocks: string[] = [];
  // Separatore per i placeholder del codice: un NUL non compare mai nel testo
  // del modello, quindi il ripristino non può corrompere il contenuto.
  const P = String.fromCharCode(0);
  const protect = (c: string, kind: 'pre' | 'code'): string => {
    const idx = blocks.length;
    blocks.push(kind === 'pre' ? `<pre>${c}</pre>` : `<code>${c}</code>`);
    return `${P}${idx}${P}`;
  };
  let out = htmlEscape(text);
  out = out.replace(/```([\s\S]*?)```/g, (_m, c) => protect(c, 'pre'));
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => protect(c, 'code'));
  out = out
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>');
  out = out.replace(/^#{1,6}\s+([^<]+)$/gm, '<b>$1</b>');
  out = out.replace(/^[-*]\s+(.+)$/gm, '• $1');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(new RegExp(`${P}([0-9]+)${P}`, 'g'), (_m, i) => blocks[Number(i)]);
  return balanceHtml(out);
}

// Chiude i tag ancora aperti a fine stringa (LIFO) e scarta le chiusure orfane:
// il risultato è sempre HTML bilanciato. Garanzia che Telegram non rigetti mai
// un messaggio per markup malformato.
export function balanceHtml(html: string): string {
  const stack: string[] = [];
  let out = '';
  let last = 0;
  const re = /<\/?(b|i|code|pre|a)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out += html.slice(last, m.index);
    const full = m[0];
    const tag = m[1];
    if (full.startsWith('</')) {
      const idx = stack.lastIndexOf(tag);
      if (idx !== -1) {
        for (let i = stack.length - 1; i > idx; i--) out += `</${stack[i]}>`;
        out += `</${tag}>`;
        stack.length = idx;
      }
      // chiusura orfana: scartata
    } else {
      out += full;
      stack.push(tag);
    }
    last = m.index + full.length;
  }
  out += html.slice(last);
  for (let i = stack.length - 1; i >= 0; i--) out += `</${stack[i]}>`;
  return out;
}

// Telegram rifiuta un messaggio oltre 4096 caratteri: il send è dentro un
// .catch() → una risposta lunga del modello sparirebbe in silenzio. Il testo
// viene quindi spezzato in più messaggi, preferendo un confine di riga e
// riaprendo in ogni pezzo i tag rimasti aperti (così ogni chunk è HTML valido
// e la formattazione non si perde a metà blocco di codice).
// Il limite duro è 4096: si sta sotto con margine, perché i tag riaperti a
// inizio chunk e l'escaping HTML aggiungono caratteri.
export const SEND_MAX_CHARS = 3800;
const HTML_TAG = /<\/?(b|i|code|pre|a)(?:\s[^>]*)?>/g;

export function splitHtmlMessage(html: string, max = SEND_MAX_CHARS): string[] {
  if (html.length <= max) return [html];

  // tokenizza in tag e testo: un tag non va mai spezzato a metà
  const tokens: { tag?: string; text?: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  HTML_TAG.lastIndex = 0;
  while ((m = HTML_TAG.exec(html)) !== null) {
    if (m.index > last) tokens.push({ text: html.slice(last, m.index) });
    tokens.push({ tag: m[0] });
    last = m.index + m[0].length;
  }
  if (last < html.length) tokens.push({ text: html.slice(last) });

  const chunks: string[] = [];
  const stack: { name: string; open: string }[] = [];
  const openers = (): string => stack.map(t => t.open).join('');
  const closers = (): string => stack.map(t => `</${t.name}>`).reverse().join('');
  let cur = '';
  const flush = (): void => {
    const reopened = openers();
    if (cur !== reopened) chunks.push(cur + closers());
    cur = reopened;
  };

  for (const t of tokens) {
    if (t.tag !== undefined) {
      const name = /^<\/?([a-z]+)/.exec(t.tag)![1];
      if (cur.length + t.tag.length + closers().length > max) flush();
      cur += t.tag;
      if (t.tag.startsWith('</')) {
        const i = stack.map(s => s.name).lastIndexOf(name);
        if (i !== -1) stack.splice(i, 1);
      } else {
        stack.push({ name, open: t.tag });
      }
      continue;
    }
    let text = t.text ?? '';
    while (text) {
      let budget = max - cur.length - closers().length;
      if (budget <= 0) {
        // il chunk corrente è pieno: chiudilo. Se anche così non c'è spazio
        // (max troppo piccolo per i soli tag) si avanza di 1 char per non
        // restare in loop.
        if (cur !== openers()) { flush(); continue; }
        budget = 1;
      }
      if (text.length <= budget) { cur += text; break; }
      const slice = text.slice(0, budget);
      let cut = slice.lastIndexOf('\n');
      if (cut < budget * 0.5) cut = slice.lastIndexOf(' ');
      if (cut < budget * 0.5) cut = budget; // nessun confine utile: taglio netto
      cur += text.slice(0, cut);
      text = text.slice(cut).replace(/^[ \n]/, '');
      flush();
    }
  }
  flush();
  return chunks;
}

// Il controllo remoto vive SOLO in chat privata: in un gruppo il daemon
// streammerebbe codice, output dei tool e path davanti a membri non autorizzati
// (l'autorizzazione è per utente, la destinazione delle notifiche è la chat).
export function isPrivateChat(chat: { type?: string } | undefined): boolean {
  return chat?.type === 'private';
}

export function permissionMessage(req: PermissionRequest): string {
  // ExitPlanMode: il "permesso" è l'approvazione del piano — mostra il piano
  // (non il JSON troncato) e i bottoni Approve/Reject/Edit.
  if (req.toolName === 'ExitPlanMode') {
    const plan = typeof req.input.plan === 'string' ? req.input.plan : '';
    const body = plan ? truncateAtWord(plan, 2000) : '<i>(no plan text in input)</i>';
    return `📋 <b>Plan approval</b> — session <b>${htmlEscape(req.sessionId.slice(0, 8))}</b>\n<pre>${htmlEscape(body)}</pre>`;
  }
  const input = htmlEscape(JSON.stringify(req.input, null, 2).slice(0, 1000));
  return `🔧 Permission requested — session <b>${htmlEscape(req.sessionId.slice(0, 8))}</b>\nTool: <code>${htmlEscape(req.toolName)}</code>\n<pre>${input}</pre>`;
}

// Bottoni per una richiesta di permesso: Approve/Reject, più Edit per ExitPlanMode.
export function permissionKeyboard(req: PermissionRequest): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('✓ Approve', `perm:approve:${req.id}`)
    .text('✗ Reject', `perm:deny:${req.id}`);
  if (req.toolName === 'ExitPlanMode') kb.text('✏️ Edit', `perm:edit:${req.id}`).row();
  return kb;
}

// ---------- dialoghi bloccanti (request_user_dialog) ----------

// Messaggio Telegram per un dialogo bloccante. L'unico kind che il CLI emette
// davvero via request_user_dialog è refusal_fallback_prompt (l'approvazione del
// piano passa da canUseTool/ExitPlanMode, non da qui). I kind sconosciuti
// vengono comunque mostrati (con un bottone Cancel) invece di essere ignorati:
// un dialogo ignorato parcheggia il turno e blocca l'utente.
export function dialogMessage(dialog: UserDialog, session?: Session): string {
  const who = session ? `<b>${htmlEscape(session.title)}</b>` : `<code>${htmlEscape(dialog.id.slice(0, 8))}</code>`;
  if (dialog.dialogKind === 'refusal_fallback_prompt') {
    const model = typeof dialog.payload.fallbackModel === 'string' ? dialog.payload.fallbackModel
      : typeof dialog.payload.fallback_model === 'string' ? dialog.payload.fallback_model
      : typeof dialog.payload.model === 'string' ? dialog.payload.model : undefined;
    const reason = typeof dialog.payload.guidanceText === 'string' ? dialog.payload.guidanceText
      : typeof dialog.payload.reason === 'string' ? dialog.payload.reason : undefined;
    const why = reason ? `\n<i>${htmlEscape(reason.slice(0, 300))}</i>` : '';
    return `❌ <b>Model refused</b> — ${who}${model ? `\nRetry with <code>${htmlEscape(model)}</code>?` : '\nRetry?'}${why}`;
  }
  return `❓ <b>Dialog</b> <code>${htmlEscape(dialog.dialogKind)}</code> — ${who}`;
}

// Bottoni per un dialogo: refusal → Retry/Skip; sconosciuto → solo Cancel (il
// default del CLI è comunque applicato).
export function dialogKeyboard(dialog: UserDialog): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (dialog.dialogKind === 'refusal_fallback_prompt') {
    kb.text('🔄 Retry', `dlg:retry:${dialog.id}`).row();
    kb.text('Skip', `dlg:skip:${dialog.id}`).row();
  } else {
    kb.text('Cancel', `dlg:skip:${dialog.id}`).row();
  }
  return kb;
}

// Intestazione della domanda a scelta multipla: elenco numerato completo delle
// opzioni (mai troncato) — il reply col numero resta sempre valido.
export function promptMessage(questions: PromptQuestion[]): string {
  return questions
    .map(q => {
      const title = q.header ? `${q.header}: ${q.question}` : q.question;
      const opts = q.options
        .map((o, i) => `  ${i + 1}. ${htmlEscape(o.label)}${o.description ? ` — <i>${htmlEscape(o.description)}</i>` : ''}`)
        .join('\n');
      return `❓ <b>${htmlEscape(title)}</b>\n${opts}`;
    })
    .join('\n\n');
}

export interface PromptOption { label: string; callback: string }

// Layout dei bottoni per le domande: etichetta corta come scorciatoia sopra
// l'elenco numerato completo. Sopra il cap di opzioni niente bottoni: il reply
// col numero resta il fallback. I label dei bottoni sono testo semplice (il
// parse_mode HTML non si applica ai bottoni inline di Telegram).
export function promptLayout(questions: PromptQuestion[], token: string, maxButtons = 12): { options: PromptOption[]; hint: string } {
  const all = questions.flatMap((q, qi) =>
    q.options.map((o, oi) => ({
      label: o.label.length > 40 ? `${o.label.slice(0, 40).trimEnd()}…` : o.label,
      callback: `q:answer:${token}:${qi}:${oi}`,
    })));
  const useButtons = all.length > 0 && all.length <= maxButtons;
  return {
    options: useButtons ? all : [],
    hint: useButtons
      ? '\n\n<i>Tap an option or reply with its number.</i>'
      : '\n\n<i>Reply with the number of an option.</i>',
  };
}

// ---------- flusso domande multiple (AskUserQuestion) ----------

// Macchina a stati per le domande del CLI: accoda i set (ogni `session.prompt`
// = una chiamata AskUserQuestion), mostra UNA domanda alla volta e raccoglie le
// risposte. Un set è completo quando tutte le sue domande hanno una risposta; a
// quel punto le risposte vengono consegnate (iniezione tmux per le terminali,
// un messaggio unico via runTurn per le headless) e si passa al set successivo.
export interface QuestionFlow {
  sessionId: string;
  sets: PromptQuestion[][];   // coda dei set
  setIndex: number;           // set corrente
  qIndex: number;             // domanda corrente nel set
  answers: (PromptAnswer | undefined)[][];  // risposte per set, per domanda (undefined = non risposta)
  token: string;              // token callback
  messageId?: number;         // messaggio Telegram della domanda corrente
  chatId?: number;
  multiSel: number[];         // opzioni togglate per la multi-select corrente
  awaitingOther?: { setIndex: number; qIndex: number };  // in attesa di testo libero
}

// Riepilogo leggibile di una risposta (per l'acknowledgment e la consegna).
export function answerSummary(a: PromptAnswer): string {
  return a.kind === 'option' ? a.labels.join(', ') : a.text;
}

// Testo da iniettare nel pane tmux per rispondere a una domanda: il numero
// dell'opzione (1-based) per le opzioni, i numeri separati da virgola per la
// multi-select, il testo libero per "Other". Il menu del CLI mostra i numeri.
export function answerToInjection(q: PromptQuestion, a: PromptAnswer): string {
  if (a.kind === 'other') return a.text;
  const nums = a.labels
    .map(label => q.options.findIndex(o => o.label === label) + 1)
    .filter(n => n > 0);
  return nums.join(', ');
}

// Messaggio unico con tutte le risposte di un set, per le sessioni headless.
export function answersToMessage(questions: PromptQuestion[], answers: (PromptAnswer | undefined)[]): string {
  const lines = answers.map((a, i) => {
    const q = questions[i];
    const title = q.header ? `${q.header}: ${q.question}` : q.question;
    return `${i + 1}. ${title} → ${a ? answerSummary(a) : '(no answer)'}`;
  });
  return `Answers to your questions:\n${lines.join('\n')}`;
}

// Reply numerico dell'utente come fallback ai bottoni: "2" → [2], "1, 3" → [1,3].
// undefined se il testo non è una lista di numeri positivi.
export function parseNumericReply(text: string): number[] | undefined {
  const t = text.trim();
  if (!/^[\d,\s]+$/.test(t)) return undefined;
  const nums = t.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return nums.length ? nums : undefined;
}

// Matcher per il Fix 1: sopprime l'echo di un testo che il bot ha appena
// iniettato nel pane (l'utente lo vede già). Confronto trim, finestra 60s.
export function matchesInjected(recent: { text: string; at: number }[], text: string, now: number, windowMs = 60_000): boolean {
  const t = text.trim();
  return recent.some(item => now - item.at <= windowMs && item.text.trim() === t);
}

// Blocco di storia (Fix 5): gli ultimi messaggi renderizzati come chat. Il cap è
// per messaggi INTERI — i più vecchi vengono scartati, mai un messaggio spezzato;
// un singolo messaggio più lungo del cap viene troncato a fine parola.
export function renderHistory(messages: RecentMessage[], title: string, maxChars = 3800): string {
  const header = `<b>Last messages · ${htmlEscape(title)}</b>`;
  let remaining = maxChars - header.length - 2;
  const body: string[] = [];
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const m = messages[i];
    const line = `${m.role === 'user' ? '🧑' : '🤖'} ${mdToHtml(m.text)}`;
    const sep = body.length ? 2 : 0;
    if (line.length + sep > remaining) {
      body.push(truncateAtWord(line, Math.max(remaining - sep, 1)));
      break;
    }
    body.push(line);
    remaining -= line.length + sep;
  }
  return balanceHtml(`${header}\n\n${body.reverse().join('\n\n')}`);
}

// Tronca preferendo un confine di parola (se cade oltre metà del budget): mai
// tagli a metà stringa, con un marcatore esplicito di troncamento.
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  const end = sp > max * 0.5 ? sp : max;
  return s.slice(0, end).trimEnd() + '… (truncated)';
}

// Risposta di /stop basata sull'esito reale (spec §3.3): mai un generico
// "Stop requested" quando non c'è nulla da fermare.
export function stopReply(o: {
  kind: 'headless' | 'terminal';
  id8: string;
  aborted?: boolean;
  status?: string;
  target?: string;
}): string {
  if (o.kind === 'headless') {
    return o.aborted
      ? `🛑 Turn aborted for session <b>${htmlEscape(o.id8)}</b>.`
      : `No turn is running for session <b>${htmlEscape(o.id8)}</b> (status: ${htmlEscape(o.status ?? 'unknown')}).`;
  }
  return o.target
    ? `🛑 Ctrl+C sent to <code>${htmlEscape(o.target)}</code> — generation interrupted.`
    : 'This terminal session has no tmux pane to interrupt.';
}

// Riassunto leggibile di una tool call (niente JSON grezzo): l'ingranaggio ⚙️
// identifica la riga come tool call, seguito dal campo chiave dell'input
// (fallback al nome + primo valore). È il fallback quando la summary via LLM
// non è disponibile (Ollama lento/giù).
export function summarizeTool(toolName: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  const first = (): string => {
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
  };
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = s(input[k]);
      if (v.trim()) return v;
    }
    return first();
  };
  const trunc = (v: string, max = 80): string => (v.length > max ? `${v.slice(0, max).trimEnd()}…` : v);

  const name = toolName.toLowerCase();
  if (name === 'bash') return `⚙️ ${trunc(pick('command'))}`;
  if (name === 'read' || name === 'readfile') return `⚙️ ${trunc(pick('file_path', 'path'))}`;
  if (name === 'write' || name === 'writefile') return `⚙️ ${trunc(pick('file_path', 'path'))}`;
  if (name === 'edit') return `⚙️ ${trunc(pick('file_path', 'path'))}`;
  if (name === 'glob' || name === 'grep') return `⚙️ ${trunc(pick('pattern', 'query'))}`;
  if (name === 'webfetch') return `⚙️ ${trunc(pick('url'))}`;
  if (name === 'websearch') return `⚙️ ${trunc(pick('query'))}`;
  if (name === 'taskcreate' || name === 'taskupdate') return `⚙️ ${trunc(pick('subject'))}`;
  const v = first();
  return v ? `⚙️ ${toolName} — ${trunc(v)}` : `⚙️ ${toolName}`;
}

// Testo breve del modello mentre una bubble tool è aperta → si fonde nella
// bubble (niente messaggio extra); testo lungo (una risposta vera) o nessuna
// bubble aperta → messaggio separato. Soglia: la narrazione tra le tool call è
// di 1-2 frasi, le risposte vere sono più lunghe.
export const NARRATION_MAX = 150;
export function narrationPlan(role: 'user' | 'assistant', text: string, burstOpen: boolean): 'merge' | 'separate' {
  if (role === 'assistant' && burstOpen && text.length < NARRATION_MAX) return 'merge';
  return 'separate';
}

// Indicatore "sta scrivendo…" di Telegram: la bolla del chat action dura ~5s,
// quindi va rinnovata. start() invia subito e poi a intervalli; stop() ferma.
export class TypingIndicator {
  private timer?: NodeJS.Timeout;
  private cutoff?: NodeJS.Timeout;

  constructor(private send: () => Promise<unknown>, private intervalMs = 4000, private maxMs = 15 * 60_000) {}

  start(): void {
    if (!this.timer) {
      void this.send().catch(() => {});
      this.timer = setInterval(() => void this.send().catch(() => {}), this.intervalMs);
      this.timer.unref?.();
    }
    // Safety ceiling, re-armed on every start: a long but active turn (continuous
    // tool_use events) keeps resetting it, so only a wedged state with no further
    // events reaches the limit and "sta scrivendo…" auto-stops instead of hanging.
    if (this.cutoff) clearTimeout(this.cutoff);
    this.cutoff = setTimeout(() => this.stop(), this.maxMs);
    this.cutoff.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (this.cutoff) { clearTimeout(this.cutoff); this.cutoff = undefined; }
  }
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
  // Contatore di generazione: `close()` lo incrementa. Una pushNow in volo
  // (await sul sink) cattura la generazione all'inizio e la ri-verifica dopo
  // l'await: se close() è scattato nel frattempo, non riapre la bubble chiusa.
  private generation = 0;

  constructor(private sink: ToolBurstSink, private maxLen = 3800, private windowMs = 5000) {}

  // Serializza le push: il bus emette in modo sincrono e due tool_use nello stesso
  // tick leggerebbero open/lastWasTool prima di ogni await — la catena rende le
  // mutazioni atomiche rispetto alle push concorrenti. La generazione viene
  // catturata QUI (non in pushNow): se close() scatta tra push() e l'avvio di
  // pushNow(), la push sa di appartenere alla generazione precedente e non
  // riapre la bubble chiusa.
  push(line: string): Promise<void> {
    const gen = this.generation;
    this.chain = this.chain.then(() => this.pushNow(line, gen)).catch(() => { /* la catena sopravvive a un errore inatteso del sink */ });
    return this.chain;
  }

  // La bubble è aperta e fresca (dentro la finestra): la narrazione breve del
  // modello può fondersi dentro, invece di chiudere la raffica.
  isOpen(): boolean {
    return !!this.open && Date.now() - this.open.at < this.windowMs;
  }

  private async pushNow(line: string, gen: number): Promise<void> {
    const open = this.open;
    const fresh = open && Date.now() - open.at < this.windowMs;
    if (this.lastWasTool && fresh) {
      // riga vuota tra una tool call e l'altra: la bubble non diventa un muro
      // di testo, ogni tool call resta riconoscibile come voce separata.
      const next = `${open.text}\n\n${line}`;
      if (next.length <= this.maxLen && await this.sink.edit(open.messageId, next)) {
        if (gen !== this.generation) return; // chiusa nel frattempo: non toccare
        open.text = next;
        open.at = Date.now();
        return;
      }
    }
    const id = await this.sink.send(line);
    if (gen !== this.generation) return; // chiusa nel frattempo: non riaprire
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
    this.generation++;
    this.open = undefined;
    this.lastWasTool = false;
  }
}

// Coda delle summary via LLM per le tool call di una sessione: le chiamate
// partono in parallelo ma le righe vanno pushatte in ORDINE (la bubble non deve
// mostrare le tool in ordine sbagliato). `add()` assegna un indice e restituisce
// il callback da chiamare quando la summary è pronta; `reset()` a fine turno
// scarta le summary pendenti (gen) e svuota il buffer.
//
// Due contatori distinti: `last` assegna gli indici (0, 1, 2…), `next` è il
// prossimo indice da fluscare. Senza questa separazione `next` avanzava in
// `add()` e `flush()` cercava `buffer.has(next)` — sempre l'indice successivo a
// quello appena bufferizzato — e la coda non fluscava MAI (le tool call non
// arrivavano su Telegram).
export class SummarizeQueue {
  private next = 0; // prossimo indice da fluscare
  private last = 0; // prossimo indice da assegnare
  private buffer = new Map<number, string>();
  private gen = 0;

  constructor(private onLine: (line: string) => void) {}

  add(): (line: string) => void {
    const index = this.last++;
    const gen = this.gen;
    return (line: string) => {
      if (this.gen !== gen || !line) return; // turno finito: scarta
      this.buffer.set(index, line);
      this.flush();
    };
  }

  reset(): void {
    this.gen++;
    this.buffer.clear();
    this.next = this.last; // gli indici stantii non bloccano i nuovi
  }

  private flush(): void {
    while (this.buffer.has(this.next)) {
      const line = this.buffer.get(this.next)!;
      this.buffer.delete(this.next);
      this.next++;
      this.onLine(line);
    }
  }
}

// ---------- bot ----------

export interface BotDeps {
  config: Config;
  bus: Bus;
  manager: SessionManager;
  permissionFlow: PermissionFlow;
  dialogFlow: DialogFlow;
  sdk: SdkDriver;
  tmux: TmuxClient;
  inbox: Inbox;
  ollama: OllamaClient;
}

export class TelegramBot {
  private bot: Bot;
  private throttler = new EditThrottler(1000);
  private chatId?: number;
  private lastMsg = new Map<string, { messageId: number; text: string; at: number; role: 'user' | 'assistant' }>();
  // Ultimo testo utente per sessione: hint di lingua per le summary via LLM
  // (il messaggio utente non finisce in lastMsg — l'echo del transcript è filtrato).
  private lastUserText = new Map<string, string>();
  private toolBursts = new Map<string, ToolBurstAggregator>();
  // Fix 1: testi iniettati dal bot per sessione (per sopprimere l'echo del transcript).
  private recentInjected = new Map<string, { text: string; at: number }[]>();
  // Fix 2: flusso delle domande a scelta multipla per sessione (macchina a
  // stati: set accodati, una domanda alla volta, multi-select e "Other").
  private questionFlows = new Map<string, QuestionFlow>(); // sessionId → flow
  private flowsByToken = new Map<string, QuestionFlow>(); // token → flow
  // Permessi ExitPlanMode in attesa del testo libero per "Edit plan":
  // sessionId → id della richiesta di permesso.
  private pendingPlanEdits = new Map<string, string>();
  // Summary via LLM per le tool call: una coda per sessione che bufferizza i
  // risultati (le chiamate partono in parallelo) e li pusha in ordine. `reset()`
  // a fine turno (result/errore/domanda/permesso/testo lungo) scarta le summary
  // pendenti: non aprono bubble dopo la fine.
  private summarizeQueues = new Map<string, SummarizeQueue>();
  // Cache delle summary (tool + input → riga): le tool ripetute (stesso file,
  // stesso comando) non rifanno la chiamata a Ollama. Cap semplice: oltre 200
  // si svuota (una cache, non un archivio).
  private summaryCache = new Map<string, string>();
  // Indicatore "sta scrivendo…" per la sessione attiva (chat action, non un messaggio).
  private typing = new TypingIndicator(() => {
    if (!this.chatId) return Promise.resolve();
    return this.bot.api.sendChatAction(this.chatId, 'typing');
  });

  constructor(private deps: BotDeps) {
    // Ripristina la chat di notifica dallo stato: dopo un riavvio del daemon le
    // richieste di permesso devono avere una destinazione già al primo prompt,
    // senza aspettare che l'utente scriva.
    this.chatId = deps.manager.getChatId();
    // timeout di sicurezza su ogni chiamata API Telegram (le getUpdates long-poll
    // usano 30s server-side: 35s non le taglia, ma ogni altra chiamata è limitata).
    this.bot = new Bot(deps.config.telegramBotToken, { client: { timeoutSeconds: 35 } });
    // senza bot.catch, grammy STOPPA il bot al primo errore di middleware non
    // gestito → il daemon moriva (spec §3.1). Ora logghiamo e si va avanti.
    this.bot.catch(err => { console.error('claude-omni-rc bot error:', (err as { error?: unknown })?.error ?? err); });
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
      { command: 'history', description: 'Show the last messages of a session' },
      { command: 'delete', description: 'Delete a session' },
      { command: 'help', description: 'Show all commands' },
    ]).catch(this.logCatch('setMyCommands'));
    await this.bot.start({ drop_pending_updates: true });
  }
  async stop(): Promise<void> {
    await this.bot.stop();
  }

  // Ogni risposta passa dallo splitter: oltre 4096 caratteri Telegram rigetta il
  // messaggio e il .catch lo farebbe sparire in silenzio.
  private async send(ctx: Context, text: string): Promise<unknown> {
    let last: unknown;
    for (const part of splitHtmlMessage(text)) last = await ctx.reply(part, { parse_mode: 'HTML' });
    return last;
  }

  // Invio sequenziale dei chunk (l'ordine conta) con gli extra — tastiera
  // inclusa — solo sull'ultimo. Ritorna l'id dell'ultimo messaggio inviato.
  private async sendChunked(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    const parts = splitHtmlMessage(text);
    let lastId: number | undefined;
    for (let i = 0; i < parts.length; i++) {
      const opts = { parse_mode: 'HTML' as const, ...(i === parts.length - 1 ? extra : {}) };
      const msg = await this.bot.api.sendMessage(chatId, parts[i], opts).catch(err => { this.logCatch('send')(err); return undefined; });
      if (msg) lastId = msg.message_id;
    }
    return lastId;
  }

  private notify(text: string): void {
    const chatId = this.chatId;
    if (!chatId) return;
    this.track(this.sendChunked(chatId, text), 'notify');
  }

  // Contiene ogni errore degli handler: log + reply amichevole, mai un throw che
  // risale al middleware di grammy (che senza bot.catch fermerebbe la coda).
  private safe(ctx: Context, label: string, fn: () => Promise<unknown>): Promise<unknown> {
    return Promise.resolve().then(fn).catch(err => {
      console.error(`handler ${label} failed:`, err);
      return this.send(ctx, '❌ Something went wrong. Check the daemon log.').catch(() => undefined);
    });
  }

  // Aggiunge il log a un'operazione fire-and-forget: niente unhandled rejection
  // (in Node 22 una promise rifiutata non gestita uccide il processo).
  private track(p: Promise<unknown>, label: string): void {
    void p.catch(err => console.error(`background ${label} failed:`, err));
  }

  private logCatch(label: string): (err: unknown) => void {
    return err => console.error(label, err);
  }
  private async forwardText(sessionId: string, text: string, role: 'user' | 'assistant'): Promise<void> {
    const chatId = this.chatId;
    if (!chatId) return;
    const last = this.lastMsg.get(sessionId);
    const now = Date.now();
    // concatena solo messaggi dello stesso ruolo (un turno con più blocchi text
    // diventa una bubble unica; non mischia mai un echo utente con una risposta).
    // Il merge si ferma prima del limite Telegram: oltre, ogni edit fallirebbe e
    // il testo nuovo andrebbe perso — meglio un messaggio nuovo.
    const merged = last ? `${last.text}\n${text}` : '';
    if (last && last.role === role && now - last.at < 10_000 && merged.length <= SEND_MAX_CHARS) {
      const ok = await this.throttler.throttled(() =>
        this.bot.api.editMessageText(chatId, last.messageId, merged, { parse_mode: 'HTML' }).then(() => true).catch(() => false));
      if (ok) { last.text = merged; last.at = now; return; }
    }
    // testo lungo → più messaggi; il tracking punta all'ultimo, che è quello
    // che eventuali blocchi successivi dello stesso turno estenderanno.
    const parts = splitHtmlMessage(text);
    const messageId = await this.sendChunked(chatId, text);
    if (messageId !== undefined) {
      this.lastMsg.set(sessionId, { messageId, text: parts[parts.length - 1], at: now, role });
    }
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
            this.bot.api.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' })
              .then(() => true)
              .catch(err => { console.error('claude-omni-rc tool edit failed:', err); return false; }));
          return ok ?? false;
        },
        send: async text => {
          const chatId = this.chatId;
          if (!chatId) return undefined;
          // anche il send passa dal throttler: massimo 1 op/sec per chat (niente 429).
          const msg = await this.throttler.throttled(() =>
            this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' }).catch(() => undefined));
          return msg?.message_id;
        },
      });
      this.toolBursts.set(sessionId, agg);
    }
    return agg;
  }

  // Summary via LLM di una tool call, con l'ingranaggio ⚙️ che la identifica
  // come tool call. Fallback a `summarizeTool` se Ollama non risponde (timeout
  // 5s) o restituisce vuoto.
  private async llmSummarize(model: string, toolName: string, input: Record<string, unknown>, languageHint?: string): Promise<string> {
    const key = `${toolName}:${JSON.stringify(input).slice(0, 200)}`;
    const hit = this.summaryCache.get(key);
    if (hit) return hit;
    let line: string;
    try {
      const llm = await this.deps.ollama.summarize(model, toolName, input, languageHint);
      line = `⚙️ ${llm}`;
    } catch {
      line = summarizeTool(toolName, input);
    }
    if (this.summaryCache.size >= 200) this.summaryCache.clear();
    this.summaryCache.set(key, line);
    return line;
  }

  // Lancia la summary per una tool call: chiamate in parallelo, risultati
  // bufferizzati per indice e pushati in ordine (la bubble non deve mostrare le
  // tool in ordine sbagliato). Se il turno è finito nel frattempo (gen cambiato),
  // la summary viene scartata.
  private summarizeToolLine(sessionId: string, model: string, toolName: string, input: Record<string, unknown>, languageHint?: string): void {
    let q = this.summarizeQueues.get(sessionId);
    if (!q) {
      q = new SummarizeQueue(line => this.toolBurst(sessionId).push(htmlEscape(line)));
      this.summarizeQueues.set(sessionId, q);
    }
    void this.llmSummarize(model, toolName, input, languageHint).then(q.add());
  }

  // Fine turno (o testo lungo): le summary pendenti di questa sessione vengono
  // scartate — non devono aprire bubble dopo la risposta/errore.
  private resetSummarize(sessionId: string): void {
    this.summarizeQueues.get(sessionId)?.reset();
  }

  private isAuthorized(ctx: Context): boolean {
    if (!isPrivateChat(ctx.chat)) return false;
    const userId = ctx.from?.id;
    return !!userId && (this.deps.config.allowedUserIds.includes(userId) || this.deps.manager.isAuthorizedUser(userId));
  }

  // Destinazione delle notifiche: la chat privata da cui è arrivato l'ultimo
  // comando autorizzato, persistita così da sopravvivere ai riavvii del daemon.
  private bindChat(ctx: Context): void {
    const id = ctx.chat?.id;
    if (id === undefined || !isPrivateChat(ctx.chat)) return;
    this.chatId = id;
    this.deps.manager.setChatId(id);
  }

  // C'è una chat a cui notificare? Lo consulta il flusso permessi: senza
  // destinazione una richiesta resterebbe appesa fino al timeout.
  canNotify(): boolean { return this.chatId !== undefined; }

  private authorize(ctx: Context): boolean {
    if (this.isAuthorized(ctx)) { this.bindChat(ctx); return true; }
    if (!isPrivateChat(ctx.chat)) return false; // in un gruppo il bot tace del tutto
    this.track(this.send(ctx, '⛔ Not authorized. Send <code>/start &lt;pairing code&gt;</code>.'), 'authorize reply');
    return false;
  }

  private register(): void {
    const bot = this.bot;
    bot.command('start', ctx => this.safe(ctx, 'start', () => this.onStart(ctx)));
    bot.command('help', ctx => this.safe(ctx, 'help', async () => {
      if (this.authorize(ctx)) await this.send(ctx, 'Commands: /rc [on|off|status] (no arg toggles) · /sessions · /view · /new &lt;text&gt; · /stop · /status · /attach &lt;project&gt; · /history [id] · /delete [id] · /help');
    }));
    bot.command('rc', ctx => this.safe(ctx, 'rc', () => this.onRc(ctx)));
    bot.command('sessions', ctx => this.safe(ctx, 'sessions', () => this.onSessions(ctx)));
    bot.command('view', ctx => this.safe(ctx, 'view', () => this.onView(ctx)));
    bot.command('new', ctx => this.safe(ctx, 'new', () => this.onNew(ctx)));
    bot.command('stop', ctx => this.safe(ctx, 'stop', () => this.onStop(ctx)));
    bot.command('status', ctx => this.safe(ctx, 'status', () => this.onStatus(ctx)));
    bot.command('attach', ctx => this.safe(ctx, 'attach', () => this.onAttach(ctx)));
    bot.command('history', ctx => this.safe(ctx, 'history', () => this.onHistory(ctx)));
    bot.command('delete', ctx => this.safe(ctx, 'delete', () => this.onDelete(ctx)));
    bot.on('callback_query:data', ctx => this.safe(ctx, 'callback', () => this.onCallback(ctx)));
    bot.on('message:text', ctx => this.safe(ctx, 'message', () => this.onMessage(ctx)));
    bot.on('message:photo', ctx => this.safe(ctx, 'photo', () => this.onPhoto(ctx)));
    bot.on('message:document', ctx => this.safe(ctx, 'document', () => this.onDocument(ctx)));
  }

  private async onStart(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;
    // Il pairing non avviene mai in un gruppo: autorizzerebbe un account e
    // punterebbe le notifiche su una chat condivisa.
    if (!isPrivateChat(ctx.chat)) {
      await this.send(ctx, '⛔ claude-omni-rc works only in a private chat with the bot.');
      return;
    }
    if (this.isAuthorized(ctx)) {
      this.bindChat(ctx);
      await this.send(ctx, `👋 Welcome! State: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disarmed'}. Use /help.`);
      return;
    }
    const code = ctx.match?.toString().trim() ?? '';
    if (this.deps.config.pairingCode && code === this.deps.config.pairingCode) {
      this.deps.manager.addAuthorizedUser(userId);
      this.deps.manager.persist();
      this.bindChat(ctx);
      await this.send(ctx, '✅ Pairing successful. Use /help.');
    } else {
      await this.send(ctx, '⛔ Not authorized. Send <code>/start &lt;pairing code&gt;</code>.');
    }
  }

  private async arm(ctx: Context): Promise<void> {
    this.deps.manager.setArmed(true); this.deps.manager.persist();
    await this.send(ctx, '🔓 Remote control ARMED.');
  }

  private async disarm(ctx: Context): Promise<void> {
    this.deps.manager.setArmed(false);
    for (const s of this.deps.manager.list()) {
      this.deps.permissionFlow.cancelAllForSession(s.id);
      this.deps.dialogFlow.cancelAllForSession(s.id);
      this.pendingPlanEdits.delete(s.id);
      this.deps.sdk.stop(s.id); // spegne anche i turni headless in corso
    }
    this.deps.manager.persist();
    await this.send(ctx, '🔒 Remote control DISARMED. No mirroring, injection or relay.');
  }

  private async onRc(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    const arg = (ctx.match?.toString().trim() ?? '').toLowerCase();
    if (arg === 'on') {
      await this.arm(ctx);
    } else if (arg === 'off') {
      await this.disarm(ctx);
    } else if (arg === 'status') {
      await this.send(ctx, `Switch: ${this.deps.manager.isArmed() ? '🔓 armed' : '🔒 disarmed'}`);
    } else if (arg === '') {
      // no argument → toggle the armed switch
      if (this.deps.manager.isArmed()) await this.disarm(ctx);
      else await this.arm(ctx);
    } else {
      await this.send(ctx, 'Usage: /rc [on|off|status] — no argument toggles.');
    }
  }

  private requireArmed(ctx: Context): boolean {
    if (!this.deps.manager.isArmed()) { this.track(this.send(ctx, '🔒 Remote control is off. Send /rc on.'), 'requireArmed reply'); return false; }
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
    for (const s of list) kb.text(s.id.slice(0, 6), `sess:select:${s.id}`).text('🗑', `sess:del:${s.id}`).row();
    await ctx.reply(sessionListText(list, this.deps.manager.getActive()), {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }

  private async onNew(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const raw = ctx.match?.toString().trim() ?? '';
    if (!raw) {
      await this.send(ctx, 'Usage: /new [--auto|--standard] [--model &lt;name&gt;] &lt;text&gt;');
      return;
    }
    const { mode, model, text } = parseNewFlags(raw);
    if (!text) { await this.send(ctx, 'Usage: /new [--auto|--standard] [--model &lt;name&gt;] &lt;text&gt;'); return; }
    const running = this.deps.manager.list().filter(s => s.kind === 'headless' && s.status === 'running').length;
    if (running >= this.deps.config.maxHeadlessSessions) { await this.send(ctx, `Reached the limit of ${this.deps.config.maxHeadlessSessions} active headless sessions.`); return; }
    const { dir: projectDir, error } = resolveHeadlessProjectDir(this.deps.config.workspaceDirs);
    if (!projectDir) { await this.send(ctx, `⚠️ ${error}`); return; }
    const permissionMode = mode ?? this.deps.config.defaultPermissionMode;
    const session = this.deps.manager.createHeadless({
      title: text.slice(0, 40), projectDir, model: model ?? this.deps.config.defaultModel,
      permissionMode,
    });
    this.deps.manager.setActive(session.id); // persiste anche la nuova sessione
    const modeLabel = permissionMode === 'standard' ? ' (standard — approvals via buttons)' : ' (automode — no approvals)';
    await this.send(ctx, `🆕 Session <b>${htmlEscape(session.id.slice(0, 8))}</b> started${modeLabel}.`);
    // NON await: grammy processa gli update in sequenza — aspettare un turno di minuti
    // bloccherebbe /stop, /rc off e i callback. Il driver emette gli eventi sul bus.
    this.track(this.deps.sdk.runTurn(session.id, text), 'runTurn');
  }

  private async onStop(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const active = this.deps.manager.getActive();
    const s = active ? this.deps.manager.get(active) : undefined;
    if (!s) { await this.send(ctx, 'No active session.'); return; }
    const id8 = s.id.slice(0, 8);
    const flow = this.questionFlows.get(s.id);
    if (flow) this.deleteFlow(flow); // /stop: niente domande pendenti
    this.pendingPlanEdits.delete(s.id);
    if (s.kind === 'headless') {
      this.deps.permissionFlow.cancelAllForSession(s.id);
      this.deps.dialogFlow.cancelAllForSession(s.id);
      const aborted = this.deps.sdk.stop(s.id); // abort del turno in corso
      await this.send(ctx, stopReply({ kind: 'headless', id8, aborted, status: s.status }));
    } else if (s.tmuxTarget) {
      try {
        await this.deps.tmux.sendKeys(s.tmuxTarget, 'C-c');
        await this.send(ctx, stopReply({ kind: 'terminal', id8, target: s.tmuxTarget }));
      } catch (e) {
        await this.send(ctx, `❌ ${htmlEscape(e instanceof Error ? e.message : String(e))}`);
      }
    } else {
      await this.send(ctx, stopReply({ kind: 'terminal', id8 }));
    }
  }

  private async onStatus(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const active = this.deps.manager.getActive(); const s = active ? this.deps.manager.get(active) : undefined;
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
    this.deps.manager.setActive(session.id); // persiste anche la sessione terminale
    await this.send(ctx, `📎 Terminal session <b>${htmlEscape(session.id.slice(0, 8))}</b> attached to <code>claude:${htmlEscape(name)}</code>.`);
  }

  private resolveProjectDir(name: string): string | undefined {
    for (const w of this.deps.config.workspaceDirs) {
      const candidate = join(w, name);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private async onHistory(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const id = ctx.match?.toString().trim() || this.deps.manager.getActive();
    if (!id) { await this.send(ctx, 'No active session. Select one with /sessions.'); return; }
    const hist = await this.readHistory(id);
    if (!hist) { await this.send(ctx, 'No transcript available for this session yet.'); return; }
    await this.send(ctx, hist);
  }

  // Fix 5: gli ultimi ~10 messaggi del transcript della sessione, come chat.
  private async readHistory(sessionId: string): Promise<string | undefined> {
    const s = this.deps.manager.get(sessionId);
    if (!s) return undefined;
    const file = resolveSessionTranscript(
      this.deps.config.projectsDir,
      s.projectDir,
      s.kind === 'headless' ? s.claudeSessionId : undefined,
      Date.parse(s.createdAt),
      s.transcriptFile, // path registrato: se non esiste più viene ritrovato per basename (worktree)
    );
    if (!file) return undefined;
    const msgs = readRecentMessages(file, 10);
    if (!msgs.length) return undefined;
    return renderHistory(msgs, s.title || s.id.slice(0, 8));
  }

  private async onDelete(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const id = ctx.match?.toString().trim() || this.deps.manager.getActive();
    if (!id) { await this.send(ctx, 'Usage: /delete [session id]'); return; }
    const s = this.deps.manager.get(id);
    if (!s) { await this.send(ctx, 'Session not found.'); return; }
    const kb = new InlineKeyboard()
      .text('✓ Yes, delete', `sess:del-yes:${s.id}`)
      .text('✗ No', `sess:del-no:${s.id}`);
    await ctx.reply(`Delete session <b>${htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}]?`, {
      parse_mode: 'HTML', reply_markup: kb,
    });
  }

  // Fix 6: ferma il turno headless e rimuove la sessione dal registro.
  // Per le terminali il pane tmux continua a girare: si perde solo il tracking.
  private deleteSession(id: string): boolean {
    this.deps.permissionFlow.cancelAllForSession(id);
    this.deps.dialogFlow.cancelAllForSession(id);
    this.pendingPlanEdits.delete(id);
    this.deps.sdk.stop(id); // abort del turno headless in corso
    const flow = this.questionFlows.get(id);
    if (flow) this.deleteFlow(flow); // niente domande pendenti per una sessione sparita
    const ok = this.deps.manager.remove(id);
    if (ok) this.deps.manager.persist();
    return ok;
  }

  // Feedback persistente (Fix 7): sostituisce i bottoni con l'esito della decisione.
  private async editCallbackDecision(ctx: Context, header: string): Promise<void> {
    const msg = ctx.callbackQuery?.message;
    if (!msg || !('text' in msg)) return;
    await ctx.editMessageText(`${header}\n\n${msg.text}`, {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard(), // svuota i bottoni
    }).catch(this.logCatch('callback edit'));
  }

  // ---------- flusso domande multiple ----------

  private setFlow(flow: QuestionFlow): void {
    this.questionFlows.set(flow.sessionId, flow);
    this.flowsByToken.set(flow.token, flow);
  }

  private deleteFlow(flow: QuestionFlow): void {
    this.questionFlows.delete(flow.sessionId);
    this.flowsByToken.delete(flow.token);
  }

  // Un nuovo set di domande (una chiamata AskUserQuestion) arriva dal bus:
  // accodato al flow della sessione; se il flow è idle, mostra la prima domanda.
  private async onSessionPrompt(sessionId: string, questions: PromptQuestion[]): Promise<void> {
    let flow = this.questionFlows.get(sessionId);
    if (!flow) {
      flow = { sessionId, sets: [], setIndex: 0, qIndex: 0, answers: [], token: randomUUID(), multiSel: [] };
      this.setFlow(flow);
    }
    flow.sets.push(questions);
    flow.answers.push(questions.map(() => undefined));
    if (flow.setIndex === 0 && flow.qIndex === 0 && !flow.messageId) {
      await this.showQuestion(flow);
    }
  }

  // Header + elenco numerato + stato selezione per la domanda corrente.
  private renderQuestion(flow: QuestionFlow, q: PromptQuestion): string {
    const set = flow.sets[flow.setIndex];
    const header = `Set ${flow.setIndex + 1} of ${flow.sets.length} · Question ${flow.qIndex + 1} of ${set.length}`;
    const title = q.header ? `${q.header}: ${q.question}` : q.question;
    const multi = q.multiSelect ? ' (select all that apply)' : '';
    const opts = q.options
      .map((o, i) => `  ${i + 1}. ${htmlEscape(o.label)}${o.description ? ` — <i>${htmlEscape(o.description)}</i>` : ''}`)
      .join('\n');
    const sel = q.multiSelect && flow.multiSel.length
      ? `\n\n<i>Selected: ${flow.multiSel.map(i => htmlEscape(q.options[i].label)).join(', ')}</i>`
      : '';
    return `❓ <b>${htmlEscape(header)}</b>\n<b>${htmlEscape(title)}</b>${multi}\n${opts}${sel}`;
  }

  // Bottoni per la domanda corrente: opzioni (toggle per multi-select), Done e Other.
  private buildQuestionKeyboard(flow: QuestionFlow, q: PromptQuestion): InlineKeyboard {
    const kb = new InlineKeyboard();
    const token = flow.token;
    const qi = flow.qIndex;
    if (q.multiSelect) {
      for (let i = 0; i < q.options.length; i++) {
        const selected = flow.multiSel.includes(i);
        kb.text(`${selected ? '✓ ' : ''}${q.options[i].label}`, `q:answer:${token}:${qi}:${i}`).row();
      }
      kb.text('✓ Done', `q:done:${token}:${qi}`).row();
      kb.text('✏️ Other', `q:other:${token}:${qi}`).row();
    } else {
      for (let i = 0; i < q.options.length; i++) {
        kb.text(q.options[i].label, `q:answer:${token}:${qi}:${i}`).row();
      }
      kb.text('✏️ Other', `q:other:${token}:${qi}`).row();
    }
    return kb;
  }

  // Invia un nuovo messaggio per la domanda corrente.
  private async showQuestion(flow: QuestionFlow): Promise<void> {
    if (!this.chatId) return;
    const q = flow.sets[flow.setIndex][flow.qIndex];
    const text = this.renderQuestion(flow, q);
    const kb = this.buildQuestionKeyboard(flow, q);
    const id = await this.sendChunked(this.chatId, text, { reply_markup: kb });
    if (id) flow.messageId = id;
  }

  // Edita il messaggio corrente (toggle multi-select, cancel Other).
  private async updateQuestionMessage(flow: QuestionFlow): Promise<void> {
    if (!flow.messageId || !this.chatId) return;
    const q = flow.sets[flow.setIndex][flow.qIndex];
    const text = this.renderQuestion(flow, q);
    const kb = this.buildQuestionKeyboard(flow, q);
    await this.bot.api.editMessageText(this.chatId, flow.messageId, text, {
      parse_mode: 'HTML', reply_markup: kb,
    }).catch(this.logCatch('prompt edit'));
  }

  // Conferma visiva della risposta sul messaggio corrente (bottoni rimossi).
  private async acknowledgeAnswer(flow: QuestionFlow, ack: string): Promise<void> {
    if (!flow.messageId || !this.chatId) return;
    const q = flow.sets[flow.setIndex][flow.qIndex];
    const text = `${this.renderQuestion(flow, q)}\n\n✅ <b>Answer:</b> ${htmlEscape(ack)}`;
    await this.bot.api.editMessageText(this.chatId, flow.messageId, text, {
      parse_mode: 'HTML', reply_markup: new InlineKeyboard(),
    }).catch(this.logCatch('prompt edit'));
  }

  // Prompt per il testo libero "Other" (con Cancel per tornare ai bottoni).
  private async showOtherPrompt(flow: QuestionFlow, qIndex: number): Promise<void> {
    if (!flow.messageId || !this.chatId) return;
    const q = flow.sets[flow.setIndex][qIndex];
    const title = q.header ? `${q.header}: ${q.question}` : q.question;
    const kb = new InlineKeyboard().text('↩️ Cancel', `q:cancel:${flow.token}:${qIndex}`);
    await this.bot.api.editMessageText(this.chatId, flow.messageId, `✏️ <b>Type your answer for:</b> ${htmlEscape(title)}`, {
      parse_mode: 'HTML', reply_markup: kb,
    }).catch(this.logCatch('prompt edit'));
  }

  // Tap su un'opzione: single-select risponde subito, multi-select toggla.
  private async answerPrompt(ctx: Context, parsed: CallbackData): Promise<void> {
    const flow = this.flowsByToken.get(parsed.id);
    if (!flow) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
    const qIndex = parsed.questionIndex ?? 0;
    const optIndex = parsed.index ?? 0;
    const q = flow.sets[flow.setIndex][qIndex];
    const opt = q?.options[optIndex];
    if (!q || !opt) { await ctx.answerCallbackQuery({ text: 'Invalid option' }); return; }
    if (q.multiSelect) {
      const i = flow.multiSel.indexOf(optIndex);
      if (i === -1) flow.multiSel.push(optIndex);
      else flow.multiSel.splice(i, 1);
      await ctx.answerCallbackQuery({ text: flow.multiSel.includes(optIndex) ? `✓ ${opt.label}` : opt.label });
      await this.updateQuestionMessage(flow);
      return;
    }
    await ctx.answerCallbackQuery({ text: `✓ ${opt.label}` });
    await this.answerSingle(flow, qIndex, optIndex);
  }

  // Tap su "Done": conferma la multi-select.
  private async donePrompt(ctx: Context, parsed: CallbackData): Promise<void> {
    const flow = this.flowsByToken.get(parsed.id);
    if (!flow) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
    const qIndex = parsed.questionIndex ?? 0;
    const q = flow.sets[flow.setIndex][qIndex];
    if (!q?.multiSelect) { await ctx.answerCallbackQuery({ text: 'Invalid' }); return; }
    if (!flow.multiSel.length) { await ctx.answerCallbackQuery({ text: 'Select at least one option' }); return; }
    const labels = flow.multiSel.map(i => q.options[i].label);
    await ctx.answerCallbackQuery({ text: `✓ ${labels.join(', ')}` });
    await this.doneMultiSelect(flow, qIndex);
  }

  // Logica core single-select (usata da callback e reply numerico).
  private async answerSingle(flow: QuestionFlow, qIndex: number, optIndex: number): Promise<void> {
    const q = flow.sets[flow.setIndex][qIndex];
    const opt = q.options[optIndex];
    flow.answers[flow.setIndex][qIndex] = { kind: 'option', labels: [opt.label] };
    await this.acknowledgeAnswer(flow, opt.label);
    await this.recordAndAdvance(flow);
  }

  // Logica core multi-select (usata da callback e reply numerico).
  private async doneMultiSelect(flow: QuestionFlow, qIndex: number): Promise<void> {
    const q = flow.sets[flow.setIndex][qIndex];
    const labels = flow.multiSel.map(i => q.options[i].label);
    flow.answers[flow.setIndex][qIndex] = { kind: 'option', labels };
    flow.multiSel = [];
    await this.acknowledgeAnswer(flow, labels.join(', '));
    await this.recordAndAdvance(flow);
  }

  // Tap su "Other": il prossimo testo dell'utente è la risposta libera.
  private async otherPrompt(ctx: Context, parsed: CallbackData): Promise<void> {
    const flow = this.flowsByToken.get(parsed.id);
    if (!flow) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
    const qIndex = parsed.questionIndex ?? 0;
    flow.awaitingOther = { setIndex: flow.setIndex, qIndex };
    await ctx.answerCallbackQuery({ text: 'Type your answer' });
    await this.showOtherPrompt(flow, qIndex);
  }

  // Tap su "Cancel" durante il testo libero: torna ai bottoni.
  private async cancelPrompt(ctx: Context, parsed: CallbackData): Promise<void> {
    const flow = this.flowsByToken.get(parsed.id);
    if (!flow) { await ctx.answerCallbackQuery({ text: 'Expired question' }); return; }
    flow.awaitingOther = undefined;
    await ctx.answerCallbackQuery({ text: 'Cancelled' });
    await this.updateQuestionMessage(flow);
  }

  // Testo libero arrivato da onMessage mentre awaitingOther è attivo.
  private async answerOther(flow: QuestionFlow, text: string): Promise<void> {
    const { setIndex, qIndex } = flow.awaitingOther!;
    flow.answers[setIndex][qIndex] = { kind: 'other', text };
    flow.awaitingOther = undefined;
    await this.acknowledgeAnswer(flow, text);
    await this.recordAndAdvance(flow);
  }

  // Dopo una risposta: per le terminali inietta subito la risposta nel pane;
  // poi avanza (per le headless la consegna avviene a set completo in advance).
  private async recordAndAdvance(flow: QuestionFlow): Promise<void> {
    const session = this.deps.manager.get(flow.sessionId);
    if (session?.kind === 'terminal') {
      const q = flow.sets[flow.setIndex][flow.qIndex];
      const a = flow.answers[flow.setIndex][flow.qIndex];
      if (a) await this.deliverAnswer(session, q, a);
    }
    await this.advance(flow);
  }

  // Avanza alla prossima domanda/set; a set completo consegna (headless) e
  // passa al set successivo; a fine coda pulisce il flow.
  private async advance(flow: QuestionFlow): Promise<void> {
    const set = flow.sets[flow.setIndex];
    if (flow.qIndex < set.length - 1) {
      flow.qIndex++;
      await this.showQuestion(flow);
      return;
    }
    const session = this.deps.manager.get(flow.sessionId);
    if (session?.kind === 'headless') {
      await this.deliverSet(flow, flow.setIndex);
    }
    flow.setIndex++;
    flow.qIndex = 0;
    if (flow.setIndex < flow.sets.length) {
      await this.showQuestion(flow);
    } else {
      this.deleteFlow(flow);
    }
  }

  // Iniezione tmux della risposta a una domanda (terminali).
  private async deliverAnswer(session: Session, q: PromptQuestion, a: PromptAnswer): Promise<void> {
    if (session.kind !== 'terminal' || !session.tmuxTarget) return;
    const text = answerToInjection(q, a);
    try {
      await this.deps.tmux.injectText(session.tmuxTarget, text);
      this.recordInjected(session.id, text);
    } catch (e) {
      console.error('deliverAnswer failed:', e);
    }
  }

  // Consegna di un intero set (headless): un unico messaggio con tutte le risposte.
  private async deliverSet(flow: QuestionFlow, setIndex: number): Promise<void> {
    const session = this.deps.manager.get(flow.sessionId);
    if (!session || session.kind !== 'headless') return;
    const text = answersToMessage(flow.sets[setIndex], flow.answers[setIndex]);
    if (this.deps.sdk.isBusy(session.id)) {
      this.notify('⏳ Session busy — the answers were not sent. Reply by text.');
      return;
    }
    this.track(this.deps.sdk.runTurn(session.id, text), 'runTurn');
  }

  // ---------- dialoghi bloccanti (request_user_dialog) ----------

  // Un dialogo arriva dal driver (headless): lo si mostra in chat con i bottoni
  // giusti. NON è gated sulla sessione attiva: un dialogo va visto comunque,
  // qualunque sessione sia selezionata.
  private async onSessionDialog(sessionId: string, dialog: UserDialog): Promise<void> {
    if (!this.chatId) return;
    const session = this.deps.manager.get(sessionId);
    const text = dialogMessage(dialog, session);
    const kb = dialogKeyboard(dialog);
    await this.sendChunked(this.chatId, text, { reply_markup: kb });
  }

  // Retry con il modello di fallback (refusal_fallback_prompt). Il result è la
  // stringa enum che il CLI si aspetta: 'retry_fallback' | 'edit_prompt' |
  // 'cancelled'. 'edit_prompt' fa editare il prompt localmente (inutile da
  // Telegram), quindi qui si offre solo Retry/Skip.
  private async dlgRetry(ctx: Context, parsed: CallbackData): Promise<void> {
    const ok = this.deps.dialogFlow.complete(parsed.id, 'retry_fallback');
    await ctx.answerCallbackQuery({ text: ok ? '🔄 Retrying' : 'Already resolved' });
    if (ok) await this.editCallbackDecision(ctx, '🔄 <b>Retrying with fallback model</b>');
  }

  // Skip / cancel (refusal_fallback_prompt o kind sconosciuto).
  private async dlgSkip(ctx: Context, parsed: CallbackData): Promise<void> {
    const ok = this.deps.dialogFlow.cancel(parsed.id);
    await ctx.answerCallbackQuery({ text: ok ? 'Skipped' : 'Already resolved' });
    if (ok) await this.editCallbackDecision(ctx, '⏭️ <b>Skipped</b>');
  }

  // ---------- approvazione del piano (ExitPlanMode via canUseTool) ----------

  // "Edit plan" su una richiesta di permesso ExitPlanMode: il prossimo testo
  // dell'utente è il nuovo piano. Il messaggio originale (col piano) resta
  // visibile, con la richiesta in coda.
  private async permEdit(ctx: Context, parsed: CallbackData): Promise<void> {
    const info = this.deps.permissionFlow.infoFor(parsed.id);
    if (!info) { await ctx.answerCallbackQuery({ text: 'Expired request' }); return; }
    this.pendingPlanEdits.set(info.sessionId, parsed.id);
    await ctx.answerCallbackQuery({ text: 'Type the new plan' });
    const msg = ctx.callbackQuery?.message;
    const original = msg && 'text' in msg ? msg.text : '';
    await ctx.editMessageText(`${original}\n\n✏️ <b>Type the new plan text.</b> Send it as a message; the session will continue with your edited plan.`, {
      parse_mode: 'HTML',
    }).catch(this.logCatch('plan edit'));
  }

  // Testo libero arrivato da onMessage mentre un "Edit plan" è in attesa.
  private async answerPlanEdit(sessionId: string, text: string): Promise<void> {
    const id = this.pendingPlanEdits.get(sessionId);
    if (!id) return;
    this.pendingPlanEdits.delete(sessionId);
    const info = this.deps.permissionFlow.infoFor(id);
    if (!info) return;
    const ok = this.deps.permissionFlow.approve(id, { ...info.input, plan: text });
    if (ok) this.notify('✏️ <b>Plan edited</b> — the session continues with your plan.');
  }

  private async onCallback(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    // da disattivo nessuna approvazione/deny/switch (constraint 8): un permesso
    // in sospeso resta pending e scade → deny per timeout.
    if (!this.deps.manager.isArmed()) { await ctx.answerCallbackQuery({ text: '🔒 Remote control is off' }); return; }
    const data = ctx.callbackQuery?.data ?? '';
    try {
      const parsed = parseCallbackData(data);
      switch (parsed.action) {
        case 'approve': {
          // ExitPlanMode: l'approvazione conferma il piano → updatedInput col
          // piano originale (il tool lo scrive sul file del piano).
          const info = this.deps.permissionFlow.infoFor(parsed.id);
          const updatedInput = info?.toolName === 'ExitPlanMode' ? info.input : undefined;
          const ok = this.deps.permissionFlow.approve(parsed.id, updatedInput);
          await ctx.answerCallbackQuery({ text: ok ? '✓ Approved' : 'Already resolved' });
          if (ok) await this.editCallbackDecision(ctx, '✅ <b>Approved</b>');
          break;
        }
        case 'deny': {
          const info = this.deps.permissionFlow.infoFor(parsed.id);
          const message = info?.toolName === 'ExitPlanMode' ? 'Plan rejected from Telegram' : undefined;
          const ok = this.deps.permissionFlow.deny(parsed.id, message);
          await ctx.answerCallbackQuery({ text: ok ? '✗ Rejected' : 'Already resolved' });
          if (ok) await this.editCallbackDecision(ctx, '❌ <b>Rejected</b>');
          break;
        }
        case 'perm-edit': {
          await this.permEdit(ctx, parsed);
          break;
        }
        case 'select': {
          const s = this.deps.manager.get(parsed.id);
          if (s) this.deps.manager.setActive(s.id);
          this.syncTyping(); // la sessione appena selezionata può essere già in running
          await ctx.answerCallbackQuery({ text: 'Session selected' });
          await ctx.editMessageText(sessionListText(this.deps.manager.list(), this.deps.manager.getActive()), { parse_mode: 'HTML' });
          // Fix 5: mostra la storia recente della sessione appena selezionata.
          // Una sessione fresca non ha transcript suo → niente storia vecchia, solo
          // una nota (prima mostrava la history della sessione precedente).
          const hist = await this.readHistory(parsed.id);
          if (this.chatId) {
            this.track(this.sendChunked(this.chatId, hist ?? 'Fresh session — no history yet.'), 'callback send');
          }
          break;
        }
        case 'answer': {
          await this.answerPrompt(ctx, parsed);
          break;
        }
        case 'done': {
          await this.donePrompt(ctx, parsed);
          break;
        }
        case 'other': {
          await this.otherPrompt(ctx, parsed);
          break;
        }
        case 'cancel': {
          await this.cancelPrompt(ctx, parsed);
          break;
        }
        case 'del': {
          const s = this.deps.manager.get(parsed.id);
          if (!s) { await ctx.answerCallbackQuery({ text: 'Session not found' }); return; }
          await ctx.answerCallbackQuery({ text: 'Confirm?' });
          const kb = new InlineKeyboard()
            .text('✓ Yes, delete', `sess:del-yes:${s.id}`)
            .text('✗ No', `sess:del-no:${s.id}`);
          await ctx.reply(`Delete session <b>${htmlEscape(s.title) || htmlEscape(s.id.slice(0, 8))}</b> [${s.kind}]?`, {
            parse_mode: 'HTML', reply_markup: kb,
          }).catch(this.logCatch('callback send'));
          break;
        }
        case 'del-yes': {
          const ok = this.deleteSession(parsed.id);
          await ctx.answerCallbackQuery({ text: ok ? '🗑 Deleted' : 'Already deleted' });
          await ctx.editMessageText(ok ? '🗑 Session deleted.' : 'Session already gone.', { parse_mode: 'HTML' }).catch(this.logCatch('callback send'));
          break;
        }
        case 'del-no': {
          await ctx.answerCallbackQuery({ text: 'Cancelled' });
          await ctx.editMessageText('Delete cancelled.', { parse_mode: 'HTML' }).catch(this.logCatch('callback send'));
          break;
        }
        case 'dlg-retry': {
          await this.dlgRetry(ctx, parsed);
          break;
        }
        case 'dlg-skip': {
          await this.dlgSkip(ctx, parsed);
          break;
        }
      }
    } catch {
      await ctx.answerCallbackQuery({ text: 'Invalid data' });
    }
  }

  private async routeMessageToSession(ctx: Context, text: string): Promise<void> {
    const session = this.deps.manager.getActive() ? this.deps.manager.get(this.deps.manager.getActive()!) : this.deps.manager.list()[0];
    if (!session) { await this.send(ctx, 'No session. Create one with /new or /attach.'); return; }
    if (session.kind === 'headless') {
      if (this.deps.sdk.isBusy(session.id)) {
        await this.send(ctx, '⏳ Session busy: wait for it to go idle before forwarding.');
        return;
      }
      this.track(this.deps.sdk.runTurn(session.id, text), 'runTurn');
    } else {
      if (!session.tmuxTarget) {
        await this.send(ctx, 'This session is not running in tmux, so text can’t be injected. Start it with:\n<code>tmux new -s claude:&lt;project&gt;</code>');
        return;
      }
      try {
        await this.deps.tmux.injectText(session.tmuxTarget, text);
        this.recordInjected(session.id, text);
      } catch (e) {
        // tmux giù o pane sparito: errore amichevole, mai un throw che uccide il daemon.
        await this.send(ctx, `❌ Can't inject into <code>${htmlEscape(session.tmuxTarget)}</code>: ${htmlEscape(e instanceof Error ? e.message : String(e))}. Is tmux running?`);
      }
    }
  }

  // Fix 1: registra i testi iniettati dal bot (per sopprimere l'echo del transcript).
  private recordInjected(sessionId: string, text: string): void {
    const list = this.recentInjected.get(sessionId) ?? [];
    list.push({ text, at: Date.now() });
    if (list.length > 5) list.shift();
    this.recentInjected.set(sessionId, list);
  }

  private isInjectedEcho(sessionId: string, text: string): boolean {
    return matchesInjected(this.recentInjected.get(sessionId) ?? [], text, Date.now());
  }

  private async onMessage(ctx: Context): Promise<void> {
    if (!this.authorize(ctx)) return;
    if (!ctx.message) return;
    // grammy 1.45: `text` è `text?: string` anche su message:text — la guardia non lo
    // restringe; `?? ''` è sicuro perché il filtro message:text scatta solo su testi.
    const text = ctx.message.text ?? '';
    if (!this.deps.manager.isArmed()) { await this.send(ctx, '🔒 Remote control is off. Send /rc on.'); return; }
    // hint di lingua per le summary via LLM: l'ultimo testo utente della sessione.
    const active = this.deps.manager.getActive();
    const session = active ? this.deps.manager.get(active) : this.deps.manager.list()[0];
    if (session) this.lastUserText.set(session.id, text);
    // "Edit plan" in attesa: il testo dell'utente è il nuovo piano.
    if (session && this.pendingPlanEdits.has(session.id)) {
      await this.answerPlanEdit(session.id, text);
      return;
    }
    // Flusso domande: testo libero per "Other" o reply numerico come fallback ai
    // bottoni. Qualsiasi altro testo viene inoltrato alla sessione come sempre.
    const flow = session ? this.questionFlows.get(session.id) : undefined;
    if (flow) {
      if (flow.awaitingOther) {
        await this.answerOther(flow, text);
        return;
      }
      const nums = parseNumericReply(text);
      if (nums) {
        const q = flow.sets[flow.setIndex][flow.qIndex];
        if (nums.every(n => n >= 1 && n <= q.options.length)) {
          if (q.multiSelect) {
            flow.multiSel = nums.map(n => n - 1);
            await this.doneMultiSelect(flow, flow.qIndex);
          } else {
            await this.answerSingle(flow, flow.qIndex, nums[0] - 1);
          }
          return;
        }
      }
    }
    // I comandi del bot sono già gestiti da grammy (bot.command). Quelli che
    // arrivano qui (slash command di Claude: /clear, /compact, /exit,
    // /frontend-release, …) vengono inoltrati alla sessione attiva, slash incluso.
    await this.routeMessageToSession(ctx, text);
  }

  // grammy 1.45: `ctx.getFile()` ritorna i METADATA del file ({ file_id, file_path }),
  // non i byte — i byte vanno scaricati dall'endpoint /file/bot<token>/<file_path>.
  private async downloadTelegramFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.deps.config.telegramBotToken}/${filePath}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Telegram file download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private async onPhoto(ctx: Context): Promise<void> {
    if (!this.authorize(ctx) || !this.requireArmed(ctx)) return;
    const session = this.deps.manager.getActive() ? this.deps.manager.get(this.deps.manager.getActive()!) : this.deps.manager.list()[0];
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
    const s = this.deps.manager.getActive() ? this.deps.manager.get(this.deps.manager.getActive()!) : undefined;
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

  // Allinea l'indicatore "sta scrivendo…" allo stato della sessione attiva.
  private syncTyping(): void {
    const active = this.deps.manager.getActive();
    const s = active ? this.deps.manager.get(active) : undefined;
    if (s?.status === 'running') this.typing.start();
    else this.typing.stop();
  }

  private subscribeBus(): void {
    const bus = this.deps.bus;
    // constraint 8: da disattivo nessun relay — ogni handler del bus è gated su armed.
    bus.on('session.updated', ({ sessionId }) => {
      if (!this.deps.manager.isArmed()) return;
      if (sessionId !== this.deps.manager.getActive()) return;
      this.syncTyping();
    });
    bus.on('session.text', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.sessionId !== this.deps.manager.getActive()) return; // solo la sessione selezionata
      if (e.role === 'assistant') this.typing.stop(); // il testo è già l'indicatore
      // Fix 1: l'echo di un testo iniettato dal bot non viene reinoltrato.
      if (e.role === 'user' && this.isInjectedEcho(e.sessionId, e.text)) {
        this.toolBurst(e.sessionId).close();
        this.resetSummarize(e.sessionId);
        return;
      }
      const burst = this.toolBurst(e.sessionId);
      if (narrationPlan(e.role, e.text, burst.isOpen()) === 'merge') {
        // narrazione breve del modello mentre la bubble tool è aperta: si fonde
        // dentro (niente messaggio extra) — il grouping non si rompe più a ogni
        // "Ora leggo X…" tra una tool call e l'altra.
        void burst.push(mdToHtml(e.text));
        return;
      }
      burst.close();
      this.resetSummarize(e.sessionId);
      // sia le headless che i transcript delle terminali arrivano come markdown.
      void this.forwardText(e.sessionId, mdToHtml(e.text), e.role);
    });
    bus.on('session.prompt', ({ sessionId, questions }) => {
      if (!this.deps.manager.isArmed()) return;
      if (sessionId !== this.deps.manager.getActive()) return;
      this.toolBurst(sessionId).close();
      this.resetSummarize(sessionId);
      // Fix 2: flusso domande multiple — accoda il set e mostra una domanda alla
      // volta (single-select, multi-select con toggle+Done, "Other" a testo libero).
      this.track(this.onSessionPrompt(sessionId, questions), 'prompt flow');
    });
    bus.on('session.tool', e => {
      if (!this.deps.manager.isArmed()) return;
      if (e.kind === 'tool_use' && e.sessionId === this.deps.manager.getActive() && e.input) {
        this.typing.start(); // il modello sta lavorando di nuovo
        // riassunto leggibile via LLM nella lingua della conversazione (niente
        // JSON grezzo); fallback a summarizeTool se Ollama non risponde.
        const session = this.deps.manager.get(e.sessionId);
        const model = session?.model ?? this.deps.config.defaultModel;
        const hint = this.lastUserText.get(e.sessionId);
        this.summarizeToolLine(e.sessionId, model, e.toolName, e.input, hint);
      }
    });
    bus.on('session.permission', ({ permission }) => {
      if (!this.deps.manager.isArmed()) return;
      this.toolBurst(permission.sessionId).close();
      this.resetSummarize(permission.sessionId);
      const kb = permissionKeyboard(permission);
      if (this.chatId) {
        this.track(this.sendChunked(this.chatId, permissionMessage(permission), { reply_markup: kb }), 'permission send');
      }
    });
    bus.on('session.dialog', ({ sessionId, dialog }) => {
      if (!this.deps.manager.isArmed()) return;
      this.toolBurst(sessionId).close();
      this.resetSummarize(sessionId);
      this.track(this.onSessionDialog(sessionId, dialog), 'dialog send');
    });
    bus.on('session.result', e => {
      if (!this.deps.manager.isArmed() || e.sessionId !== this.deps.manager.getActive()) return;
      this.typing.stop(); // fine turno: niente più "sta scrivendo"
      this.toolBurst(e.sessionId).close(); // fine turno headless: chiude la raffica di tool
      this.resetSummarize(e.sessionId); // scarta le summary pendenti
      // solo segnale di completamento: il testo della risposta è già arrivato
      // streammato (session.text → mdToHtml). Re-inviarlo qui (come faceva la
      // vecchia notifica `✅ <result>`) duplicava l'ultimo messaggio, e senza
      // rendering markdown (htmlEscape soltanto).
      this.notify('✅ Turn complete.');
    });
    bus.on('session.error', e => {
      if (!this.deps.manager.isArmed() || e.sessionId !== this.deps.manager.getActive()) return;
      this.typing.stop(); // errore: niente più "sta scrivendo"
      this.toolBurst(e.sessionId).close();
      this.resetSummarize(e.sessionId);
      const flow = this.questionFlows.get(e.sessionId);
      if (flow) this.deleteFlow(flow); // errore: niente domande pendenti
      this.pendingPlanEdits.delete(e.sessionId);
      this.notify(`❌ <b>${htmlEscape(e.message.slice(0, 500))}</b>`);
    });
  }
}
