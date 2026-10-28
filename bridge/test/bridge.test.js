'use strict';
// Run: node --test test/*.test.js   (from the bridge folder). Starts a real bridge on a spare port with a throwaway data folder.
const test = require('node:test'), assert = require('node:assert'), { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

const PORT = 4400 + Math.floor(Math.random() * 400);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-bridge-'));
let proc, code = '', pageToken = '';

function req(method, p, { headers = {}, body, raw } = {}) {
  return new Promise((ok, bad) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: Object.assign(data && raw === undefined ? { 'Content-Type': 'application/json' } : {}, headers) }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} ok({ status: res.statusCode, headers: res.headers, body: j, text: b }); });
    });
    r.on('error', bad); if (data) r.write(data); r.end();
  });
}
// Opens an event stream and collects messages; returns { msgs, close, wait(pred) }
function stream(p, headers = {}) {
  const msgs = []; let res; const waiters = [];
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, headers }, s => {
    res = s; let buf = '';
    s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const id = /^id: (\d+)$/m.exec(block); const data = /^data: (.*)$/m.exec(block); if (data) { const m = JSON.parse(data[1]); m._id = id ? +id[1] : null; msgs.push(m); waiters.forEach(w => w()); } } });
  });
  r.end();
  return { msgs, close: () => { r.destroy(); }, wait: (pred, ms = 3000) => new Promise((ok, bad) => { const t = setTimeout(() => bad(new Error('timeout waiting for event')), ms); const check = () => { const m = msgs.find(pred); if (m) { clearTimeout(t); ok(m); } }; waiters.push(check); check(); }) };
}

test.before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'bridge.js'), '--pair'], { env: Object.assign({}, process.env, { HQ_PORT: String(PORT), HQ_DATA: DATA, HQ_NEXUS_KEY: 'nk-test', HQ_TIMEOUT: '20', HQ_APP_ORIGINS: 'capacitor://localhost' }) });
  await new Promise((ok, bad) => { let out = ''; const t = setTimeout(() => bad(new Error('bridge did not start: ' + out)), 8000); proc.stdout.on('data', d => { out += d; const m = /Pairing code: (\S+)/.exec(out); if (m) { code = m[1]; clearTimeout(t); ok(); } }); });
  const page = await req('GET', '/'); pageToken = /"token":"([a-f0-9]+)"/.exec(page.text)[1];
});
test.after(() => { proc.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

let token = '', deviceId = '';
const auth = () => ({ Authorization: 'Bearer ' + token });

test('pairing: wrong code refused, right code works once', async () => {
  assert.equal((await req('POST', '/m/pair', { body: { code: 'AAAA-AAAA', name: 'x' } })).status, 403);
  const ok = await req('POST', '/m/pair', { body: { code: code.toLowerCase(), name: 'Test iPhone' } });
  assert.equal(ok.status, 200); assert.match(ok.body.token, /^[a-f0-9]{64}$/); token = ok.body.token; deviceId = ok.body.deviceId;
  assert.equal((await req('POST', '/m/pair', { body: { code, name: 'again' } })).status, 403, 'a code works only once');
  const stored = fs.readFileSync(path.join(DATA, 'devices.json'), 'utf8');
  assert.ok(!stored.includes(token), 'the token itself is never stored');
});

test('phone endpoints need the device token', async () => {
  assert.equal((await req('GET', '/m/ping')).status, 401);
  assert.equal((await req('GET', '/m/ping', { headers: { Authorization: 'Bearer ' + 'f'.repeat(64) } })).status, 401);
  const p = await req('GET', '/m/ping', { headers: auth() }); assert.equal(p.status, 200); assert.equal(p.body.device, 'Test iPhone');
});

test('CORS: the app origin is allowed, other origins are not', async () => {
  const a = await req('OPTIONS', '/m/ping', { headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(a.headers['access-control-allow-origin'], 'capacitor://localhost');
  const b = await req('OPTIONS', '/m/ping', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(b.headers['access-control-allow-origin'], undefined);
});

test('gated step: held for the phone, approved once, repeat command does not run twice', async () => {
  const s = stream('/m/events', auth()); await s.wait(m => m.type === 'hello');
  const hook = req('POST', '/hook', { headers: { 'X-Agent-HQ': 'hook' }, body: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'ls' } } });
  const held = await s.wait(m => m.type === 'hook' && m.gated);
  const cmd = { id: 'cmd-' + crypto.randomBytes(6).toString('hex'), type: 'decide', hookId: held.id, decision: 'allow', reason: 'ok from phone' };
  const r1 = await req('POST', '/m/command', { headers: auth(), body: cmd }); assert.equal(r1.body.ok, true);
  const answer = await hook; assert.equal(answer.body.hookSpecificOutput.permissionDecision, 'allow');
  const r2 = await req('POST', '/m/command', { headers: auth(), body: cmd }); assert.equal(r2.body.duplicate, true); assert.equal(r2.body.ok, true);
  await s.wait(m => m.type === 'decided' && m.id === held.id);
  const st = await req('GET', '/m/command/' + cmd.id, { headers: auth() }); assert.equal(st.body.known, true); assert.equal(st.body.result.ok, true);
  assert.equal((await req('GET', '/m/command/never-sent-123', { headers: auth() })).body.known, false);
  s.close();
});

test('catch-up: a phone that reconnects gets what it missed', async () => {
  const s1 = stream('/m/events', auth()); const hello = await s1.wait(m => m.type === 'hello'); s1.close();
  await req('POST', '/nexus', { headers: { 'X-Nexus-Key': 'nk-test' }, body: { type: 'say', text: 'missed while asleep' } });
  const s2 = stream('/m/events?since=' + hello.seq, auth());
  const m = await s2.wait(x => x.type === 'nexus' && x.msg.text === 'missed while asleep'); assert.ok(m._id > hello.seq); s2.close();
});

test('typed messages are held for review, with an honest note, never answered as Atarah', async () => {
  const s = stream('/m/events', auth()); const hello = await s.wait(m => m.type === 'hello');
  const r = await req('POST', '/m/command', { headers: auth(), body: { id: 'chat-' + crypto.randomBytes(5).toString('hex'), type: 'chat', text: 'hello Atarah' } });
  assert.equal(r.body.held, true);
  const n = await s.wait(m => m.type === 'gateway' && m.msg.type === 'note'); assert.match(n.msg.text, /kept on your desktop/);
  assert.ok(!s.msgs.some(m => m._id > hello.seq && m.type === 'nexus'), 'nothing is said in Atarah\'s name'); s.close();
});

test('tasks are held, not faked, while Nexus is not connected', async () => {
  const r = await req('POST', '/m/command', { headers: auth(), body: { id: 'task-' + crypto.randomBytes(5).toString('hex'), type: 'task', text: 'run the weekly report' } });
  assert.equal(r.body.queued, true); assert.equal(r.body.held, true);
  const held = JSON.parse(fs.readFileSync(path.join(DATA, 'held-for-review.json'), 'utf8')); assert.equal(held.slice(-1)[0].text, 'run the weekly report'); assert.equal(held.slice(-1)[0].kind, 'task');
});

test('voice: chunks are joined and answered', async () => {
  const turn = 'turn-' + crypto.randomBytes(4).toString('hex');
  for (let i = 0; i < 3; i++) await req('POST', '/m/voice/chunk?turn=' + turn, { headers: Object.assign({ 'Content-Type': 'audio/mp4' }, auth()), raw: Buffer.alloc(1500, i) });
  const r = await req('POST', '/m/voice/end?turn=' + turn, { headers: auth() }); assert.equal(r.status, 200); assert.match(r.body.note, /reached the desktop/); assert.equal(r.body.reply, null);
});

test('the desktop page can issue codes and remove a phone; a removed phone is locked out', async () => {
  assert.equal((await req('POST', '/pair/start')).status, 403);
  const c = await req('POST', '/pair/start', { headers: { 'X-HQ-Token': pageToken } }); assert.match(c.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const list = await req('GET', '/devices', { headers: { 'X-HQ-Token': pageToken } }); assert.equal(list.body.devices[0].name, 'Test iPhone'); assert.equal(list.body.devices[0].tokenHash, undefined);
  assert.equal((await req('POST', '/devices/revoke', { headers: { 'X-HQ-Token': pageToken }, body: { id: deviceId } })).status, 200);
  assert.equal((await req('GET', '/m/ping', { headers: auth() })).status, 401);
});
