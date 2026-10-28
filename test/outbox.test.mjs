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
test('a command caught mid-send by app suspension is resent with its original id', async () => {
  const st = mem(); const ob = createOutbox(st); await ob.load(); const a = await ob.add('decide', { hookId: 'h1', decision: 'allow' });
  const saved = st.peek(); saved[0].state = 'sending'; await st.save(saved);
  const ob2 = createOutbox(st); await ob2.load(); assert.equal(ob2.items[0].state, 'queued');
  const ids = []; await ob2.flush(async it => { ids.push(it.id); return { ok: true, duplicate: true }; });
  assert.deepEqual(ids, [a.id]); assert.equal(ob2.items[0].state, 'done');
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
