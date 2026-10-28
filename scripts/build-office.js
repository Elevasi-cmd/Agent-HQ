#!/usr/bin/env node
// Builds the Agent HQ office page from office/ (template + pixel art) into the two places that serve it:
// web/agent-hq.html (bundled into the iPhone app) and bridge/agent-hq.html (served by the desktop bridge).
'use strict';
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'office/template.html'), 'utf8');
const art = fs.readFileSync(path.join(root, 'office/art.min.json'), 'utf8').trim();
if (!tpl.includes('__ART__')) throw new Error('office/template.html has no __ART__ placeholder');
const html = tpl.replace('__ART__', art);
for (const out of ['web/agent-hq.html', 'bridge/agent-hq.html']) fs.writeFileSync(path.join(root, out), html);
console.log(`office built: ${(html.length / 1024).toFixed(0)} KB -> web/ and bridge/`);
