#!/usr/bin/env node
// Adds or removes the ollama-rc hooks in a Claude Code settings.json,
// preserving everything else. Idempotent.
//
// It manages:
//   - the SessionStart hook (auto-attach), a hook command entry
//   - the PermissionRequest hook (remote approve/reject), a hook command entry
//     that delegates CLI permission decisions to the ollama-rc daemon
//
// Usage:
//   node setup-hook.mjs <settings.json> <attach-script> <permission-hook>          # add
//   node setup-hook.mjs --remove <settings.json> <attach-script> <permission-hook> # remove
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const removeMode = process.argv[2] === '--remove';
const args = removeMode ? process.argv.slice(3) : process.argv.slice(2);
const [settingsPath, attachScript, permissionHook] = args;
if (!settingsPath || !attachScript || !permissionHook) {
  console.error('usage: setup-hook.mjs [--remove] <settings.json> <attach-script> <permission-hook>');
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

// Generous timeout: the permission hook stays blocked waiting for the
// decision from Telegram (up to PERMISSION_TIMEOUT_SECONDS + margin).
const PERMISSION_HOOK_TIMEOUT = 600;

function hasCommand(groups, script) {
  return groups.some(g => (g.hooks ?? []).some(h => h.command === script));
}
function filterGroups(groups, script) {
  return groups.filter(g => !(g.hooks ?? []).some(h => h.command === script));
}

if (removeMode) {
  let changed = false;
  for (const [key, script] of [['SessionStart', attachScript], ['PermissionRequest', permissionHook]]) {
    const groups = settings.hooks?.[key] ?? [];
    const remaining = filterGroups(groups, script);
    if (remaining.length !== groups.length) {
      if (remaining.length) settings.hooks[key] = remaining;
      else delete settings.hooks[key];
      changed = true;
    }
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  if (changed) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`ollama-rc hooks removed from ${settingsPath}.`);
  } else {
    console.log('ollama-rc hooks not present — nothing to remove.');
  }
  process.exit(0);
}

settings.hooks = settings.hooks ?? {};
let changed = false;
for (const [key, script] of [['SessionStart', attachScript], ['PermissionRequest', permissionHook]]) {
  const groups = settings.hooks[key] ?? [];
  if (hasCommand(groups, script)) {
    console.log(`${key} hook already present (${script}).`);
    continue;
  }
  groups.push({ hooks: [{ type: 'command', command: script, timeout: key === 'SessionStart' ? 10 : PERMISSION_HOOK_TIMEOUT }] });
  settings.hooks[key] = groups;
  changed = true;
}
if (changed) {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`ollama-rc hooks added to ${settingsPath}.`);
} else {
  console.log('ollama-rc hooks already present.');
}
