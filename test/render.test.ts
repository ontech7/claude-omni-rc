import { describe, it, expect } from 'vitest';
import { mdToHtml, balanceHtml, splitHtmlMessage, truncateAtWord, htmlEscape, shortenPath } from '../bot/render.js';

describe('mdToHtml v2 / balanceHtml', () => {
  it('renders bold, italic and nested ***both***', () => {
    expect(mdToHtml('**bold** and *it*')).toBe('<b>bold</b> and <i>it</i>');
    expect(mdToHtml('***both***')).toBe('<b><i>both</i></b>');
  });
  it('protects code blocks and inline code from formatting', () => {
    expect(mdToHtml('`**code**`')).toBe('<code>**code**</code>');
    expect(mdToHtml('```js\n# h\n**x**\n```')).toBe('<pre>js\n# h\n**x**\n</pre>');
  });
  it('converts headings outside code to bold', () => {
    expect(mdToHtml('# not a heading')).toBe('<b>not a heading</b>');
  });
  it('does not double-wrap a heading that contains bold', () => {
    expect(mdToHtml('# **title**')).toBe('# <b>title</b>');
    expect(mdToHtml('# plain')).toBe('<b>plain</b>');
  });
  it('leaves unclosed markers literal (no unbalanced HTML)', () => {
    expect(mdToHtml('**unclosed')).toBe('**unclosed');
  });
  it('escapes raw HTML and renders links', () => {
    expect(mdToHtml('<b>')).toBe('&lt;b&gt;');
    expect(mdToHtml('[t](https://x.com)')).toBe('<a href="https://x.com">t</a>');
  });
  it('balanceHtml closes unclosed tags, drops orphan closes, keeps valid HTML', () => {
    expect(balanceHtml('<b>a')).toBe('<b>a</b>');
    expect(balanceHtml('<b><i>x</b>')).toBe('<b><i>x</i></b>');
    expect(balanceHtml('x</i>y')).toBe('xy');
    expect(balanceHtml('<b>ok</b>')).toBe('<b>ok</b>');
  });
});

describe('splitHtmlMessage', () => {
  it('returns a single chunk when the text fits', () => {
    expect(splitHtmlMessage('hello', 100)).toEqual(['hello']);
  });
  it('never emits a chunk longer than max', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    for (const c of splitHtmlMessage(long, 200)) expect(c.length).toBeLessThanOrEqual(200);
  });
  it('loses no visible text across the split', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const joined = splitHtmlMessage(long, 100).join('\n');
    expect(joined.replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });
  it('prefers breaking at a newline', () => {
    const text = `${'a'.repeat(40)}\n${'b'.repeat(40)}`;
    const parts = splitHtmlMessage(text, 50);
    expect(parts[0]).toBe('a'.repeat(40));
    expect(parts[1]).toBe('b'.repeat(40));
  });
  it('closes and reopens an open tag across the boundary', () => {
    const text = `<pre>${'a'.repeat(60)}\n${'b'.repeat(60)}</pre>`;
    const parts = splitHtmlMessage(text, 80);
    expect(parts).toHaveLength(2);
    expect(parts[0].startsWith('<pre>')).toBe(true);
    expect(parts[0].endsWith('</pre>')).toBe(true);
    expect(parts[1].startsWith('<pre>')).toBe(true);
    expect(parts[1].endsWith('</pre>')).toBe(true);
  });
  it('never splits inside a tag', () => {
    const text = `<a href="https://example.com/very/long/path">${'x'.repeat(80)}</a>`;
    for (const c of splitHtmlMessage(text, 60)) {
      expect((c.match(/</g) ?? []).length).toBe((c.match(/>/g) ?? []).length);
    }
  });
  it('hard-splits a single word with no break opportunity', () => {
    const parts = splitHtmlMessage('x'.repeat(250), 100);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe('x'.repeat(250));
  });
});

describe('shortenPath', () => {
  const proj = '/Users/tizio/Progetti/app';

  it('renders relative a path inside the project', () => {
    expect(shortenPath(`${proj}/bot/telegram.ts`, proj)).toBe('bot/telegram.ts');
  });

  it('does not confuse a sibling directory with the project prefix', () => {
    // '/Users/tizio/Progetti/app-2' starts with '/Users/tizio/Progetti/app'
    expect(shortenPath('/Users/tizio/Progetti/app-2/x.ts', proj)).toContain('app-2');
  });

  it('replaces home with ~ outside the project', () => {
    const home = process.env.HOME ?? '/Users/tizio';
    expect(shortenPath(`${home}/altrove/nota.md`, proj)).toBe('~/altrove/nota.md');
  });

  it('leaves a path absolute when outside project and home', () => {
    expect(shortenPath('/etc/hosts', proj)).toBe('/etc/hosts');
  });

  it('elides middle segments beyond maxLen while keeping the filename', () => {
    const lungo = `${proj}/` + 'segmento/'.repeat(12) + 'finale.ts';
    const out = shortenPath(lungo, proj, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toContain('…');
    expect(out.endsWith('finale.ts')).toBe(true);
  });

  it('returns empty string for empty input', () => {
    expect(shortenPath('', proj)).toBe('');
  });

  it('works without projectDir', () => {
    expect(shortenPath('/etc/hosts')).toBe('/etc/hosts');
  });
});
