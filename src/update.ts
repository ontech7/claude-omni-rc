import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Check versione su GitHub, stesso schema di ollama-usage/update.py: al più
// una fetch ogni 24h, una notifica per versione (stato su disco, best-effort).
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RELEASES_URL = 'https://github.com/ontech7/claude-omni-rc/releases';
const RELEASES_API_URL = 'https://api.github.com/repos/ontech7/claude-omni-rc/releases/latest';

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
export const CURRENT_VERSION: string = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;

interface UpdateState {
  lastCheck?: number;
  latestVersion?: string;
  notifiedVersion?: string;
}

// Normalizza 'v0.1.4' -> [0,1,4]. undefined se non è una versione dotted-numeric.
function parseVersion(version: string): number[] | undefined {
  if (typeof version !== 'string') return undefined;
  const text = version.replace(/^v/i, '').trim();
  if (!text) return undefined;
  const parts = text.split('.');
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return undefined;
    nums.push(Number(p));
  }
  return nums;
}

export function isNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const a = l[i] ?? 0, b = c[i] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function readState(path: string): UpdateState {
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return typeof data === 'object' && data ? data : {};
  } catch {
    return {};
  }
}

function writeState(path: string, state: UpdateState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    // cache best-effort, come in ollama-usage
  }
}

export type FetchLatest = (url: string) => Promise<string | undefined>;

// Non lancia mai: offline, DNS, JSON malformato -> undefined.
export const fetchLatestVersion: FetchLatest = async (url) => {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': `claude-omni-rc/${CURRENT_VERSION}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { tag_name?: unknown };
    return typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/i, '') : undefined;
  } catch {
    return undefined;
  }
};

export interface CheckForUpdateDeps {
  statePath: string;
  disabled?: boolean;
  now?: number;
  fetch?: FetchLatest;
  url?: string;
}

// Ritorna la versione da notificare, o undefined. Non lancia mai.
export async function checkForUpdate(deps: CheckForUpdateDeps): Promise<string | undefined> {
  if (deps.disabled) return undefined;
  const now = deps.now ?? Date.now();
  const fetchFn = deps.fetch ?? fetchLatestVersion;
  const state = readState(deps.statePath);
  const fresh = typeof state.lastCheck === 'number' && now - state.lastCheck < CHECK_INTERVAL_MS;
  let latest = state.latestVersion;
  if (!fresh) {
    const fetched = await fetchFn(deps.url ?? RELEASES_API_URL).catch(() => undefined);
    const next: UpdateState = { ...state, lastCheck: now };
    if (fetched) next.latestVersion = fetched;
    writeState(deps.statePath, next);
    if (fetched) latest = fetched;
  }
  if (!latest || latest === state.notifiedVersion || !isNewer(latest, CURRENT_VERSION)) return undefined;
  return latest;
}

export function markNotified(statePath: string, version: string): void {
  writeState(statePath, { ...readState(statePath), notifiedVersion: version });
}
