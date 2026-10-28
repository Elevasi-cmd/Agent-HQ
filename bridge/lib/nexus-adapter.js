'use strict';
// The bridge is the authenticated gateway in front of Nexus (handoff of 28 Oct 2026: Nexus has no phone-facing pairing,
// auth, stream or idempotency of its own). It only calls Nexus routes that exist and work, and holds everything else
// for you to review on the desktop. Nothing here approves, executes or replays work on Nexus's behalf.
//
//   status()                         -> { name, configured, reachable, text, voice, phoneAudio }
//   chat({ text, device })           -> held for review (Nexus has no working typed-message route yet)
//   task({ text, device })           -> held for review (no task API yet; never auto-run)
//   reconcile({ messages, device })  -> held for review (cloud conversation import is operator-reviewed)
//   voiceTurn({ turn, audio, mime, device }) -> { transcript, reply, decision, note, desktopPlayback }
//   cancelVoice(turn)                -> local only; Nexus cannot cancel an in-flight turn yet
//
// Settings (environment):
//   NEXUS_URL       Nexus's Next.js origin on this desktop, e.g. http://127.0.0.1:3000. Unset = not connected (nothing is simulated).
//   HQ_NEXUS_VOICE  "on" to send phone voice to Atarah. Off by default because Nexus plays her reply through the
//                   desktop's speakers and cannot send audio to the phone yet.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { writeAtomic } = require('./events');

// What Agent HQ needs from Nexus that the current Nexus code does not provide (handoff capabilities.json, 28 Oct 2026).
// Shown in the app so nothing looks connected that isn't. Remove an entry only when the Nexus route really exists.
const MISSING = [
  { id: 'text', label: 'Typed messages to Atarah', why: 'POST /api/interaction fails before running (the __file__ defect); held for your review instead' },
  { id: 'phone-audio', label: "Atarah's voice on the phone", why: 'Nexus returns a desktop file path, not audio; she speaks on the desktop' },
  { id: 'tasks', label: 'Create, assign and track tasks', why: 'no task API; tasks are held for your review' },
  { id: 'approvals', label: 'Nexus approvals', why: 'no HTTP approval authority; only Claude Code steps can be approved' },
  { id: 'cancel', label: 'Stop a running turn', why: 'no in-flight cancellation; the phone just stops waiting' },
  { id: 'events', label: 'Live Nexus events', why: 'no event stream; the bridge streams its own events' },
  { id: 'dedup', label: 'Duplicate protection inside Nexus', why: 'none; the bridge never retries a Nexus call' },
  { id: 'continuity', label: 'Conversation memory across turns', why: 'turn counts carry over, but past turns are not fed back to her model' },
];

const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

function heldStore(dataDir) {
  const file = path.join(dataDir, 'held-for-review.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return []; } };
  return {
    // item.cmd is the phone's command id: adding the same command twice returns the first entry
    add(kind, item) {
      const all = load();
      if (item && item.cmd) { const prev = all.find(x => x.cmd === item.cmd); if (prev) return prev.id; }
      const id = 'r' + crypto.randomBytes(4).toString('hex');
      all.push(Object.assign({ id, kind, at: new Date().toISOString(), status: 'waiting for your review' }, item));
      writeAtomic(file, JSON.stringify(all, null, 2)); return id;
    },
    list: () => load(),
    resolve(id, status) { const all = load(); const it = all.find(x => x.id === id); if (!it) return false; it.status = status; it.reviewedAt = new Date().toISOString(); writeAtomic(file, JSON.stringify(all, null, 2)); return true; },
  };
}

// WAV wrapper for 16-bit PCM, which Nexus's normaliser accepts without FFmpeg at 16 kHz mono.
function wav(pcm, rate = 16000, channels = 1) {
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]);
}

function multipart(fields, file) {
  const b = '----agenthq' + crypto.randomBytes(8).toString('hex'); const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="audio"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(parts), type: 'multipart/form-data; boundary=' + b };
}

function createNexusAdapter({ emit, dataDir, url = process.env.NEXUS_URL, voice = process.env.HQ_NEXUS_VOICE === 'on', fetchImpl = (...a) => fetch(...a) }) {
  const held = heldStore(dataDir);
  const base = url ? String(url).replace(/\/+$/, '') : null;
  let reachable = null, checkedAt = 0;
  const sessions = new Map(); // device -> { session_id, result, at }

  async function health() {
    if (!base) return;
    try { const r = await fetchImpl(base + '/api/interaction', { signal: AbortSignal.timeout(4000) }); const j = await r.json().catch(() => null); reachable = r.ok && !!j && j.status === 'healthy'; }
    catch (e) { reachable = false; }
    checkedAt = Date.now();
  }
  if (base) { health(); setInterval(health, 30000).unref(); }

  const note = (text) => emit({ type: 'gateway', msg: { type: 'note', text } });

  async function session(device) {
    const s = sessions.get(device);
    if (s && Date.now() - s.at < 30 * 60000) return s;
    const session_id = 'agenthq-' + crypto.randomBytes(6).toString('hex');
    const created_at = new Date().toISOString();
    const body = { request_id: 'req-' + crypto.randomBytes(6).toString('hex'), session_id, action: 'start_session', current_state: { session_id, current_state: 'voice_idle', is_muted: false, is_held: false, operator_present: true, protected_flow: false }, operator_present: true, protected_flow: false, created_at };
    const r = await fetchImpl(base + '/api/voice/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.new_state) throw new Error((j && (j.error || j.reason_code)) || 'Atarah would not start a voice session (' + r.status + ').');
    const ns = { session_id, result: j, at: Date.now() }; sessions.set(device, ns); return ns;
  }

  return {
    status: () => ({ name: base ? 'Nexus' : 'not connected', configured: !!base, reachable: base ? reachable : false, checkedAt, text: false, voice: !!base && voice, phoneAudio: false, missing: MISSING.map(m => m.label) }),
    async chat({ text, device, cmd }) {
      const id = held.add('message', { text: clip(text, 4000), device, cmd });
      note(base ? "Atarah can't take typed messages yet (Nexus has no working text route), so this is kept on your desktop for you to review." : "Nexus isn't connected to the bridge yet, so this is kept on your desktop for you to review.");
      return { accepted: true, held: true, reviewId: id };
    },
    async task({ text, device, cmd }) { const id = held.add('task', { text: clip(text, 4000), device, cmd }); return { queued: true, held: true, reviewId: id }; },
    async reconcile({ messages, device, cmd }) { const id = held.add('cloud-conversation', { messages: (messages || []).slice(-200), device, cmd }); return { received: (messages || []).length, held: true, reviewId: id }; },
    async voiceTurn({ audio, mime, device }) {
      if (!base) return { transcript: null, reply: null, note: `Your voice reached the desktop (${Math.max(1, Math.round(audio.length / 1024))} KB), but Nexus isn't connected to the bridge yet.` };
      if (!voice) return { transcript: null, reply: null, note: "Voice to Atarah is off on your desktop. Turning it on makes her answer through the desktop's speakers; the phone shows the text." };
      let data = audio, type = mime || 'audio/wav', name = 'turn.wav';
      if (/^audio\/L16/i.test(type)) { data = wav(audio, +((/rate=(\d+)/.exec(type) || [])[1] || 16000)); type = 'audio/wav'; }
      else if (/mp4|m4a|aac/.test(type)) name = 'turn.m4a'; else if (/webm/.test(type)) name = 'turn.webm';
      let s;
      try { s = await session(device); } catch (e) { return { transcript: null, reply: null, note: e.message }; }
      const voice_session_result = Object.assign({}, s.result, s.continuity ? { session_continuity: s.continuity } : {});
      const mp = multipart({ session_id: s.session_id, voice_session_result: JSON.stringify(voice_session_result), mime_type: type }, { name, mime: type, data });
      let r, j;
      try { r = await fetchImpl(base + '/api/voice/turn', { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body, signal: AbortSignal.timeout(180000) }); j = await r.json().catch(() => null); }
      catch (e) { return { transcript: null, reply: null, note: 'Nexus did not answer in time. The turn may still finish on your desktop.' }; }
      if (!j) return { transcript: null, reply: null, note: `Nexus answered ${r.status} without a readable result.` };
      s.at = Date.now(); if (j.session_continuity) s.continuity = j.session_continuity;
      const reply = j.formatted_voice_response || (j.response_result && (j.response_result.response_text || j.response_result.text || j.response_result.formatted_response)) || null;
      const why = [j.reason_code, ...(j.held_reasons || []), ...(j.blocked_reasons || [])].filter(Boolean).join(', ');
      return {
        transcript: j.normalized_transcript || j.raw_transcript || null, reply, decision: j.decision || null,
        note: reply ? null : (j.error ? `Atarah couldn't answer: ${j.error}${why ? ' (' + why + ')' : ''}.` : `Atarah didn't give a reply${why ? ' (' + why + ')' : ''}.`),
        desktopPlayback: !!(j.audio_output_path || j.tts_artifact_path), audio: null,
      };
    },
    cancelVoice() { /* Nexus has no cancellation for a running turn; the phone just stops waiting. */ },
    held,
  };
}

module.exports = { createNexusAdapter, clip, wav, multipart, MISSING };
