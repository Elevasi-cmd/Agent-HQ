// Link to the desktop bridge: health checks, a resumable event stream and authenticated posts.
// States: 'unpaired' | 'connecting' | 'local' (desktop reachable) | 'unreachable' (paired, desktop away) | 'offline' (no network)

export function parseSSE(buf, onMsg) {
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    let id = null, data = [];
    for (const line of block.split('\n')) { if (line.startsWith('id: ')) id = +line.slice(4); else if (line.startsWith('data: ')) data.push(line.slice(6)); }
    if (data.length) { try { onMsg(JSON.parse(data.join('\n')), id); } catch (e) { /* ignore a bad line */ } }
  }
  return buf;
}

export function createConn({ getBase, getToken, onEvent, onState, fetchImpl = (...a) => fetch(...a), loadSeq = async () => 0, saveSeq = async () => {} }) {
  let state = 'connecting', ctrl = null, timer = null, backoff = 2000, online = true, lastSeq = 0, seqLoaded = false, stopped = false;
  const set = s => { if (s !== state) { state = s; onState(s); } };
  const url = p => getBase().replace(/\/+$/, '') + p;
  async function headers() { const t = await getToken(); return t ? { Authorization: 'Bearer ' + t } : {}; }

  async function request(path, { method = 'GET', body, raw, contentType, timeout = 10000 } = {}) {
    const h = await headers();
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (raw !== undefined) h['Content-Type'] = contentType || 'application/octet-stream';
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetchImpl(url(path), { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined, signal: ac.signal });
      let j = null; try { j = await r.json(); } catch (e) {}
      if (r.status === 401) { set('unpaired'); }
      return { status: r.status, json: j };
    } finally { clearTimeout(t); }
  }

  function schedule(ms) { clearTimeout(timer); if (!stopped) timer = setTimeout(connect, ms); }

  async function connect() {
    clearTimeout(timer);
    if (stopped) return;
    if (!getBase() || !(await getToken())) { set('unpaired'); return; }
    if (!online) { set('offline'); return; }
    if (!seqLoaded) { lastSeq = +(await loadSeq()) || 0; seqLoaded = true; }
    if (ctrl) ctrl.abort();
    ctrl = new AbortController(); const my = ctrl;
    if (state !== 'local') set('connecting');
    try {
      const r = await fetchImpl(url('/m/events?since=' + lastSeq), { headers: await headers(), signal: my.signal });
      if (r.status === 401) { set('unpaired'); return; }
      if (!r.ok || !r.body) throw new Error('status ' + r.status);
      set('local'); backoff = 2000;
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf = parseSSE(buf + dec.decode(value, { stream: true }), (msg, id) => {
          if (id != null) { if (id <= lastSeq) return; lastSeq = id; saveSeq(id); }
          if (msg.type === 'resync') { lastSeq = 0; saveSeq(0); }
          onEvent(msg);
        });
      }
      throw new Error('stream ended');
    } catch (e) {
      if (my.signal.aborted && (stopped || ctrl !== my)) return;
      if (state !== 'unpaired') { set(online ? 'unreachable' : 'offline'); onEvent({ type: 'bridge-down' }); }
      schedule(backoff); backoff = Math.min(30000, backoff * 2);
    }
  }

  return {
    get state() { return state; },
    get lastSeq() { return lastSeq; },
    connect,
    request,
    pause() { stopped = true; clearTimeout(timer); if (ctrl) ctrl.abort(); },
    resume() { stopped = false; backoff = 2000; connect(); },
    setOnline(v) { online = v; if (v) { backoff = 2000; connect(); } else { if (ctrl) ctrl.abort(); set('offline'); } },
    reset() { lastSeq = 0; saveSeq(0); if (ctrl) ctrl.abort(); connect(); },
  };
}
