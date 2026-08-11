import { describe, it, expect } from 'vitest';
import { mdToHtml, balanceHtml, splitHtmlMessage, truncateAtWord, htmlEscape, shortenPath, describeTool, renderToolLine } from '../bot/render.js';

describe('mdToHtml v2 / balanceHtml', () => {
  it('renders bold, italic and nested ***both***', () => {
    expect(mdToHtml('**bold** and *it*')).toBe('<b>bold</b> and <i>it</i>');
    expect(mdToHtml('***both***')).toBe('<b><i>both</i></b>');
  });
  it('protects code blocks and inline code from formatting', () => {
    expect(mdToHtml('`**code**`')).toBe('<code>**code**</code>');
    expect(mdToHtml('```js\n# h\n**x**\n```')).toBe('<pre><code class="language-js"># h\n**x**\n</code></pre>');
  });
  it('converts headings outside code to bold', () => {
    expect(mdToHtml('# not a heading')).toBe('\n<b>not a heading</b>');
  });
  it('does not double-wrap a heading that contains bold', () => {
    expect(mdToHtml('# **title**')).toBe('# <b>title</b>');
    expect(mdToHtml('# plain')).toBe('\n<b>plain</b>');
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

  it('handles HOME="/" without matching every absolute path', () => {
    const oldHome = process.env.HOME;
    try {
      process.env.HOME = '/';
      // With HOME='/', a path like '/etc/hosts' should stay absolute, not become '~/etc/hosts'
      expect(shortenPath('/etc/hosts', proj)).toBe('/etc/hosts');
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it('returns only the filename when it fits in maxLen and first/…/last does not', () => {
    // Create a path where even first/…/last exceeds maxLen, so we get just the filename
    const longPath = proj + '/very/long/nested/directory/structure/file.ts';
    const out = shortenPath(longPath, proj, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).toBe('file.ts');
  });

  it('truncates the filename with … when even the filename exceeds maxLen', () => {
    // Create a path where even the filename alone exceeds maxLen
    const veryLongFileName = proj + '/' + 'x'.repeat(20) + '.ts';
    const out = shortenPath(veryLongFileName, proj, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out).toContain('…');
    expect(out).toContain('.ts');
  });
});

describe('describeTool', () => {
  const proj = '/Users/tizio/Progetti/app';

  it('uses Bash description, not command', () => {
    const l = describeTool('Bash', { command: 'cd /Users/tizio/Progetti/app && npm ci', description: 'Install dependencies' }, proj);
    expect(l.label).toBe('Bash');
    expect(l.detail).toBe('Install dependencies');
    expect(l.code).toContain('npm ci');
  });

  it('falls back to command if description is missing', () => {
    const l = describeTool('Bash', { command: 'ls -la' }, proj);
    expect(l.detail).toBe('ls -la');
  });

  it('shortens the Read path', () => {
    expect(describeTool('Read', { file_path: `${proj}/bot/telegram.ts` }, proj).target).toBe('bot/telegram.ts');
  });

  it('distinguishes Write from Edit', () => {
    expect(describeTool('Write', { file_path: `${proj}/a.ts` }, proj).label).toBe('Write');
    expect(describeTool('Edit', { file_path: `${proj}/a.ts` }, proj).label).toBe('Edit');
  });

  it('reports line range of Read when present', () => {
    expect(describeTool('Read', { file_path: `${proj}/a.ts`, offset: 10, limit: 5 }, proj).detail).toBe('lines 10–14');
  });

  it('recognizes a Skill', () => {
    const l = describeTool('Skill', { skill: 'editing-the-landing-page' }, proj);
    expect(l.label).toBe('Skill');
    expect(l.target).toBe('editing-the-landing-page');
  });

  it('parses MCP tool name', () => {
    const l = describeTool('mcp__context7__query-docs', { query: 'how to use X' }, proj);
    expect(l.label).toBe('MCP context7');
    expect(l.target).toBe('query-docs');
    expect(l.detail).toBe('how to use X');
  });

  it('handles MCP server name with underscore', () => {
    const l = describeTool('mcp__my_server__do_thing', {}, proj);
    expect(l.label).toBe('MCP my_server');
    expect(l.target).toBe('do_thing');
  });

  it('skips non-descriptive keys for MCP tool detail', () => {
    expect(describeTool('mcp__ctx__q', { libraryId: '/org/p', query: 'real intent' }, proj).detail).toBe('real intent');
  });

  it('describes a subagent', () => {
    const l = describeTool('Task', { subagent_type: 'Explore', description: 'find rendering points' }, proj);
    expect(l.target).toBe('Explore');
    expect(l.detail).toBe('find rendering points');
  });

  it('counts todos and shows current item', () => {
    const l = describeTool('TodoWrite', { todos: [
      { content: 'a', status: 'completed' },
      { content: 'look here', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ] }, proj);
    expect(l.target).toBe('1/3');
    expect(l.detail).toBe('look here');
  });

  it('falls back to first string value for unknown tool', () => {
    const l = describeTool('SomethingNew', { foo: 'useful value' }, proj);
    expect(l.label).toBe('SomethingNew');
    expect(l.detail).toBe('useful value');
  });

  it('does not throw on empty input', () => {
    expect(() => describeTool('Boh', {}, proj)).not.toThrow();
  });
});

describe('renderToolLine', () => {
  it('composes icon, label, target and detail', () => {
    const out = renderToolLine({ icon: '📖', label: 'Read', target: 'bot/telegram.ts', detail: 'lines 1–20' });
    expect(out).toBe('📖 <b>Read</b> · <code>bot/telegram.ts</code> — lines 1–20');
  });

  it('skips missing parts', () => {
    expect(renderToolLine({ icon: '⚙️', label: 'Boh' })).toBe('⚙️ <b>Boh</b>');
  });

  it('escapes dynamic fragments', () => {
    const out = renderToolLine({ icon: '⚡', label: 'Bash', detail: 'a < b & c' });
    expect(out).toContain('a &lt; b &amp; c');
    expect(out).not.toContain('a < b');
  });

  it('puts command on second line in code', () => {
    const out = renderToolLine({ icon: '⚡', label: 'Bash', detail: 'Install', code: 'npm ci' });
    expect(out).toBe('⚡ <b>Bash</b> — Install\n<code>npm ci</code>');
  });
});

describe('mdToHtml — added constructs', () => {
  it('puts the language on the code block', () => {
    expect(mdToHtml('```ts\nconst a = 1\n```')).toContain('<pre><code class="language-ts">');
  });

  it('ignores an implausible language', () => {
    expect(mdToHtml('```non un linguaggio\nx\n```')).toContain('<pre>');
    expect(mdToHtml('```non un linguaggio\nx\n```')).not.toContain('class="language-');
  });

  it('renders quotes and merges consecutive lines', () => {
    const out = mdToHtml('> prima\n> seconda');
    expect(out).toContain('<blockquote>');
    expect((out.match(/<blockquote>/g) ?? []).length).toBe(1);
  });

  it('renders strikethrough', () => {
    expect(mdToHtml('~~via~~')).toContain('<s>via</s>');
  });

  it('preserves ordered lists', () => {
    expect(mdToHtml('1. primo\n2. secondo')).toContain('1. primo');
  });

  it('indents nested lists', () => {
    expect(mdToHtml('- a\n  - b')).toContain('◦ b');
  });

  it('never produces a pre inside a blockquote', () => {
    // Telegram rejects the combination: the renderer must not generate it.
    const out = mdToHtml('> cit\n\n```\ncodice\n```');
    expect(/<blockquote>(?:(?!<\/blockquote>)[\s\S])*<pre>/.test(out)).toBe(false);
  });

  it('aligns tables in a pre block', () => {
    const out = mdToHtml('| tool | uso |\n|---|---|\n| Read | file |\n| Bash | comandi |');
    expect(out).toContain('<pre>');
    expect(out).not.toContain('|---|');            // the separator row disappears
    expect(out).toMatch(/tool\s+\|\s+uso/);        // columns aligned at fixed width
    expect(out).toContain('Bash');
  });

  it('separates headings with a blank line', () => {
    expect(mdToHtml('testo\n## Titolo')).toContain('\n\n<b>Titolo</b>');
  });
});

describe('tag invariant on split and balancing', () => {
  it('balances an unclosed blockquote', () => {
    expect(balanceHtml('<blockquote>testo')).toBe('<blockquote>testo</blockquote>');
  });

  it('splits a long blockquote without losing text or unbalancing tags', () => {
    const inner = Array.from({ length: 500 }, (_, i) => `riga ${i}`).join('\n');
    const parts = splitHtmlMessage(`<blockquote>${inner}</blockquote>`);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3800);
      expect(balanceHtml(p)).toBe(p);              // every chunk is already valid
      expect(p.startsWith('<blockquote>')).toBe(true); // tag reopened at each chunk
    }
    expect(parts.join('')).toContain('riga 499');  // the tail is not lost
  });
});
