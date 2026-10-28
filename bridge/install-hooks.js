#!/usr/bin/env node
// Adds (or removes) Agent HQ's HTTP hooks in a Claude Code settings file. Makes a backup first.
//   node install-hooks.js              -> ./.claude/settings.local.json (this project only, not committed)
//   node install-hooks.js --user       -> ~/.claude/settings.json (every project)
//   node install-hooks.js --remove     -> take them out again (add --user for the user file)
//   node install-hooks.js --print      -> just print the hooks JSON
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const args = process.argv.slice(2), PORT = +(process.env.HQ_PORT || 4317);
const URL_ = `http://127.0.0.1:${PORT}/hook`;
const h = timeout => ({ type: 'http', url: URL_, timeout, headers: { 'X-Agent-HQ': 'hook' } });
const HOOKS = {
  UserPromptSubmit: [{ hooks: [h(10)] }],
  PreToolUse: [{ matcher: '*', hooks: [h(600)] }],
  PostToolUse: [{ matcher: '*', hooks: [h(10)] }],
  PostToolUseFailure: [{ matcher: '*', hooks: [h(10)] }],
  Notification: [{ hooks: [h(10)] }],
  Stop: [{ hooks: [h(10)] }],
  SessionEnd: [{ hooks: [h(10)] }]
};
if (args.includes('--print')) { console.log(JSON.stringify({ hooks: HOOKS }, null, 2)); process.exit(0); }
const file = args.includes('--user') ? path.join(os.homedir(), '.claude', 'settings.json') : path.join(process.cwd(), '.claude', 'settings.local.json');
let cfg = {};
if (fs.existsSync(file)) { const raw = fs.readFileSync(file, 'utf8'); try { cfg = JSON.parse(raw || '{}'); } catch (e) { console.error('Could not parse', file, '- fix or remove it first.'); process.exit(1); } fs.writeFileSync(file + '.bak-agent-hq', raw); }
const ours = g => (g.hooks || []).some(x => x.type === 'http' && String(x.url || '').startsWith(`http://127.0.0.1:${PORT}/hook`));
cfg.hooks = cfg.hooks || {};
for (const ev of Object.keys(cfg.hooks)) { cfg.hooks[ev] = (cfg.hooks[ev] || []).filter(g => !ours(g)); if (!cfg.hooks[ev].length) delete cfg.hooks[ev]; }
if (!args.includes('--remove')) for (const [ev, groups] of Object.entries(HOOKS)) cfg.hooks[ev] = [...(cfg.hooks[ev] || []), ...groups];
if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log((args.includes('--remove') ? 'Removed Agent HQ hooks from ' : 'Added Agent HQ hooks to ') + file + (fs.existsSync(file + '.bak-agent-hq') ? '\nBackup: ' + file + '.bak-agent-hq' : ''));
