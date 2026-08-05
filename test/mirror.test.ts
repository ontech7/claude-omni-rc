import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bus } from '../src/bus.js';
import { loadConfig } from '../src/config.js';
import { StateStore } from '../src/state.js';
import { SessionManager } from '../src/sessions/manager.js';
import { JsonlMirror, encodeProjectPath, decodeProjectDir, parseLine } from '../src/sessions/mirror.js';

function makeMirror(tmuxSessions: string[] = []) {
  const bus = new Bus();
  const events: unknown[] = [];
  bus.on('session.text', e => events.push(e));
  bus.on('session.tool', e => events.push(e));
  const dir = mkdtempSync(join(tmpdir(), 'orc-mirror-'));
  const projectsDir = join(dir, 'projects');
  const config = loadConfig({ STATE_DIR: dir, PROJECTS_DIR: projectsDir });
  const state = new StateStore(join(dir, 'state.json'));
  const manager = new SessionManager({ bus, state, idleGraceMs: 3000, armedOnStart: false });
  const tmux = { listSessions: vi.fn(async () => tmuxSessions) };
  const mirror = new JsonlMirror({ bus, manager, config, tmux: tmux as any });
  return { bus, events, manager, mirror, dir, projectsDir };
}

describe('project path encoding', () => {
  it('encodes project paths to Claude Code dir names', () => {
    expect(encodeProjectPath('/private/tmp/ollama-rc-sdk-spike')).toBe('-private-tmp-ollama-rc-sdk-spike');
    expect(encodeProjectPath('/work/auto')).toBe('-work-auto');
  });
  it('decode is the inverse of encode on the encoded space (lossy on literal dashes)', () => {
    // decode è best-effort: i trattini letterali del path originale non sono recuperabili,
    // ma encode(decode(encoded)) === encoded vale SEMPRE — è il contratto del matching.
    expect(decodeProjectDir('-private-tmp-ollama-rc-sdk-spike')).toBe('/private/tmp/ollama/rc/sdk/spike');
    expect(encodeProjectPath(decodeProjectDir('-private-tmp-ollama-rc-sdk-spike'))).toBe('-private-tmp-ollama-rc-sdk-spike');
  });
});

describe('parseLine', () => {
  it('extracts assistant text', () => {
    const line = JSON.stringify({ parentUuid: null, message: { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ciao' }] } });
    expect(parseLine(line)).toEqual([{ type: 'session.text', role: 'assistant', text: 'ciao' }]);
  });
  it('extracts tool_use and tool_result blocks', () => {
    const use = JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    const res = JSON.stringify({ message: { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'out', is_error: false }] } });
    expect(parseLine(use)).toEqual([{ type: 'session.tool', kind: 'tool_use', toolName: 'Bash', toolUseId: 't1', input: { command: 'ls' } }]);
    expect(parseLine(res)).toEqual([{ type: 'session.tool', kind: 'tool_result', toolUseId: 't1', result: 'out', isError: false }]);
  });
  it('returns null for non-message lines', () => {
    expect(parseLine(JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }))).toBeNull();
    expect(parseLine(JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' }))).toBeNull();
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('')).toBeNull();
  });
});

describe('JsonlMirror', () => {
  it('reads new lines from offset and emits events for a registered session', () => {
    const { manager, mirror, projectsDir, dir, events } = makeMirror();
    const projDir = join(dir, 'proj');
    const encoded = encodeProjectPath(projDir);
    const s = manager.registerTerminal({ title: 'proj', projectDir: projDir, tmuxTarget: 'claude:proj' });
    manager.setArmed(true);
    // simula ~/.claude/projects/<encoded>/session.jsonl
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, 'a.jsonl');
    writeFileSync(file, '{"type":"queue-operation"}\n' + JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'primo' }] } }) + '\n');
    mirror.poll();
    expect(events.filter(e => (e as any).text === 'primo')).toHaveLength(1);
    expect(manager.get(s.id)!.status).toBe('running');
    // seconda poll: nessun duplicato
    mirror.poll();
    expect(events.filter(e => (e as any).text === 'primo')).toHaveLength(1);
  });
  it('is a no-op when disarmed', () => {
    const { manager, mirror, projectsDir, dir, events } = makeMirror();
    const projDir = join(dir, 'proj');
    const encoded = encodeProjectPath(projDir);
    manager.registerTerminal({ title: 'proj', projectDir: projDir, tmuxTarget: 'claude:proj' });
    manager.setArmed(false);
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'a.jsonl'), JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'x' }] } }));
    mirror.poll();
    expect(events).toHaveLength(0);
  });
  it('auto-registers a terminal session and emits the discovered events', async () => {
    const { manager, mirror, projectsDir, dir, events } = makeMirror(['claude:auto']);
    manager.setArmed(true);
    const encoded = encodeProjectPath('/work/auto');
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'a.jsonl'), JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    mirror.poll();
    await vi.waitFor(() => expect(manager.findByTmuxTarget('claude:auto')).toBeDefined());
    // il primo batch letto in questa poll viene emesso dopo la registrazione (non perso)
    await vi.waitFor(() => expect(events.some(e => (e as any).text === 'hi')).toBe(true));
  });
  it('does not lose a partial trailing line across polls', () => {
    const { manager, mirror, projectsDir, dir, events } = makeMirror();
    const projDir = join(dir, 'proj');
    const encoded = encodeProjectPath(projDir);
    manager.registerTerminal({ title: 'proj', projectDir: projDir, tmuxTarget: 'claude:proj' });
    manager.setArmed(true);
    const sessionDir = join(projectsDir, encoded);
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, 'a.jsonl');
    const full = JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'parziale' }] } }) + '\n';
    writeFileSync(file, full.slice(0, 20)); // prima metà, senza \n
    mirror.poll();
    expect(events).toHaveLength(0); // riga incompleta: non consumata
    appendFileSync(file, full.slice(20)); // append del resto
    mirror.poll();
    expect(events.filter(e => (e as any).text === 'parziale')).toHaveLength(1);
  });
  it('persists mirror offsets to disk after the debounce', () => {
    vi.useFakeTimers();
    try {
      const { manager, mirror, projectsDir, dir } = makeMirror();
      const projDir = join(dir, 'proj');
      const encoded = encodeProjectPath(projDir);
      manager.registerTerminal({ title: 'proj', projectDir: projDir, tmuxTarget: 'claude:proj' });
      manager.setArmed(true);
      const sessionDir = join(projectsDir, encoded);
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'a.jsonl'), JSON.stringify({ message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'x' }] } }) + '\n');
      mirror.poll();
      vi.advanceTimersByTime(2100);
      const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      expect(Object.keys(state.mirrorOffsets).length).toBeGreaterThan(0);
    } finally { vi.useRealTimers(); }
  });
});
