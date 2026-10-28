'use strict';
// Record of phone commands by id, so a resend after a dropped connection is answered instead of run again.
//
// A command is written down as "started" before it runs and "done" (with its result) after. Outcomes of a repeat:
//   done         -> the first result, marked duplicate
//   in progress  -> still running in this bridge; ask again later
//   uncertain    -> it started but the bridge stopped before recording the result. It is NOT run again;
//                   you check on the desktop and decide whether to send it again.
// This is "at most once per recorded id", not a guarantee of exactly-once: if the record file itself is lost,
// or a command is older than the retention window, the bridge can't recognise a resend.
const fs = require('fs'), path = require('path');
const { writeAtomic } = require('./events');

const KEEP_DAYS = 14, KEEP_MAX = 5000;

function createCommandLog(dataDir) {
  const file = path.join(dataDir, 'commands.json');
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { all = {}; }
  // older files stored { at, result } for finished commands only
  for (const k of Object.keys(all)) if (all[k] && !all[k].state) all[k] = { state: 'done', at: all[k].at, result: all[k].result };
  const running = new Set();

  function save() {
    const ids = Object.keys(all); const cutoff = Date.now() - KEEP_DAYS * 864e5;
    for (const k of ids) if (all[k].at < cutoff && !running.has(k)) delete all[k];
    const left = Object.keys(all); if (left.length > KEEP_MAX) left.sort((a, b) => all[a].at - all[b].at).slice(0, left.length - KEEP_MAX).forEach(k => { if (!running.has(k)) delete all[k]; });
    fs.mkdirSync(dataDir, { recursive: true }); writeAtomic(file, JSON.stringify(all));
  }

  function status(id) {
    const r = all[id];
    if (!r) return { known: false };
    if (r.state === 'done') return { known: true, state: 'done', result: r.result };
    if (running.has(id)) return { known: true, state: 'in-progress' };
    return { known: true, state: 'uncertain', type: r.type, startedAt: r.at };
  }

  // run(id, type, fn): runs fn once for a new id; otherwise reports what is known.
  async function run(id, type, fn) {
    const st = status(id);
    if (st.known) return st;
    all[id] = { state: 'started', type, at: Date.now() }; running.add(id);
    save(); // written before anything happens, so a crash during fn leaves "uncertain", never "unknown"
    try {
      const result = await fn();
      all[id] = { state: 'done', type, at: Date.now(), result }; save();
      return { known: false, state: 'done', result };
    } catch (e) {
      // fn failed in a way we can't classify: keep it uncertain rather than inviting a blind retry
      return { known: false, state: 'uncertain', error: e.message };
    } finally { running.delete(id); }
  }

  return { run, status, file };
}

module.exports = { createCommandLog, KEEP_DAYS };
