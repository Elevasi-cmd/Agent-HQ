'use strict';
// The Nexus adapter against a mock of the routes described in the integration handoff (28 Oct 2026):
// GET /api/interaction (static health), POST /api/voice/session (client-state transition), POST /api/voice/turn (multipart clip).
const test = require('node:test'), assert = require('node:assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { createNexusAdapter, wav } = require('../lib/nexus-adapter');

const seen = { session: 0, turns: [] };
let turnReply = { decision: 'voice_turn_completed', normalized_transcript: "what's waiting for me", formatted_voice_response: 'Three decisions are waiting, Boss.', audio_output_path: 'host/path.wav', session_continuity: { turn_count: 1 } };
const server = http.createServer((req, res) => {
  let chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks); const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.method === 'GET' && req.url === '/api/interaction') return send(200, { status: 'healthy', endpoint: '/api/interaction', version: '7C-step3' });
    if (req.method === 'POST' && req.url === '/api/voice/session') { seen.session++; const j = JSON.parse(body); return send(200, { request_id: j.request_id, session_id: j.session_id, new_state: Object.assign({}, j.current_state, { current_state: 'voice_listening_requested' }), reason_code: 'ATARAH_VOICE_SESSION_STARTED' }); }
    if (req.method === 'POST' && req.url === '/api/voice/turn') {
      const b = /boundary=(.+)$/.exec(req.headers['content-type'])[1]; const parts = body.toString('latin1').split('--' + b).filter(p => p.includes('name="'));
      const f = {}; for (const p of parts) { const name = /name="([^"]+)"/.exec(p)[1]; const v = p.slice(p.indexOf('\r\n\r\n') + 4, -2); f[name] = v; }
      seen.turns.push(f); return send(200, turnReply);
    }
    send(404, { error: 'nope' });
  });
});
let base, dir;
test.before(() => new Promise(ok => server.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-')); ok(); })));
test.after(() => server.close());
const emitted = []; const emit = m => emitted.push(m);
const pcm = Buffer.alloc(16000 * 2 * 0.5); // half a second of silence, 16 kHz 16-bit mono

test('WAV wrapper writes a 16 kHz mono PCM header', () => {
  const w = wav(Buffer.alloc(320)); assert.equal(w.toString('ascii', 0, 4), 'RIFF'); assert.equal(w.readUInt16LE(22), 1); assert.equal(w.readUInt32LE(24), 16000); assert.equal(w.readUInt16LE(34), 16); assert.equal(w.length, 364);
});

test('health is read from GET /api/interaction', async () => {
  const a = createNexusAdapter({ emit, dataDir: dir, url: base, voice: true });
  await new Promise(r => setTimeout(r, 200)); const s = a.status();
  assert.equal(s.configured, true); assert.equal(s.reachable, true); assert.equal(s.text, false); assert.equal(s.phoneAudio, false);
});

test('voice is off unless switched on, because Nexus answers through the desktop speakers', async () => {
  const a = createNexusAdapter({ emit, dataDir: dir, url: base, voice: false });
  const r = await a.voiceTurn({ audio: pcm, mime: 'audio/L16;rate=16000', device: 'phone' }); assert.equal(r.reply, null); assert.match(r.note, /off on your desktop/);
  assert.equal(seen.turns.length, 0);
});

test('a voice turn starts a session, sends a WAV clip and returns Atarah\'s text', async () => {
  const a = createNexusAdapter({ emit, dataDir: dir, url: base, voice: true });
  const r = await a.voiceTurn({ audio: pcm, mime: 'audio/L16;rate=16000', device: 'phone' });
  assert.equal(r.reply, 'Three decisions are waiting, Boss.'); assert.equal(r.transcript, "what's waiting for me"); assert.equal(r.desktopPlayback, true);
  const f = seen.turns[0]; assert.equal(f.mime_type, 'audio/wav'); assert.equal(f.audio.slice(0, 4), 'RIFF');
  assert.equal(JSON.parse(f.voice_session_result).new_state.current_state, 'voice_listening_requested'); assert.equal(seen.session, 1);
  // second turn reuses the session and carries continuity forward
  await a.voiceTurn({ audio: pcm, mime: 'audio/L16;rate=16000', device: 'phone' });
  assert.equal(seen.session, 1); assert.deepEqual(JSON.parse(seen.turns[1].voice_session_result).session_continuity, { turn_count: 1 }); assert.equal(seen.turns[1].session_id, f.session_id);
});

test('a failed turn (HTTP 200 with a failure decision) becomes a clear note, not a reply', async () => {
  turnReply = { decision: 'voice_turn_failed', reason_code: 'VOICE_TURN_STT_FAILED', error: 'No implemented local STT runtime available' };
  const a = createNexusAdapter({ emit, dataDir: dir, url: base, voice: true });
  const r = await a.voiceTurn({ audio: pcm, mime: 'audio/L16;rate=16000', device: 'phone2' });
  assert.equal(r.reply, null); assert.match(r.note, /No implemented local STT runtime available.*VOICE_TURN_STT_FAILED/);
});

test('typed messages, tasks and cloud conversations are held for review, never run', async () => {
  const a = createNexusAdapter({ emit, dataDir: dir, url: base, voice: true });
  const c = await a.chat({ text: 'hi', device: 'p' }); const t = await a.task({ text: 'deploy', device: 'p' }); const k = await a.reconcile({ messages: [{ role: 'user', text: 'x' }], device: 'p' });
  assert.ok(c.held && t.held && k.held);
  const kinds = a.held.list().map(x => x.kind); assert.deepEqual(kinds.slice(-3), ['message', 'task', 'cloud-conversation']);
  assert.ok(emitted.some(m => m.type === 'gateway' && /typed messages/.test(m.msg.text)));
  assert.ok(a.held.resolve(a.held.list()[0].id, 'reviewed')); assert.equal(a.held.list()[0].status, 'reviewed');
});
