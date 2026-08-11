// Presentazione pura per la chat Telegram: markdown → HTML, bilanciamento e
// split dei tag, descrizione delle tool call. Nessun I/O e nessuno stato, così
// ogni regola di formattazione si testa come input → output invece che
// attraverso il bot.

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
