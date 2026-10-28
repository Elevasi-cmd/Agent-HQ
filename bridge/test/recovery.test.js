'use strict';
// Recovery across real bridge restarts: event catch-up, held steps that died with the bridge, commands whose outcome
// is uncertain, and computers that refuse to list their network interfaces. Run: node --test test/*.test.js
const test = require('node:test'), assert = require('node:assert'), { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { createCommandLog } = require('../lib/commands');
const { createEventLog } = require('../lib/events');

const PORT = 4800 + Math.floor(Math.random() * 400);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-recovery-'));
let proc = null;

function req(method, p, { headers = {}, body } = {}) {
  return new Promise((ok, bad) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: Object.assign(data ? { 'Content-Type': 'application/json' } : {}, headers) }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} ok({ status: res.statusCode, body: j, text: b }); });
    });
    r.on('error', bad); if (data) r.write(data); r.end();
  });
}
// Collects { id, msg } from an event stream until closed.
function stream(p, headers = {}) {
  const got = []; let r;
  const ready = new Promise((ok, bad) => {
    r = http.request({ host: '127.0.0.1', port: PORT, path: p, headers }, s => {
      let buf = ''; s.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const id = /^id: (\d+)$/m.exec(block); const data = /^data: (.*)$/m.exec(block); if (data) got.push({ id: id ? +id[1] : null, msg: JSON.parse(data[1]) }); } });
      s.on('error', () => {}); ok();
    });
    r.on('error', bad); r.end();
  });
  const until = (pred, ms = 4000) => new Promise((ok, bad) => { const t0 = Date.now(); (function poll() { const m = got.find(pred); if (m) return ok(m); if (Date.now() - t0 > ms) return bad(new Error('timeout')); setTimeout(poll, 20); })(); });
  return { got, ready, until, close: () => r.destroy() };
}

async function start(extraEnv = {}) {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'bridge.js'), '--pair'], { env: Object.assign({}, process.env, { HQ_PORT: String(PORT), HQ_DATA: DATA, HQ_NEXUS_KEY: 'nk', HQ_TIMEOUT: '30' }, extraEnv) });
  let out = '';
  await new Promise((ok, bad) => { const t = setTimeout(() => bad(new Error('bridge did not start: ' + out)), 8000); proc.stdout.on('data', d => { out += d; if (/Pairing code: \S+/.test(out)) { clearTimeout(t); ok(); } }); proc.on('exit', c => bad(new Error('bridge exited ' + c + ': ' + out))); });
  return { out, code: /Pairing code: (\S+)/.exec(out)[1] };
}
async function stop(signal = 'SIGTERM') { const p = proc; proc = null; if (!p || p.exitCode !== null) return; await new Promise(ok => { p.on('exit', ok); p.kill(signal); }); }
const notify = text => req('POST', '/nexus', { headers: { 'X-Nexus-Key': 'nk' }, body: { type: 'notify', text } });

test.after(async () => { if (proc) await stop(); fs.rmSync(DATA, { recursive: true, force: true }); });

let auth;
test('events keep their numbers across a restart, and a phone catches up on what it missed', async () => {
  const { code } = await start();
  const pr = await req('POST', '/m/pair', { body: { code, name: 'Phone' } }); auth = { Authorization: 'Bearer ' + pr.body.token };
  const s1 = stream('/m/events?since=0', auth); await s1.ready;
  const hello = await s1.until(e => e.msg.type === 'hello'); const stream1 = hello.msg.stream;
  await notify('one'); await notify('two');
  const last = await s1.until(e => e.msg.type === 'nexus' && e.msg.msg.text === 'two'); s1.close();
  await stop();                                      // the phone is asleep through the restart
  await start(); await notify('three');              // happened while the phone was away
  const s2 = stream(`/m/events?since=${last.id}&stream=${stream1}`, auth); await s2.ready;
  const h2 = await s2.until(e => e.msg.type === 'hello');
  assert.equal(h2.msg.stream, stream1, 'same stream after restart'); assert.equal(h2.msg.resync, false); assert.equal(h2.msg.from, last.id);
  const three = await s2.until(e => e.msg.type === 'nexus' && e.msg.msg.text === 'three');
  assert.ok(three.id > last.id, 'numbering continued instead of restarting at 1');
  await s2.until(e => e.msg.type === 'synced');
  assert.ok(!s2.got.some(e => e.msg.type === 'nexus' && ['one', 'two'].includes(e.msg.msg.text)), 'nothing already seen is replayed');
  s2.close();
});

test('a lost event log starts a new stream and tells clients to resync', async () => {
  const before = (await req('GET', '/m/ping', { headers: auth })).body;
  await stop(); fs.rmSync(path.join(DATA, 'events.json')); await start();
  const s = stream(`/m/events?since=${before.seq}&stream=${before.stream}`, auth); await s.ready;
  const h = await s.until(e => e.msg.type === 'hello');
  assert.notEqual(h.msg.stream, before.stream); assert.equal(h.msg.resync, true); assert.equal(h.msg.reason, 'new-stream'); assert.equal(h.msg.from, 0);
  s.close();
  // a phone that is somehow ahead of the bridge is resynced too
  const s3 = stream(`/m/events?since=999999&stream=${h.msg.stream}`, auth); await s3.ready;
  assert.equal((await s3.until(e => e.msg.type === 'hello')).msg.reason, 'ahead'); s3.close();
});

test('a held step that was waiting when the bridge stopped is marked expired, and is not offered again', async () => {
  const page = stream('/m/events?since=0', auth); await page.ready; await page.until(e => e.msg.type === 'synced');
  const hook = http.request({ host: '127.0.0.1', port: PORT, path: '/hook', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-HQ': 'hook' } }); hook.on('error', () => {});
  hook.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 't1' }));
  const held = await page.until(e => e.msg.type === 'hook' && e.msg.gated); page.close();
  const before = (await req('GET', '/m/ping', { headers: auth })).body;
  await stop('SIGKILL');                               // crash: no chance to clean up
  await start();
  const s = stream(`/m/events?since=${held.id - 1}&stream=${before.stream}`, auth); await s.ready;
  const synced = await s.until(e => e.msg.type === 'synced');
  assert.deepEqual(synced.msg.pending, [], 'nothing is really waiting after the restart');
  assert.ok(s.got.some(e => e.msg.type === 'expired' && e.msg.id === held.msg.id && e.msg.reason === 'bridge-restarted'));
  const d = await req('POST', '/m/command', { headers: auth, body: { id: 'c-decide-after-crash', type: 'decide', hookId: held.msg.id, decision: 'allow' } });
  assert.equal(d.body.ok, false); assert.equal(d.body.gone, true, 'an approval for a step that died is refused, not applied');
  s.close();
});

test('the desktop page reconnects after a restart and catches up from its last event', async () => {
  const html = (await req('GET', '/')).text; const t1 = /"token":"([a-f0-9]+)"/.exec(html)[1];
  const p1 = stream('/events?t=' + t1); await p1.ready; await p1.until(e => e.msg.type === 'synced');
  await notify('before'); const b = await p1.until(e => e.msg.type === 'nexus' && e.msg.msg.text === 'before'); p1.close();
  await stop(); await start(); await notify('after');
  const t2 = /"token":"([a-f0-9]+)"/.exec((await req('GET', '/')).text)[1];
  assert.equal(t2, t1, 'the page key survives a restart, so the open page is not locked out');
  const p2 = stream('/events?t=' + t1, { 'Last-Event-ID': String(b.id) }); await p2.ready;
  await p2.until(e => e.msg.type === 'nexus' && e.msg.msg.text === 'after');
  assert.ok(!p2.got.some(e => e.msg.type === 'nexus' && e.msg.msg.text === 'before')); p2.close();
});

test('a command that started but never finished is reported uncertain and not run again', async () => {
  await stop();
  const f = path.join(DATA, 'commands.json'); const all = JSON.parse(fs.readFileSync(f, 'utf8'));
  all['c-crashed-task-1'] = { state: 'started', type: 'task', at: Date.now() }; fs.writeFileSync(f, JSON.stringify(all));
  await start();
  let heldBefore = 0; try { heldBefore = JSON.parse(fs.readFileSync(path.join(DATA, 'held-for-review.json'), 'utf8')).length; } catch (e) {}
  const st = await req('GET', '/m/command/c-crashed-task-1', { headers: auth }); assert.equal(st.body.state, 'uncertain');
  const r = await req('POST', '/m/command', { headers: auth, body: { id: 'c-crashed-task-1', type: 'task', text: 'deploy' } });
  assert.equal(r.status, 200); assert.equal(r.body.uncertain, true); assert.equal(r.body.ok, false);
  let heldAfter = []; try { heldAfter = JSON.parse(fs.readFileSync(path.join(DATA, 'held-for-review.json'), 'utf8')); } catch (e) {}
  assert.equal(heldAfter.length, heldBefore, 'it was not run again');
  // a normal command, sent twice, is recorded once
  const a = await req('POST', '/m/command', { headers: auth, body: { id: 'c-normal-task-1', type: 'task', text: 'report' } });
  const a2 = await req('POST', '/m/command', { headers: auth, body: { id: 'c-normal-task-1', type: 'task', text: 'report' } });
  assert.equal(a.body.held, true); assert.equal(a2.body.duplicate, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, 'held-for-review.json'), 'utf8')).filter(x => x.cmd === 'c-normal-task-1').length, 1);
});

test('a computer that refuses to list network interfaces still starts and pairs', async () => {
  await stop(); const { out } = await start({ HQ_TEST_NO_INTERFACES: '1' });
  assert.match(out, /network addresses unavailable/);
  const tok = /"token":"([a-f0-9]+)"/.exec((await req('GET', '/')).text)[1];
  const r = await req('POST', '/pair/start', { headers: { 'X-HQ-Token': tok } });
  assert.equal(r.status, 200); assert.match(r.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/); assert.deepEqual(r.body.tailscale, []); assert.equal(r.body.interfacesAvailable, false);
  const p = await req('POST', '/m/pair', { body: { code: r.body.code, name: 'Second phone' } }); assert.equal(p.status, 200);
});

test('command log: in progress while running, uncertain if the process dies, never re-run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-cmd-'));
  const log = createCommandLog(dir); let runs = 0, release;
  const first = log.run('c-1', 'task', () => { runs++; return new Promise(ok => { release = () => ok({ ok: true }); }); });
  assert.equal((await log.run('c-1', 'task', async () => { runs++; })).state, 'in-progress');
  release(); assert.equal((await first).state, 'done');
  const again = await log.run('c-1', 'task', async () => { runs++; }); assert.equal(again.state, 'done'); assert.equal(again.known, true); assert.equal(runs, 1);
  // simulate a crash mid-run: a new process sees "started" with nothing running
  log.run('c-2', 'task', () => new Promise(() => {}));
  const after = createCommandLog(dir); assert.equal(after.status('c-2').state, 'uncertain');
  assert.equal((await after.run('c-2', 'task', async () => { runs++; })).state, 'uncertain'); assert.equal(runs, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('event log: unreadable file starts a new stream; gaps are reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-ev-'));
  fs.writeFileSync(path.join(dir, 'events.json'), '{not json');
  const ev = createEventLog({ dataDir: dir, size: 3 }); assert.equal(ev.restored, false);
  for (let i = 0; i < 6; i++) ev.append({ type: 'x', i });
  assert.equal(ev.replay(1, ev.stream).reason, 'gap'); assert.equal(ev.replay(4, ev.stream).resync, false); assert.equal(ev.replay(4, ev.stream).items.length, 2);
  ev.flushSync(); const again = createEventLog({ dataDir: dir, size: 3 }); assert.equal(again.stream, ev.stream); assert.equal(again.seq, 6);
  assert.equal((fs.statSync(path.join(dir, 'events.json')).mode & 0o777).toString(8), '600');
  fs.rmSync(dir, { recursive: true, force: true });
});
