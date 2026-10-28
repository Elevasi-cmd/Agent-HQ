import test from 'node:test'; import assert from 'node:assert';
import { createOutbox } from '../src/outbox.js';
import { parseSSE } from '../src/conn.js';
const mem = () => { let v = null; return { load: async () => v && JSON.parse(JSON.stringify(v)), save: async x => { v = JSON.parse(JSON.stringify(x)); }, peek: () => v }; };

test('a dropped connection leaves the command queued with the same id', async () => {
  const st = mem(); const ob = createOutbox(st); await ob.load();
  const a = await ob.add('task', { text: 'report' }); const b = await ob.add('chat', { text: 'hi' });
  let n = 0; await ob.flush(async () => { n++; throw new Error('offline'); });
  assert.equal(n, 1, 'stops at the first network failure'); assert.equal(ob.items[0].state, 'queued'); assert.equal(ob.items[0].id, a.id);
  const seen = []; await ob.flush(async it => { seen.push(it.id); return { ok: true }; });
  assert.deepEqual(seen, [a.id, b.id]); assert.ok(ob.items.every(i => i.state === 'done'));
});
test('a command caught mid-send by app suspension is checked first, then sent with its original id only if it never started', async () => {
  const st = mem(); const ob = createOutbox(st); await ob.load(); const a = await ob.add('task', { text: 'report' }); const b = await ob.add('decide', { hookId: 'h1', decision: 'allow' }, 'Allow', { noResend: true });
  const saved = st.peek(); saved[0].state = 'sending'; saved[1].state = 'sending'; await st.save(saved);
  const ob2 = createOutbox(st); await ob2.load(); assert.deepEqual(ob2.items.map(i => i.state), ['unknown', 'unknown']);
  let sends = 0; await ob2.flush(async () => { sends++; return { ok: true }; }); assert.equal(sends, 0, 'nothing is resent before checking');
  await ob2.resolveUnknown(async () => ({ known: false }));
  assert.equal(ob2.items[0].state, 'queued', 'a task the bridge never recorded never started, so it may go with the same id');
  assert.equal(ob2.items[1].state, 'failed', 'an approval is never resent');
  const ids = []; await ob2.flush(async it => { ids.push(it.id); return { ok: true }; }); assert.deepEqual(ids, [a.id]);
});
test('in progress and uncertain answers are not retried automatically', async () => {
  const ob = createOutbox(mem()); await ob.load(); await ob.add('task', { text: 'a' }); await ob.add('task', { text: 'b' });
  let n = 0; await ob.flush(async it => (n++ === 0 ? { inProgress: true } : { ok: false, uncertain: true, error: 'may or may not have happened' }));
  assert.deepEqual(ob.items.map(i => i.state), ['unknown', 'uncertain']);
  await ob.resolveUnknown(async () => ({ known: true, state: 'in-progress' })); assert.equal(ob.items[0].state, 'unknown');
  await ob.resolveUnknown(async () => ({ known: true, state: 'uncertain' })); assert.equal(ob.items[0].state, 'uncertain');
  let sends = 0; await ob.flush(async () => { sends++; return { ok: true }; }); assert.equal(sends, 0);
});
test('sending again is your choice and goes as a new command; approvals cannot be sent again', async () => {
  const ob = createOutbox(mem()); await ob.load(); const a = await ob.add('task', { text: 'a' }); const d = await ob.add('decide', { hookId: 'h' }, 'Allow', { noResend: true });
  await ob.flush(async () => ({ ok: false, uncertain: true }));
  const c = await ob.resend(a.id); assert.ok(c && c.id !== a.id && c.resentFrom === a.id && c.state === 'queued');
  assert.equal(await ob.resend(d.id), null);
});
test('an unanswered command older than the bridge keeps records is not resent', async () => {
  let t = 1e12; const ob = createOutbox(mem(), { now: () => t }); await ob.load(); await ob.add('task', { text: 'a' });
  await ob.flush(async () => { throw new Error('offline'); }); t += 13 * 864e5;
  let sends = 0; await ob.flush(async () => { sends++; return { ok: true }; }); assert.equal(sends, 0); assert.equal(ob.items[0].state, 'uncertain');
});
test('an expired decision is marked failed, not retried forever', async () => {
  const ob = createOutbox(mem()); await ob.load(); await ob.add('decide', { hookId: 'old' });
  await ob.flush(async () => ({ ok: false, gone: true, error: 'no longer waiting' })); assert.equal(ob.items[0].state, 'failed');
});
test('event stream parsing keeps ids and survives split chunks', () => {
  const got = []; let buf = parseSSE('id: 7\ndata: {"type":"nex', (m, id) => got.push([m, id]));
  buf = parseSSE(buf + 'us"}\n\n: ping\n\ndata: {"type":"hello"}\n\n', (m, id) => got.push([m, id]));
  assert.deepEqual(got, [[{ type: 'nexus' }, 7], [{ type: 'hello' }, null]]); assert.equal(buf, '');
});
test('an approval that may not have arrived is checked, never resent', async () => {
  const st = mem(); const ob = createOutbox(st); await ob.load();
  await ob.add('decide', { hookId: 'h9', decision: 'allow' }, 'Allow', { noResend: true });
  await ob.flush(async () => { throw new Error('connection dropped'); });
  assert.equal(ob.items[0].state, 'unknown');
  let sends = 0; await ob.flush(async () => { sends++; return { ok: true }; }); assert.equal(sends, 0, 'unknown items are not in the send queue');
  await ob.resolveUnknown(async () => ({ known: true, result: { ok: true } })); assert.equal(ob.items[0].state, 'done');
  await ob.add('decide', { hookId: 'h10' }, 'Allow', { noResend: true }); await ob.flush(async () => { throw new Error('x'); });
  await ob.resolveUnknown(async () => ({ known: false })); assert.equal(ob.items[1].state, 'failed'); assert.match(ob.items[1].result.error, /decide again/);
});
import { createResampler } from '../src/voice.js';
test('48 kHz microphone audio is resampled to 16 kHz 16-bit PCM without drift across buffers', () => {
  const rs = createResampler(48000, 16000); let total = 0;
  for (let b = 0; b < 10; b++) { const x = new Float32Array(4096); for (let i = 0; i < x.length; i++) x[i] = Math.sin((b * 4096 + i) / 48000 * 2 * Math.PI * 440); total += rs(x).length; }
  assert.ok(Math.abs(total - 40960 / 3) <= 2, 'about a third of the samples: ' + total);
  const peak = Math.max(...createResampler(48000)(new Float32Array(300).fill(1))); assert.equal(peak, 32767);
});
import { createConn } from '../src/conn.js';
test('after a bridge reset the phone follows the new stream instead of dropping its events', async () => {
  const urls = []; let saved = { stream: 'A', seq: 50 }; const got = [];
  const sse = 'data: {"type":"hello","stream":"B","from":0,"resync":true,"reason":"new-stream","pending":[]}\n\nid: 3\ndata: {"type":"nexus","msg":{"type":"say","text":"hi"}}\n\ndata: {"type":"synced","pending":[]}\n\n';
  const fetchImpl = async u => { urls.push(u); const enc = new TextEncoder().encode(sse); let sent = false; return { ok: true, status: 200, body: { getReader: () => ({ read: async () => { if (!sent) { sent = true; return { value: enc, done: false }; } await new Promise(() => {}); } }) } }; };
  const conn = createConn({ getBase: () => 'https://pc.ts.net', getToken: async () => 'tok', onEvent: m => got.push(m), onState: () => {}, fetchImpl, loadSeq: async () => saved, saveSeq: async v => { saved = v; } });
  conn.connect(); await new Promise(r => setTimeout(r, 50));
  assert.equal(urls[0], 'https://pc.ts.net/m/events?since=50&stream=A');
  assert.deepEqual(got.map(m => m.type), ['hello', 'nexus', 'synced'], 'event #3 is delivered even though the phone had seen #50 of the old stream');
  assert.deepEqual(saved, { stream: 'B', seq: 3 }); conn.pause();
});
