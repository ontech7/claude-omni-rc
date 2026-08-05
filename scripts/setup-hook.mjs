#!/usr/bin/env node
// Adds the ollama-rc SessionStart hook to a Claude Code settings.json,
// preserving everything already there. Idempotent: a second run is a no-op.
//
// Usage: node setup-hook.mjs <settings.json path> <attach-script path>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [settingsPath, attachScript] = process.argv.slice(2);
if (!settingsPath || !attachScript) {
  console.error('usage: setup-hook.mjs <settings.json> <attach-script>');
  process.exit(2);
}

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error(`cannot parse ${settingsPath}: ${e.message}`);
    process.exit(1);
  }
}

settings.hooks = settings.hooks ?? {};
const groups = settings.hooks.SessionStart ?? [];
const already = groups.some(g => (g.hooks ?? []).some(h => h.command === attachScript));
if (already) {
  console.log(`SessionStart hook already present (${attachScript}).`);
  process.exit(0);
}

groups.push({ hooks: [{ type: 'command', command: attachScript, timeout: 10 }] });
settings.hooks.SessionStart = groups;
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`SessionStart hook added to ${settingsPath}.`);
