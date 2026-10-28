// Voice for Atarah over the desktop link. The microphone is captured as 16 kHz mono 16-bit PCM (what Nexus's voice
// route reads without conversion) and uploaded in half-second slices while you speak; the desktop joins them into one
// WAV clip, as Nexus takes a complete clip per turn. A turn is capped at 60 seconds, matching Nexus's microphone limit.
// Tapping again, or a new recording, stops waiting for the old answer on the phone. Nexus itself can't cancel a turn yet.

export const RATE = 16000;
export const MAX_MS = 60000;

// Linear-interpolation resampler that keeps its position across buffers.
export function createResampler(inRate, outRate = RATE) {
  const step = inRate / outRate; let pos = 0, last = 0;
  return function (input) {
    const out = []; const n = input.length;
    while (pos < n) { const i = Math.floor(pos), f = pos - i; const a = i === 0 && f < 0 ? last : input[i], b = i + 1 < n ? input[i + 1] : input[i]; out.push(a + (b - a) * f); pos += step; }
    pos -= n; last = input[n - 1] || 0;
    const pcm = new Int16Array(out.length);
    for (let k = 0; k < out.length; k++) { const v = Math.max(-1, Math.min(1, out[k])); pcm[k] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    return pcm;
  };
}

export function createVoice({ request, fetchAudio, onState, onReply }) {
  let ctx = null, stream = null, src = null, proc = null, turn = null, uploads = Promise.resolve(), pending = [], pendingLen = 0, timer = null, stopAt = 0, audio = null, state = 'idle', live = 0;
  const set = s => { state = s; onState(s); };
  const newTurn = () => 'v-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const type = 'audio/L16;rate=' + RATE + ';channels=1';

  function stopPlayback() { if (audio) { try { audio.pause(); } catch (e) {} if (audio._url) URL.revokeObjectURL(audio._url); audio = null; } }

  function sendSlice(t) {
    if (!pendingLen) return;
    const buf = new Int16Array(pendingLen); let o = 0; for (const p of pending) { buf.set(p, o); o += p.length; }
    pending = []; pendingLen = 0;
    const blob = new Blob([buf.buffer], { type });
    uploads = uploads.then(() => request('/m/voice/chunk?turn=' + t, { method: 'POST', raw: blob, contentType: type, timeout: 20000 })).catch(() => {});
  }

  function teardown() {
    clearInterval(timer); timer = null;
    try { if (src) src.disconnect(); if (proc) proc.disconnect(); } catch (e) {}
    if (stream) stream.getTracks().forEach(x => x.stop());
    if (ctx) ctx.close().catch(() => {});
    ctx = stream = src = proc = null;
  }

  async function start() {
    stopPlayback(); live++;
    if (proc) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This device does not allow microphone recording here.');
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) throw new Error('Recording is not supported on this device.');
    ctx = new AC(); // created inside the tap so iOS lets it run
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
    catch (e) { teardown(); throw new Error('Microphone access was refused. Allow it in Settings, Agent HQ.'); }
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const resample = createResampler(ctx.sampleRate, RATE);
    src = ctx.createMediaStreamSource(stream); proc = ctx.createScriptProcessor(4096, 1, 1);
    turn = newTurn(); const t = turn; uploads = Promise.resolve(); pending = []; pendingLen = 0; stopAt = Date.now() + MAX_MS;
    proc.onaudioprocess = e => { const pcm = resample(e.inputBuffer.getChannelData(0)); pending.push(pcm); pendingLen += pcm.length; e.outputBuffer.getChannelData(0).fill(0); };
    src.connect(proc); proc.connect(ctx.destination);
    timer = setInterval(() => { sendSlice(t); if (Date.now() > stopAt) finish(); }, 500);
    set('recording');
  }

  async function finish() {
    if (!proc) return;
    const t = turn, mine = live; sendSlice(t); teardown();
    set('thinking');
    await uploads;
    let res; try { res = await request('/m/voice/end?turn=' + t, { method: 'POST', timeout: 200000 }); } catch (e) { res = { status: 0, json: null }; }
    if (mine !== live) return; // you started something new; this answer is stale
    set('idle');
    if (res.status !== 200 || !res.json) { onReply({ error: (res.json && res.json.error) || 'The desktop did not answer. The turn may still finish there.' }); return; }
    onReply(res.json);
    if (res.json.audio) {
      const blob = await fetchAudio(res.json.audio); if (!blob || mine !== live) return;
      audio = new Audio(); audio._url = URL.createObjectURL(blob); audio.src = audio._url;
      set('speaking'); audio.onended = () => { stopPlayback(); set('idle'); };
      try { await audio.play(); } catch (e) { stopPlayback(); set('idle'); }
    }
  }

  async function cancel() {
    stopPlayback(); live++;
    if (proc) { const t = turn; teardown(); request('/m/voice/cancel?turn=' + t, { method: 'POST' }).catch(() => {}); }
    set('idle');
  }

  return { start, finish, cancel, stopPlayback, get state() { return state; } };
}
