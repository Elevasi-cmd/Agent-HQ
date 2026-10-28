// Voice for Atarah over the desktop link: the microphone is recorded in short slices that are uploaded as they arrive,
// the desktop answers with text (and audio once Atarah's voice engine is connected), and any new recording or a tap
// on stop interrupts playback straight away.

export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm']) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export function createVoice({ request, fetchAudio, onState, onReply }) {
  let rec = null, stream = null, turn = null, uploads = Promise.resolve(), audio = null, state = 'idle';
  const set = s => { state = s; onState(s); };
  const newTurn = () => 'v-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function stopPlayback() { if (audio) { try { audio.pause(); } catch (e) {} if (audio._url) URL.revokeObjectURL(audio._url); audio = null; } }

  async function start() {
    stopPlayback();
    if (rec) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This device does not allow microphone recording here.');
    const mime = pickMime(); if (mime === null) throw new Error('Recording is not supported on this device.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    turn = newTurn(); const t = turn, type = rec.mimeType || mime || 'audio/mp4';
    uploads = Promise.resolve();
    rec.ondataavailable = e => { if (!e.data || !e.data.size) return; const blob = e.data; uploads = uploads.then(() => request('/m/voice/chunk?turn=' + t, { method: 'POST', raw: blob, contentType: type, timeout: 20000 })).catch(() => {}); };
    rec.start(500);
    set('recording');
  }

  async function finish() {
    if (!rec) return;
    const t = turn; const r = rec; rec = null;
    await new Promise(ok => { r.onstop = ok; r.stop(); });
    stream.getTracks().forEach(x => x.stop()); stream = null;
    set('thinking');
    await uploads;
    const res = await request('/m/voice/end?turn=' + t, { method: 'POST', timeout: 60000 });
    set('idle');
    if (res.status !== 200 || !res.json) { onReply({ error: (res.json && res.json.error) || 'The desktop did not answer.' }); return; }
    onReply(res.json);
    if (res.json.audio) {
      const blob = await fetchAudio(res.json.audio); if (!blob) return;
      audio = new Audio(); audio._url = URL.createObjectURL(blob); audio.src = audio._url;
      set('speaking'); audio.onended = () => { stopPlayback(); set('idle'); };
      try { await audio.play(); } catch (e) { stopPlayback(); set('idle'); }
    }
  }

  async function cancel() {
    stopPlayback();
    if (rec) { const t = turn; try { rec.stop(); } catch (e) {} rec = null; if (stream) stream.getTracks().forEach(x => x.stop()); stream = null; request('/m/voice/cancel?turn=' + t, { method: 'POST' }).catch(() => {}); }
    set('idle');
  }

  return { start, finish, cancel, stopPlayback, get state() { return state; } };
}
