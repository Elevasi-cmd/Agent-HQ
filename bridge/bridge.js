#!/usr/bin/env node
// Agent HQ bridge: receives Claude Code's HTTP hooks and streams them into Agent HQ (desktop page and paired phones).
// Shell commands and file edits wait (up to HQ_TIMEOUT seconds) for your decision in Agent HQ.
// No dependencies. Listens on 127.0.0.1 only; reach it from your phone through Tailscale (see README).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os');
const { createDevices } = require('./lib/devices');
const { createApns } = require('./lib/apns');
const { createNexusAdapter, clip } = require('./lib/nexus-adapter');
const { createEventLog, writeAtomic } = require('./lib/events');
const { createCommandLog } = require('./lib/commands');

const PORT = +(process.env.HQ_PORT || 4317);
const HOST = process.env.HQ_HOST || '127.0.0.1';
const TIMEOUT = +(process.env.HQ_TIMEOUT || 300);              // seconds to wait for a decision
const GATE = new RegExp(process.env.HQ_GATE || '^(Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit)$');
const HTML = path.join(__dirname, 'agent-hq.html');
const NEXUS_KEY = process.env.HQ_NEXUS_KEY || crypto.randomBytes(12).toString('hex'); // Nexus OS sends this to move and speak through Atarah
const DATA = process.env.HQ_DATA || path.join(os.homedir(), '.agent-hq');
// The page key proves a request came from the page this bridge served. It is kept across restarts (in the data folder,
// readable only by you) so an open page reconnects by itself instead of being locked out.
const TOKEN = (() => { const f = path.join(DATA, 'page-key'); try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{36}$/.test(t)) return t; } catch (e) {} const t = crypto.randomBytes(18).toString('hex'); try { fs.mkdirSync(DATA, { recursive: true, mode: 0o700 }); writeAtomic(f, t); } catch (e) { console.warn('page key not saved:', e.message); } return t; })();
const APP_ORIGINS = (process.env.HQ_APP_ORIGINS || 'capacitor://localhost,ionic://localhost').split(',').map(s => s.trim()).filter(Boolean);

const clients = new Set();          // open Agent HQ pages (server-sent events)
const phones = new Map();           // res -> device id (phones streaming events)
const pending = new Map();          // id -> { res, timer, msg }
const devices = createDevices(DATA);
const apns = (() => { try { return createApns({ keyFile: process.env.HQ_APNS_KEY_FILE, keyId: process.env.HQ_APNS_KEY_ID, teamId: process.env.HQ_APNS_TEAM_ID, topic: process.env.HQ_APNS_TOPIC, production: process.env.HQ_APNS_ENV !== 'sandbox' }); } catch (e) { console.warn('APNs key could not be read:', e.message); return null; } })();
let seq = 0;
const events = createEventLog({ dataDir: DATA, size: 500 }); // numbered events, kept across restarts for catch-up
const commands = createCommandLog(DATA);

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
function send(msg) {
  const s = events.append(msg);
  const line = `id: ${s}\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) c.write(line);
  for (const c of phones.keys()) c.write(line);
}
const adapter = createNexusAdapter({ emit: send, dataDir: DATA });

// Held steps that were waiting when the bridge last stopped can't be answered any more; say so once, in the log.
for (const id of events.orphanedHooks()) send({ type: 'expired', id, reason: 'bridge-restarted' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { events.flushSync(); process.exit(0); });
process.on('exit', () => events.flushSync());

// Writes the hello, the missed events and a "synced" marker listing what is really waiting now.
function openStream(res, since, clientStream, extra) {
  const r = events.replay(since, clientStream);
  const pend = [...pending.values()].map(x => x.msg);
  res.write(`data: ${JSON.stringify(Object.assign({ type: 'hello', stream: events.stream, seq: events.seq, from: r.from, resync: r.resync, reason: r.reason, nexus: adapter.status(), pending: pend }, extra))}\n\n`);
  for (const e of r.items) res.write(`id: ${e.s}\ndata: ${JSON.stringify(e.msg)}\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'synced', seq: events.seq, pending: pend.map(m => m.id) })}\n\n`);
  return r;
}

// Keep what the page needs; drop transcript paths and trim large inputs such as whole-file writes.
function slim(ev) {
  const keep = ['session_id', 'cwd', 'permission_mode', 'hook_event_name', 'tool_name', 'tool_use_id', 'prompt', 'message', 'last_assistant_message', 'reason', 'source'];
  const o = {}; for (const k of keep) if (ev[k] !== undefined) o[k] = typeof ev[k] === 'string' ? ev[k].slice(0, 4000) : ev[k];
  if (ev.tool_input) { o.tool_input = {}; for (const [k, v] of Object.entries(ev.tool_input)) o.tool_input[k] = typeof v === 'string' ? v.slice(0, 2000) : v; }
  return o;
}

function raw(req, limit) {
  return new Promise((ok, bad) => { const parts = []; let n = 0; req.on('data', d => { n += d.length; if (n > limit) { bad(new Error('too large')); req.destroy(); } else parts.push(d); }); req.on('end', () => ok(Buffer.concat(parts))); req.on('error', bad); });
}
async function body(req) { const b = await raw(req, 5e6); return JSON.parse(b.toString('utf8') || '{}'); }
function json(res, code, obj, extra) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, extra || {})); res.end(obj === undefined ? '' : JSON.stringify(obj)); }

function decision(kind, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: kind, permissionDecisionReason: reason } };
}
function applyDecision(id, d, reason, who) {
  const p = pending.get(id);
  if (!p) return { status: 410, body: { error: 'no longer waiting' } };
  clearTimeout(p.timer); pending.delete(id);
  const kind = d === 'allow' ? 'allow' : 'deny';
  json(p.res, 200, decision(kind, String(reason || (kind === 'allow' ? 'Approved in Agent HQ' : 'Declined in Agent HQ')).slice(0, 500)));
  send({ type: 'decided', id, decision: kind, by: who || 'desktop' }); log(kind === 'allow' ? 'allowed' : 'denied', id, who ? 'from ' + who : '');
  return { status: 200, body: { ok: true } };
}

function pushAll(title, text, data) {
  if (!apns) return;
  const streaming = new Set(phones.values());
  for (const d of devices.withPush()) {
    if (streaming.has(d.id)) continue; // that phone is open and already sees it
    apns.send(d.apns, { title, body: text, data }).then(r => { if (!r.ok) log('push failed for', d.name, r.status || r.error, r.body || ''); });
  }
}

// Tailscale addresses on this computer, as a pairing hint only. Some systems and sandboxes refuse to list network
// interfaces (or throw); then we say we couldn't tell, and pairing carries on with the address you type in the app.
function tailscaleHosts(list = os.networkInterfaces) {
  let ifs;
  try { ifs = list(); } catch (e) { return { hosts: [], available: false }; }
  const out = [];
  try { for (const addrs of Object.values(ifs || {})) for (const a of addrs || []) if (a && (a.family === 'IPv4' || a.family === 4) && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) out.push(a.address); }
  catch (e) { return { hosts: [], available: false }; }
  return { hosts: out, available: true };
}
const listInterfaces = process.env.HQ_TEST_NO_INTERFACES === '1' ? () => { throw new Error('uv_interface_addresses returned Unknown system error 1'); } : os.networkInterfaces;

function cors(req, res) {
  const o = req.headers.origin;
  if (o && APP_ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Cmd-Id'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS'); res.setHeader('Access-Control-Max-Age', '600'); }
}
function pageOnly(req) { const origin = req.headers.origin || ''; return req.headers['x-hq-token'] === TOKEN && (!origin || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)); }

const voice = new Map(); // turn -> { parts, size, mime, device, at }
const voiceOut = new Map(); // audio id -> { mime, data, at }
setInterval(() => { const old = Date.now() - 120000; for (const [k, v] of voice) if (v.at < old) voice.delete(k); for (const [k, v] of voiceOut) if (v.at < old - 480000) voiceOut.delete(k); }, 30000).unref();

async function phoneRoute(req, res, url, dev) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/m/ping') return json(res, 200, { ok: true, device: dev.name, nexus: adapter.status(), stream: events.stream, seq: events.seq, waiting: pending.size });
  if (req.method === 'GET' && p === '/m/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n: connected\n\n'); phones.set(res, dev.id);
    const since = +(url.searchParams.get('since') || 0);
    const r = openStream(res, since, url.searchParams.get('stream') || null, { phone: true });
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); phones.delete(res); log('phone disconnected:', dev.name); });
    log('phone connected:', dev.name, r.resync ? `(resync: ${r.reason})` : since ? `(catching up from #${since})` : ''); return;
  }
  // what happened to a command whose answer the phone never got (approvals are checked this way, never blindly resent)
  if (req.method === 'GET' && p.startsWith('/m/command/')) { const id = decodeURIComponent(p.slice(11)); return json(res, 200, commands.status(id)); }
  if (req.method === 'POST' && p === '/m/command') {
    const c = await body(req);
    if (!c || typeof c.id !== 'string' || !/^[\w-]{8,80}$/.test(c.id)) return json(res, 400, { error: 'every command needs an id' });
    if (!['decide', 'chat', 'task', 'reconcile'].includes(c.type)) return json(res, 400, { error: 'unknown command' });
    const out = await commands.run(c.id, c.type, async () => {
      switch (c.type) {
        case 'decide': { const r = applyDecision(String(c.hookId || ''), c.decision, c.reason, dev.name); return r.status === 200 ? { ok: true } : { ok: false, gone: true, error: r.body.error }; }
        case 'chat': return Object.assign({ ok: true }, await adapter.chat({ text: clip(c.text, 4000), device: dev.name, cmd: c.id }));
        case 'task': return Object.assign({ ok: true }, await adapter.task({ text: clip(c.text, 4000), device: dev.name, cmd: c.id }));
        case 'reconcile': return Object.assign({ ok: true }, await adapter.reconcile({ messages: Array.isArray(c.messages) ? c.messages.slice(-200) : [], device: dev.name, cmd: c.id }));
      }
    });
    if (out.state === 'done') { if (!out.known) log('phone command', c.type, c.id); return json(res, 200, out.known ? Object.assign({ duplicate: true }, out.result) : out.result); }
    if (out.state === 'in-progress') return json(res, 409, { inProgress: true, error: 'Still being handled. The app will check again.' });
    log('phone command outcome uncertain', c.type, c.id);
    return json(res, 200, { ok: false, uncertain: true, error: 'This started on the desktop but the bridge stopped before it finished, so it may or may not have happened. It was not run again. Check on the desktop before sending it again.' });
  }
  if (req.method === 'POST' && p === '/m/push-token') { const b = await body(req); devices.setApns(dev.id, b.token); return json(res, 200, { ok: true, push: !!apns }); }
  if (req.method === 'DELETE' && p === '/m/device') { devices.remove(dev.id); log('phone unpaired itself:', dev.name); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/m/voice/chunk') {
    const turn = String(url.searchParams.get('turn') || ''); if (!/^[\w-]{6,60}$/.test(turn)) return json(res, 400, { error: 'bad turn' });
    const buf = await raw(req, 2e6); const t = voice.get(turn) || { parts: [], size: 0, mime: req.headers['content-type'] || 'audio/mp4', device: dev.id, at: Date.now() };
    if (t.size + buf.length > 15e6) return json(res, 413, { error: 'too long' });
    t.parts.push(buf); t.size += buf.length; t.at = Date.now(); voice.set(turn, t); return json(res, 200, { ok: true, size: t.size });
  }
  if (req.method === 'POST' && p === '/m/voice/end') {
    const turn = String(url.searchParams.get('turn') || ''); const t = voice.get(turn); voice.delete(turn);
    if (!t) return json(res, 404, { error: 'no audio for that turn' });
    const r = await adapter.voiceTurn({ turn, audio: Buffer.concat(t.parts), mime: t.mime, device: dev.name });
    let audioId = null; if (r.audio && r.audio.data) { audioId = crypto.randomBytes(8).toString('hex'); voiceOut.set(audioId, { mime: r.audio.mime || 'audio/mpeg', data: Buffer.from(r.audio.data), at: Date.now() }); }
    return json(res, 200, { transcript: r.transcript || null, reply: r.reply || null, note: r.note || null, decision: r.decision || null, desktopPlayback: !!r.desktopPlayback, audio: audioId ? '/m/voice/audio/' + audioId : null });
  }
  if (req.method === 'POST' && p === '/m/voice/cancel') { const turn = String(url.searchParams.get('turn') || ''); voice.delete(turn); adapter.cancelVoice(turn); return json(res, 200, { ok: true }); }
  if (req.method === 'GET' && p.startsWith('/m/voice/audio/')) { const a = voiceOut.get(p.split('/').pop()); if (!a) return json(res, 404, { error: 'gone' }); res.writeHead(200, { 'Content-Type': a.mime, 'Cache-Control': 'no-store' }); return res.end(a.data); }
  return json(res, 404, { error: 'not found' });
}

const pairTries = [];
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    // ---------- phones ----------
    if (url.pathname.startsWith('/m/')) {
      cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (req.method === 'POST' && url.pathname === '/m/pair') {
        const now = Date.now(); while (pairTries.length && now - pairTries[0] > 60000) pairTries.shift();
        if (pairTries.length >= 20) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
        pairTries.push(now);
        const b = await body(req); const r = devices.claim(b.code, b.name);
        if (r.error) return json(res, r.status, { error: r.error });
        log('phone paired:', r.device.name); send({ type: 'paired', name: r.device.name });
        return json(res, 200, { deviceId: r.device.id, token: r.token, name: r.device.name });
      }
      const dev = devices.auth(req.headers.authorization);
      if (!dev) return json(res, 401, { error: 'This phone is not paired, or was removed. Pair it again from your desktop.' });
      return await phoneRoute(req, res, url, dev);
    }
    // ---------- desktop page ----------
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(HTML, 'utf8').replace('<script>', `<script>window.HQ_BRIDGE=${JSON.stringify({ token: TOKEN, port: PORT })};</script>\n<script>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (url.searchParams.get('t') !== TOKEN) return json(res, 403, { error: 'bad token' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n: connected\n\n'); clients.add(res);
      // EventSource resends the last id it saw after a drop or a bridge restart; replay from there
      openStream(res, +(req.headers['last-event-id'] || url.searchParams.get('since') || 0) || 0, null, {});
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); log('Agent HQ page disconnected'); });
      log('Agent HQ page connected'); return;
    }
    if (req.method === 'POST' && url.pathname === '/pair/start') {
      if (!pageOnly(req)) return json(res, 403, { error: 'not allowed' });
      const r = devices.startPairing(); log('pairing code issued (10 minutes)');
      const tsr = tailscaleHosts(listInterfaces); return json(res, 200, Object.assign(r, { tailscale: tsr.hosts, interfacesAvailable: tsr.available, port: PORT }));
    }
    // things phones sent that wait for you on the desktop (typed messages, tasks, cloud conversations); nothing here runs by itself
    if (req.method === 'GET' && url.pathname === '/held') { if (!pageOnly(req)) return json(res, 403, { error: 'not allowed' }); return json(res, 200, { items: adapter.held.list().slice(-50).reverse() }); }
    if (req.method === 'POST' && url.pathname === '/held/resolve') { if (!pageOnly(req)) return json(res, 403, { error: 'not allowed' }); const b = await body(req); const ok = adapter.held.resolve(String(b.id || ''), b.status === 'dismissed' ? 'dismissed' : 'reviewed'); return json(res, ok ? 200 : 404, { ok }); }
    if (req.method === 'GET' && url.pathname === '/devices') { if (!pageOnly(req)) return json(res, 403, { error: 'not allowed' }); return json(res, 200, { devices: devices.list(), push: !!apns }); }
    if (req.method === 'POST' && url.pathname === '/devices/revoke') { if (!pageOnly(req)) return json(res, 403, { error: 'not allowed' }); const b = await body(req); const ok = devices.remove(String(b.id || '')); if (ok) { for (const [r, id] of phones) if (id === b.id) r.end(); log('phone removed', b.id); } return json(res, ok ? 200 : 404, { ok }); }
    // Claude Code's hooks. The static header stops other web pages posting here (they can't send it without a preflight we never answer).
    if (req.method === 'POST' && url.pathname === '/hook') {
      if (req.headers['x-agent-hq'] !== 'hook') return json(res, 403, { error: 'missing header' });
      const ev = await body(req); const name = ev.hook_event_name;
      const someoneCanDecide = clients.size > 0 || phones.size > 0 || devices.withPush().length > 0;
      const gated = name === 'PreToolUse' && GATE.test(ev.tool_name || '') && someoneCanDecide;
      if (!gated) { send({ type: 'hook', ev: slim(ev) }); return json(res, 200); }
      // Hold Claude Code here until you decide in Agent HQ, or time out and hand back to Claude Code's own prompt.
      const id = 'h' + (++seq) + '-' + crypto.randomBytes(3).toString('hex');
      const msg = { type: 'hook', id, gated: true, ev: slim(ev) };
      const timer = setTimeout(() => { if (!pending.has(id)) return; pending.delete(id); send({ type: 'expired', id }); log('timed out', id, '-> Claude Code asks you itself'); json(res, 200); }, TIMEOUT * 1000);
      pending.set(id, { res, timer, msg });
      req.on('close', () => { if (pending.has(id) && !res.writableEnded) { clearTimeout(timer); pending.delete(id); send({ type: 'expired', id }); log('Claude Code stopped waiting', id); } });
      send(msg); log('waiting for your decision:', ev.tool_name, (ev.tool_input && (ev.tool_input.command || ev.tool_input.file_path)) || '');
      const what = ev.tool_input && (ev.tool_input.command || ev.tool_input.file_path) || ev.tool_name;
      pushAll('Claude Code is waiting for you', clip(`${ev.tool_name}: ${what}`, 120), { hookId: id });
      return;
    }
    // your decision from the page
    if (req.method === 'POST' && url.pathname === '/decide') {
      if (!pageOnly(req)) return json(res, 403, { error: 'not allowed' });
      const { id, decision: d, reason } = await body(req);
      const r = applyDecision(id, d, reason); return json(res, r.status, r.body);
    }
    // Nexus OS: moves Atarah between floors, sets her presence, or speaks through her. Server-to-server only (no browser Origin).
    if (req.method === 'POST' && url.pathname === '/nexus') {
      if (req.headers['x-nexus-key'] !== NEXUS_KEY || req.headers.origin) return json(res, 403, { error: 'not allowed' });
      const m = await body(req); let out = null;
      if (m.type === 'presence' && ['working', 'meeting', 'focus', 'away'].includes(m.status)) out = { type: 'presence', status: m.status };
      else if (m.type === 'goto' && /^f[0-7]$/.test(String(m.floor || ''))) out = { type: 'goto', floor: m.floor };
      else if (m.type === 'say' && typeof m.text === 'string' && m.text.trim()) out = { type: 'say', text: m.text.trim().slice(0, 140) };
      else if (m.type === 'notify' && typeof m.text === 'string' && m.text.trim()) out = { type: 'notify', text: m.text.trim().slice(0, 200) };
      if (!out) return json(res, 400, { error: 'expected {type:"presence",status}, {type:"goto",floor}, {type:"say",text} or {type:"notify",text}' });
      send({ type: 'nexus', msg: out }); log('nexus', out.type, out.status || out.floor || '');
      if (out.type === 'notify') pushAll('Atarah', out.text, {});
      return json(res, 200, { ok: true, pages: clients.size, phones: phones.size });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) { log('error', e.message); if (!res.headersSent) json(res, 400, { error: 'bad request' }); }
});

server.listen(PORT, HOST, () => {
  const tsr = tailscaleHosts(listInterfaces), ts = tsr.hosts;
  console.log(`\nAgent HQ bridge running.\n  Open:   http://${HOST}:${PORT}\n  Gated:  ${GATE.source}  (wait up to ${TIMEOUT}s for your decision)\n  Hooks:  run "node install-hooks.js" in your project if you haven't yet.\n  Nexus key: POST /nexus with header X-Nexus-Key: ${NEXUS_KEY}\n  Nexus:  ${process.env.NEXUS_URL ? process.env.NEXUS_URL + ' · phone voice ' + (process.env.HQ_NEXUS_VOICE === 'on' ? 'on (Atarah answers through this computer\'s speakers)' : 'off') : 'not connected (nothing simulated). Set NEXUS_URL to your Nexus origin, e.g. http://127.0.0.1:3000'}
  Phones: ${devices.list().length} paired · push ${apns ? 'on' : 'off'} · ${ts.length ? 'Tailscale ' + ts.join(', ') + ' (use "tailscale serve" for HTTPS)' : tsr.available ? 'Tailscale not detected' : 'network addresses unavailable on this system (pairing still works with your Tailscale name)'}\n  Events: #${events.seq}${events.restored ? ' (restored after restart)' : ' (new log)'}\n  Data:   ${DATA}\n`);
  if (process.argv.includes('--pair')) { const r = devices.startPairing(); console.log(`  Pairing code: ${r.code}  (valid 10 minutes; enter it in the Agent HQ app)\n`); }
});
