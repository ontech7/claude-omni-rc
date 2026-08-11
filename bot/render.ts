// Pure presentation for Telegram chat: markdown → HTML, tag balancing and
// splitting, tool call descriptions. No I/O and no state, so each formatting
// rule can be tested as input → output rather than through the bot.

// parse_mode 'HTML' rigetta markup malformato (es. '<b' sbilanciato) e il send è
// dentro .catch(()=>{}) → il messaggio sparirebbe in silenzio. Escapare ogni frammento
// dinamico prima di interpolarlo nei template HTML.
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

// Tronca preferendo un confine di parola (se cade oltre metà del budget): mai
// tagli a metà stringa, con un marcatore esplicito di troncamento.
export function truncateAtWord(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  const end = sp > max * 0.5 ? sp : max;
  return s.slice(0, end).trimEnd() + '… (truncated)';
}

// Absolute paths are the main reason tool calls become unreadable in chat:
// '/Users/tizio/Progetti/app/bot/telegram.ts' conveys much less than
// 'bot/telegram.ts'. The boundary is the separator, not the prefix: without
// checking for '/' a sibling directory ('app-2') would be shortened as if it
// were inside the project.
export function shortenPath(p: string, projectDir?: string, maxLen = 50): string {
  if (!p) return '';
  let out = p;
  const strip = (base: string | undefined, replacement: string): boolean => {
    if (!base) return false;
    const b = base.endsWith('/') ? base.slice(0, -1) : base;
    if (!b) return false; // Prevent empty base (e.g., from HOME='/') from matching all absolute paths
    if (out === b) { out = replacement || '.'; return true; }
    if (out.startsWith(`${b}/`)) { out = replacement + out.slice(b.length + (replacement ? 0 : 1)); return true; }
    return false;
  };
  if (!strip(projectDir, '')) strip(process.env.HOME, '~');
  if (out.length <= maxLen) return out;
  // Elision in the middle: the tail (filename) is the part that identifies
  // the line, the head provides context. The middle is what can be sacrificed.
  const parts = out.split('/');
  const last = parts[parts.length - 1];
  const first = parts.length > 1 ? parts[0] : '';
  const candidate = first ? `${first}/…/${last}` : `…/${last}`;
  if (candidate.length <= maxLen) return candidate;
  return last.length <= maxLen ? last : `…${last.slice(-(maxLen - 1))}`;
}

export interface ToolLine {
  icon: string;
  label: string;     // Fixed label, always in English
  target?: string;   // Rendered inside <code>
  detail?: string;   // Free-form text, may be in the model's language
  code?: string;     // Bash only: the command, on a separate line
}

const DETAIL_MAX = 100;
const CODE_MAX = 200;

// Keys that identify a resource instead of describing intent: fields like
// `detail` of an MCP tool tell nothing to the human reading the chat.
const OPAQUE_KEYS = new Set(['libraryid', 'id', 'token', 'apikey', 'signal', 'uuid', 'sessionid']);

function firstMeaningfulString(input: Record<string, unknown>): string | undefined {
  for (const [k, v] of Object.entries(input)) {
    if (OPAQUE_KEYS.has(k.toLowerCase())) continue;
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function str(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

// The CLI always writes a `description` on Bash tool calls ("Install
// dependencies"): a human-friendly phrase, while `command` is the raw reason
// the chat became unreadable. Description wins, the command stays below for
// those who want the detail.
export function describeTool(toolName: string, input: Record<string, unknown>, projectDir?: string): ToolLine {
  const name = toolName.toLowerCase();
  const path = (...keys: string[]): string | undefined => {
    const p = str(input, ...keys);
    return p ? shortenPath(p, projectDir) : undefined;
  };

  if (name.startsWith('mcp__')) {
    const rest = toolName.slice('mcp__'.length);
    const cut = rest.lastIndexOf('__');
    const server = cut === -1 ? rest : rest.slice(0, cut);
    const tool = cut === -1 ? undefined : rest.slice(cut + 2);
    return { icon: '🔌', label: `MCP ${server}`, target: tool, detail: firstMeaningfulString(input) };
  }

  switch (name) {
    case 'bash': {
      const cmd = str(input, 'command');
      return { icon: '⚡', label: 'Bash', detail: str(input, 'description') ?? cmd, code: cmd };
    }
    case 'read': case 'readfile': {
      const offset = typeof input.offset === 'number' ? input.offset : undefined;
      const limit = typeof input.limit === 'number' ? input.limit : undefined;
      const range = offset !== undefined && limit !== undefined ? `lines ${offset}–${offset + limit - 1}` : undefined;
      return { icon: '📖', label: 'Read', target: path('file_path', 'path'), detail: range };
    }
    case 'write': case 'writefile':
      return { icon: '📝', label: 'Write', target: path('file_path', 'path') };
    case 'edit': case 'multiedit':
      return { icon: '✏️', label: 'Edit', target: path('file_path', 'path'), detail: input.replace_all === true ? 'replace all' : undefined };
    case 'notebookedit':
      return { icon: '📓', label: 'Notebook', target: path('notebook_path', 'path') };
    case 'glob':
      return { icon: '🔍', label: 'Glob', target: str(input, 'pattern'), detail: path('path') };
    case 'grep':
      return { icon: '🔎', label: 'Grep', target: str(input, 'pattern'), detail: path('path') };
    case 'webfetch': {
      const url = str(input, 'url');
      let host = url;
      try { if (url) host = new URL(url).hostname; } catch { /* Malformed URL: keep raw text */ }
      return { icon: '🌐', label: 'Fetch', target: host, detail: str(input, 'prompt') };
    }
    case 'websearch':
      return { icon: '🔎', label: 'Search', target: str(input, 'query') };
    case 'task':
      return { icon: '🤖', label: 'Agent', target: str(input, 'subagent_type'), detail: str(input, 'description') };
    case 'skill':
      return { icon: '🧩', label: 'Skill', target: str(input, 'skill'), detail: str(input, 'args') };
    case 'slashcommand':
      return { icon: '⌨️', label: 'Command', target: str(input, 'command') };
    case 'workflow':
      return { icon: '🎛', label: 'Workflow', target: str(input, 'name'), detail: str(input, 'description') };
    case 'exitplanmode':
      return { icon: '📋', label: 'Plan' };
    case 'todowrite': case 'todoread': {
      const todos = Array.isArray(input.todos) ? input.todos as { content?: unknown; status?: unknown }[] : [];
      const done = todos.filter(t => t?.status === 'completed').length;
      const current = todos.find(t => t?.status === 'in_progress');
      return {
        icon: '📋', label: 'Todo',
        target: todos.length ? `${done}/${todos.length}` : undefined,
        detail: typeof current?.content === 'string' ? current.content : undefined,
      };
    }
    default:
      return { icon: '⚙️', label: toolName, detail: firstMeaningfulString(input) };
  }
}

export function renderToolLine(line: ToolLine): string {
  let out = `${line.icon} <b>${htmlEscape(line.label)}</b>`;
  if (line.target) out += ` · <code>${htmlEscape(truncateAtWord(line.target, DETAIL_MAX))}</code>`;
  if (line.detail) out += ` — ${htmlEscape(truncateAtWord(line.detail, DETAIL_MAX))}`;
  if (line.code) out += `\n<code>${htmlEscape(truncateAtWord(line.code, CODE_MAX))}</code>`;
  return out;
}
