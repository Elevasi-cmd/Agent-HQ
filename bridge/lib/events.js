'use strict';
// Event log that survives bridge restarts, so a phone or page that was away can catch up or learn it must resync.
//
// Every event gets a number. Numbers keep counting across restarts, inside a "stream" whose id is stored with them.
// If the stored log is lost or unreadable, a new stream starts and every client is told to resync.
// The log holds the last `size` events (prompts and commands included), in <dataDir>/events.json, readable only by you.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file);
}

function createEventLog({ dataDir, size = 500, delay = 200 }) {
  const file = path.join(dataDir, 'events.json');
  let stream, seq = 0, ring = [], timer = null, restored = false;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && typeof j.stream === 'string' && Number.isInteger(j.seq) && Array.isArray(j.ring)) { stream = j.stream; seq = j.seq; ring = j.ring.filter(e => e && Number.isInteger(e.s) && e.s <= seq).slice(-size); restored = true; }
  } catch (e) { /* no log yet, or unreadable: start a new stream */ }
  if (!stream) stream = 's' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

  function flushSync() { clearTimeout(timer); timer = null; try { fs.mkdirSync(dataDir, { recursive: true }); writeAtomic(file, JSON.stringify({ stream, seq, ring })); } catch (e) { console.warn('event log not saved:', e.message); } }
  function schedule() { if (!timer) { timer = setTimeout(flushSync, delay); if (timer.unref) timer.unref(); } }

  // Held steps and their outcomes are written at once, so even a crash right after can't lose them; the rest is
  // batched (at most `delay` ms of other events can be lost if the process is killed).
  const durable = m => (m.type === 'hook' && m.gated) || m.type === 'decided' || m.type === 'expired';
  function append(msg) { const s = ++seq; ring.push({ s, msg }); if (ring.length > size) ring.shift(); if (durable(msg)) flushSync(); else schedule(); return s; }

  // Held steps that were waiting when the bridge stopped can no longer be answered: Claude Code's request died with it.
  function orphanedHooks() {
    const open = new Map();
    for (const { msg } of ring) {
      if (msg.type === 'hook' && msg.gated && msg.id) open.set(msg.id, msg);
      else if ((msg.type === 'decided' || msg.type === 'expired') && msg.id) open.delete(msg.id);
    }
    return [...open.keys()];
  }

  // since: last event number the client saw; clientStream: the stream it was in (if it knows).
  // Returns where to replay from and whether the client must rebuild its view (resync).
  function replay(since, clientStream) {
    since = Math.max(0, Math.floor(+since || 0));
    const oldest = ring.length ? ring[0].s : seq + 1;
    let from = since, resync = false, reason = null;
    if (clientStream && clientStream !== stream) { from = 0; resync = true; reason = 'new-stream'; }
    else if (since > seq) { from = 0; resync = true; reason = 'ahead'; }
    else if (since && since < oldest - 1) { from = 0; resync = true; reason = 'gap'; }
    return { from, resync, reason, items: ring.filter(e => e.s > from) };
  }

  return { get stream() { return stream; }, get seq() { return seq; }, get restored() { return restored; }, append, replay, orphanedHooks, flushSync, file };
}

module.exports = { createEventLog, writeAtomic };
