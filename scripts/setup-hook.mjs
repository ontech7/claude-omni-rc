#!/usr/bin/env node
// Adds or removes the ollama-rc SessionStart hook in a Claude Code
// settings.json, preserving everything else. Idempotent.
//
// Usage:
//   node setup-hook.mjs <settings.json> <attach-script>         # add
//   node setup-hook.mjs --remove <settings.json> <attach-script> # remove
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const removeMode = process.argv[2] === '--remove';
const args = removeMode ? process.argv.slice(3) : process.argv.slice(2);
const [settingsPath, attachScript] = args;
if (!settingsPath || !attachScript) {
  console.error('usage: setup-hook.mjs [--remove] <settings.json> <attach-script>');
  process.exit(2);
}
if (!existsSync(settingsPath)) {
  if (removeMode) { console.log('no settings.json — nothing to remove.'); process.exit(0); }
  console.error(`settings.json not found: ${settingsPath}`);
  process.exit(1);
}

let settings;
try {
  settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
} catch (e) {
  console.error(`cannot parse ${settingsPath}: ${e.message}`);
  process.exit(1);
}

const groups = settings.hooks?.SessionStart ?? [];

if (removeMode) {
  const remaining = groups.filter(g => !(g.hooks ?? []).some(h => h.command === attachScript));
  if (remaining.length === groups.length) {
    console.log('SessionStart hook not present — nothing to remove.');
    process.exit(0);
  }
  if (remaining.length) settings.hooks.SessionStart = remaining;
  else delete settings.hooks.SessionStart;
  if (Object.keys(settings.hooks ?? {}).length === 0) delete settings.hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`SessionStart hook removed from ${settingsPath}.`);
  process.exit(0);
}

settings.hooks = settings.hooks ?? {};
const already = groups.some(g => (g.hooks ?? []).some(h => h.command === attachScript));
if (already) {
  console.log(`SessionStart hook already present (${attachScript}).`);
  process.exit(0);
}
groups.push({ hooks: [{ type: 'command', command: attachScript, timeout: 10 }] });
settings.hooks.SessionStart = groups;
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`SessionStart hook added to ${settingsPath}.`);
