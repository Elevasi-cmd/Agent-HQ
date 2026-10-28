// Development check, not part of the app: drives the built iPhone layer in Chromium against a real bridge and a MOCK
// Nexus (clearly fake: it answers the three Nexus routes in the 28 Oct 2026 handoff with canned data). Run: npm run e2e
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process'), os = require('os');
const [WWW, BRIDGE, OUT] = process.argv.slice(2).map(p => require("path").resolve(p)); require("fs").mkdirSync(OUT, { recursive: true }); const A = 5111, B = 5112, N = 5113; const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-e2e-'));
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(WWW, u === '/' ? 'index.html' : u); if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(A);
// mock Nexus (routes and shapes from the 28 Oct handoff)
const nx = { turns: [] };
http.createServer((q, r) => { const c = []; q.on('data', d => c.push(d)); q.on('end', () => { const body = Buffer.concat(c), send = (s, j) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(j)); };
  if (q.url === '/api/interaction') return send(200, { status: 'healthy' });
  if (q.url === '/api/voice/session') { const j = JSON.parse(body); return send(200, { session_id: j.session_id, new_state: Object.assign({}, j.current_state, { current_state: 'voice_listening_requested' }) }); }
  if (q.url === '/api/voice/turn') { const s = body.toString('latin1'); const i = s.indexOf('RIFF'); nx.turns.push({ riff: i >= 0, rate: i >= 0 ? body.readUInt32LE(i + 24) : 0, bytes: body.length }); return send(200, { decision: 'voice_turn_completed', normalized_transcript: 'what is waiting for me', formatted_voice_response: 'Two steps are waiting for you, Boss. The deploy is the urgent one.', audio_output_path: 'host/out.wav', session_continuity: { turn_count: nx.turns.length } }); }
  send(404, {}); }); }).listen(N);
let br, code = '';
function startBridge(pair) { return new Promise(ok => { br = spawn(process.execPath, [path.join(BRIDGE, 'bridge.js'), ...(pair ? ['--pair'] : [])], { env: Object.assign({}, process.env, { HQ_PORT: String(B), HQ_DATA: DATA, HQ_TIMEOUT: '60', HQ_APP_ORIGINS: 'http://127.0.0.1:' + A, NEXUS_URL: 'http://127.0.0.1:' + N, HQ_NEXUS_VOICE: 'on', HQ_NEXUS_KEY: 'nk-e2e' }) }); let out = ''; br.stdout.on('data', d => { out += d; const m = /Pairing code: (\S+)/.exec(out); if (m) code = m[1]; if (/Data:/.test(out) && (!pair || code)) ok(); }); }); }
const post = (p, body, h = {}) => new Promise(ok => { const q = http.request({ host: '127.0.0.1', port: B, path: p, method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h) }, s => { let d = ''; s.on('data', c => d += c); s.on('end', () => ok(d)); }); q.on('error', e => ok('connection closed (' + e.code + ')')); q.end(JSON.stringify(body)); });
(async () => {
  await startBridge(true);
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); const errs = [];
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, timezoneId: 'Europe/London', permissions: ['microphone'] });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  await p.route(/api\.openai\.com/, r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ output: [{ content: [{ type: 'output_text', text: "I'm the cloud assistant, not Atarah. Let's outline the release notes." }] }], usage: { total_tokens: 70 } }) }));
  const chip = () => p.$eval('#mqChip', e => e.textContent); const notes = () => p.$$eval('.mq-msg', els => els.map(e => e.textContent));
  await p.goto('http://127.0.0.1:' + A + '/'); await p.waitForTimeout(3000);
  await p.click('#mqChip'); await p.fill('#mqBase', 'http://127.0.0.1:' + B); await p.fill('#mqCode', code); await p.fill('#mqName', "Aaron's iPhone"); await p.click('[data-mq=pair]');
  await p.waitForFunction(() => document.querySelector('#mqChip').textContent.includes('LOCAL'), null, { timeout: 20000 }); console.log('1 paired:', await chip());
  await p.click('[data-mq=tab][data-k=talk]'); await p.fill('#mqInput', 'What is waiting for me?'); await p.click('[data-mq=send]');
  await p.waitForFunction(() => [...document.querySelectorAll('.mq-msg.note')].some(e => /kept on your desktop/.test(e.textContent)), null, { timeout: 8000 }); console.log('2 typed -> held with note; Atarah lines:', (await p.$$('.mq-msg.nexus')).length);
  await p.click('[data-mq=mic]'); await p.waitForTimeout(2500); await p.click('[data-mq=mic]');
  await p.waitForFunction(() => document.querySelectorAll('.mq-msg.nexus').length > 0, null, { timeout: 20000 });
  console.log('3 voice turn:', JSON.stringify(nx.turns[0]), '·', (await notes()).filter(t => /ATARAH|speakers/.test(t)).map(t => t.slice(0, 70)).join(' | '));
  await p.screenshot({ path: OUT + '/Q1-voice.png' });
  await p.click('[data-mq=close]');
  const hook = post('/hook', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'npm run deploy' } }, { 'X-Agent-HQ': 'hook' });
  await p.waitForFunction(() => window.__hq.R.decisions.some(d => d.live && d.state === 'pending'), null, { timeout: 8000 });
  br.kill(); await p.waitForFunction(() => /AWAY|CONNECTING/.test(document.querySelector('#mqChip').textContent), null, { timeout: 20000 });
  await p.evaluate(() => { const d = window.__hq.R.decisions.find(x => x.live && x.state === 'pending'); window.__hq.authorise(d.id); });
  await p.waitForTimeout(500);
  console.log('4 approve while away -> state:', await p.evaluate(() => window.__hq.R.decisions.find(x => x.live).state), '· flash:', await p.$eval('#mqFlash', e => e.hidden ? '' : e.textContent.slice(0, 60)), '· queued decisions:', await p.evaluate(() => window.__mq.outbox.items.filter(i => i.type === 'decide').length));
  await p.screenshot({ path: OUT + '/Q2-no-queued-approvals.png' });
  await p.click('#mqTalk'); await p.fill('#mqInput', 'Prepare the weekly report'); await p.check('[data-mq=desktopTask]'); await p.click('[data-mq=send]'); await p.uncheck('[data-mq=desktopTask]');
  await p.click('[data-mq=tab][data-k=fallback]'); await p.check('[data-mq=fbEnabled]'); await p.check('[data-mq=paid]'); await p.fill('#mqKey_openai', 'sk-test'); await p.fill('#mqModel_openai', 'test-model'); await p.click('[data-mq=saveProv][data-p=openai]');
  await p.click('[data-mq=tab][data-k=talk]'); await p.fill('#mqInput', 'Help me outline the release notes'); await p.click('[data-mq=send]');
  await p.waitForFunction(() => document.querySelectorAll('.mq-msg.cloud').length > 0, null, { timeout: 8000 });
  console.log('5 cloud label:', await p.$eval('.mq-msg.cloud b', e => e.textContent), '· chip:', await chip()); await p.screenshot({ path: OUT + '/Q3-cloud.png' });
  await startBridge(false); await p.waitForFunction(() => document.querySelector('#mqChip').textContent.includes('LOCAL'), null, { timeout: 40000 }); await p.waitForTimeout(2500);
  const held = JSON.parse(fs.readFileSync(path.join(DATA, 'held-for-review.json'), 'utf8'));
  console.log('6 back:', await chip(), '· held for review on desktop:', held.map(h => h.kind).join(', '), '· hook answer:', (await hook).slice(0, 40) || '(Claude Code got no decision from the phone)');
  await post('/nexus', { type: 'say', text: 'Back after the restart.' }, { 'X-Nexus-Key': 'nk-e2e' });
  await p.waitForFunction(() => window.__mq.S.talk.some(m => m.text === 'Back after the restart.'), null, { timeout: 8000 }).catch(() => {});
  console.log('6b after restart: held step on phone ->', await p.evaluate(() => { const d = window.__hq.R.decisions.find(x => x.live); return d.state + ' (' + (d.note || '') + ')'; }), '· new event arrived:', await p.evaluate(() => window.__mq.S.talk.some(m => m.text === 'Back after the restart.')), '· cursor:', await p.evaluate(() => JSON.stringify({ stream: window.__mq.conn.stream, seq: window.__mq.conn.lastSeq })));
  await p.evaluate(() => window.__mq.open('connect')); await p.screenshot({ path: OUT + '/Q6-connect.png' }); console.log('6c missing list:', await p.$$eval('.mq-missing li', l => l.length)); await p.evaluate(() => window.__mq.open('talk'));
  await p.click('[data-mq=tab][data-k=queue]'); await p.screenshot({ path: OUT + '/Q4-queue.png' });
  // desktop page shows the phone's items for review
  const d = await b.newPage({ viewport: { width: 1333, height: 690 } }); await d.route(/fonts\.googleapis\.com/, r => r.fulfill({ contentType: 'text/css', body: "@font-face{font-family:'Press Start 2P';src:url(http://127.0.0.1:" + A + "/fonts/press-start-2p-latin-400-normal.woff2)}@font-face{font-family:'VT323';src:url(http://127.0.0.1:" + A + "/fonts/vt323-latin-400-normal.woff2)}" })); await d.route(/three\.min\.js/, r => r.fulfill({ path: path.join(WWW, 'vendor/three.min.js'), contentType: 'application/javascript' })); await d.goto('http://127.0.0.1:' + B + '/'); await d.waitForTimeout(3000);
  await d.evaluate(() => window.__hq.openCard('atav')); await d.waitForTimeout(1500);
  console.log('7 desktop card:', (await d.$eval('.card', e => e.innerText)).split('\n').filter(l => /FROM YOUR PHONE|Task|Message|Cloud chat/.test(l)).slice(0, 4).join(' | '));
  await d.screenshot({ path: OUT + '/Q5-desktop-review.png' }); console.log('8 card scrolls:', JSON.stringify(await d.evaluate(() => [...document.querySelectorAll('.card *')].filter(e => e.scrollHeight > e.clientHeight + 2 && getComputedStyle(e).overflowY !== 'visible' && getComputedStyle(e).overflowY !== 'hidden').map(e => e.tagName + '.' + e.className + ' ' + e.scrollHeight + '/' + e.clientHeight + ' ' + e.textContent.slice(0, 60)))));
  console.log(errs.join('\n') || 'no page errors'); await b.close(); br.kill(); process.exit(0);
})().catch(e => { console.error('FAILED', e.message); br && br.kill(); process.exit(1); });
