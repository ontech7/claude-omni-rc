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
  const protect = (c: string, kind: 'pre' | 'code', lang?: string): string => {
    const idx = blocks.length;
    blocks.push(
      kind === 'pre'
        ? (lang ? `<pre><code class="language-${lang}">${c}</code></pre>` : `<pre>${c}</pre>`)
        : `<code>${c}</code>`);
    return `${P}${idx}${P}`;
  };
  let out = htmlEscape(text);
  // The fence's first line is its info string: only a plausible single-token
  // language earns a class. Anything with spaces ('non un linguaggio') keeps
  // the classless <pre>, because a bogus class buys nothing and costs width.
  out = out.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_m, first: string, c: string) =>
    protect(c, 'pre', /^[a-z0-9+#-]{1,20}$/.test(first) ? first : undefined));
  out = out.replace(/`([^`\n]+)`/g, (_m, c) => protect(c, 'code'));
  // A table is readable on Telegram only at fixed width: <pre> is the one
  // container that preserves it. Columns are capped because on a narrow screen
  // one long cell would wrap the whole grid. This runs right after code
  // protection so a pipe inside a fence is already a placeholder and never
  // looks like a table — and the <pre> it builds goes through the same
  // protection, so it cannot end up inside a blockquote either.
  const CELL_MAX = 24;
  out = out.replace(/(?:^\|.*\|[ \t]*\n?){2,}/gm, table => {
    const rows = table.trimEnd().split('\n')
      .map(r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
    // the separator row ('---', ':--') is not data: it disappears
    const body = rows.filter(r => !r.every(c => /^:?-{2,}:?$/.test(c)));
    if (body.length < 2) return table;
    const cols = Math.max(...body.map(r => r.length));
    const width: number[] = [];
    for (let c = 0; c < cols; c++) {
      width[c] = Math.min(CELL_MAX, Math.max(...body.map(r => (r[c] ?? '').length)));
    }
    const rendered = body
      .map(r => Array.from({ length: cols }, (_, c) => (r[c] ?? '').slice(0, CELL_MAX).padEnd(width[c])).join(' | ').trimEnd())
      .join('\n');
    return `${protect(rendered, 'pre')}\n`;
  });
  out = out
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>');
  // Nested lists need their own pass: the flat rule below anchors at the line
  // start, so an indented item is invisible to it. The two rules do not
  // overlap, so their order does not matter.
  out = out.replace(/^ {2,}[-*]\s+(.+)$/gm, '  ◦ $1');
  out = out.replace(/^[-*]\s+(.+)$/gm, '• $1');
  out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  out = out.replace(/^(?:-{3,}|\*{3,})$/gm, '——————');
  // Quotes: consecutive '>' lines become a single blockquote. Code blocks are
  // already safe inside placeholders, so a <pre> can never end up in here.
  out = out.replace(/(?:^&gt;\s?.*(?:\n|$))+/gm, m => {
    const body = m.replace(/^&gt;\s?/gm, '').replace(/\n$/, '');
    return `<blockquote>${body}</blockquote>\n`;
  });
  // A blank line before a heading separates sections in a linear chat; the
  // replacement adds it because the line itself carries no preceding space.
  out = out.replace(/^#{1,6}\s+([^<\n]+)$/gm, '\n<b>$1</b>');
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
  // Fresh regex per call: HTML_TAG is global and sharing its lastIndex across
  // re-entrant functions would be an ordering bug.
  const re = new RegExp(HTML_TAG.source, 'g');
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
// The tag list is this module's invariant: mdToHtml may only emit tags that
// appear here, because balanceHtml and splitHtmlMessage reason over this same
// list. A tag emitted but not listed crosses the split without being reopened:
// the message comes out malformed, Telegram rejects it, and the send — which
// sits inside a .catch() — drops it in silence.
const TAG_NAMES = 'b|i|code|pre|a|blockquote|s|u';
const HTML_TAG = new RegExp(`</?(${TAG_NAMES})(?:\\s[^>]*)?>`, 'g');

export function splitHtmlMessage(html: string, max = SEND_MAX_CHARS): string[] {
  if (html.length <= max) return [html];

  // tokenizza in tag e testo: un tag non va mai spezzato a metà
  const tokens: { tag?: string; text?: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(HTML_TAG.source, 'g');
  while ((m = re.exec(html)) !== null) {
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

export interface AgentCard {
  subagentType?: string;
  description?: string;
  lines: string[];
  expanded: boolean;
  toolUses?: number;
  durationMs?: number;
  lastToolName?: string;
  status?: 'running' | 'completed' | 'failed' | 'killed';
  error?: string;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// A linear chat has no panels: the card is the only place where a subagent's
// activity can live without mixing into everything else. Collapsed it says only
// that it is working and how far it got; the details stay one tap away.
export function renderAgentCard(card: AgentCard): string {
  const icon = card.status === 'completed' ? '✅' : card.status === 'failed' || card.status === 'killed' ? '❌' : '⏳';
  const who = card.subagentType ? ` · <code>${htmlEscape(card.subagentType)}</code>` : '';
  const what = card.description ? ` — ${htmlEscape(truncateAtWord(card.description, 100))}` : '';
  const bits: string[] = [];
  if (card.toolUses !== undefined) bits.push(`${card.toolUses} steps`);
  if (card.durationMs !== undefined) bits.push(formatDuration(card.durationMs));
  if (card.status === 'running' && card.lastToolName) bits.push(htmlEscape(card.lastToolName));
  if (card.error) bits.push(htmlEscape(truncateAtWord(card.error, 100)));
  let out = `🤖 <b>Agent</b>${who}${what}\n${icon} ${bits.join(' · ') || '…'}`;
  if (card.expanded && card.lines.length) out += `\n<blockquote expandable>${card.lines.join('\n\n')}</blockquote>`;
  return out;
}
