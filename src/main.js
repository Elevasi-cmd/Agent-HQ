// Agent HQ for iPhone. Wraps the office page with: the desktop link (Tailscale + device pairing), a queue whose
// resends are answered by the bridge's record instead of being run again (and which says so when it can't be sure), Atarah's talk panel (text and voice), a cloud fallback that runs on the phone, and alerts.
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { PushNotifications } from '@capacitor/push-notifications';
import { StatusBar, Style } from '@capacitor/status-bar';
import { kv, secrets } from './store.js';
import { createConn } from './conn.js';
import { createOutbox } from './outbox.js';
import * as H from './harness.js';
import { createVoice } from './voice.js';

const native = Capacitor.isNativePlatform();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

const S = { link: { base: '', name: 'iPhone', deviceId: null }, fb: H.defaults(), usage: null, talk: [], reconciledAt: 0, nexus: null, tab: 'talk', voice: 'idle', online: true, pushToken: null, desktopTask: false };

// ---------- transport for the office page ----------
const listeners = [], early = [];
window.HQ_TRANSPORT = {
  stream(fn) { listeners.push(fn); early.splice(0).forEach(m => fn(m)); },
  // approvals go only while the desktop is connected; one whose delivery is uncertain is checked, never resent
  canDecide() { if (conn.state === 'local') return true; flash('Not connected to your desktop. Decisions are only sent while connected; they are never queued for later.'); return false; },
  decide(hookId, decision, reason) { queue('decide', { hookId, decision, reason: reason || (decision === 'allow' ? 'Approved on iPhone' : 'Declined on iPhone') }, decision === 'allow' ? 'Allow a held step' : 'Decline a held step', { noResend: true }); },
};
function dispatch(msg) {
  if (!listeners.length) { early.push(msg); if (early.length > 300) early.shift(); }
  listeners.forEach(fn => { try { fn(msg); } catch (e) { console.error(e); } });
  if (msg.type === 'hello') { S.nexus = msg.nexus || null; render(); }
  if (msg.type === 'nexus' && msg.msg && msg.msg.type === 'say') addTalk({ role: 'assistant', src: 'nexus', text: msg.msg.text });
  if (msg.type === 'gateway' && msg.msg && msg.msg.type === 'note') addTalk({ role: 'note', text: msg.msg.text });
  if (msg.type !== 'bridge-down') { S.lastLocalAt = Date.now(); if (!S.savedAt || S.lastLocalAt - S.savedAt > 30000) { S.savedAt = S.lastLocalAt; kv.set('lastLocalAt', S.lastLocalAt); } }
}

// ---------- link, queue ----------
const conn = createConn({
  getBase: () => S.link.base, getToken: () => secrets.get('deviceToken'),
  onEvent: dispatch, onState: s => { onLinkState(s); },
  loadSeq: () => kv.get('lastSeq', 0), saveSeq: v => kv.set('lastSeq', v),
});
const outbox = createOutbox({ load: () => kv.get('outbox', []), save: v => kv.set('outbox', v) });

async function sendCmd(it) {
  const r = await conn.request('/m/command', { method: 'POST', body: Object.assign({ id: it.id, type: it.type }, it.payload) });
  if (r.status === 200) return r.json;
  if (r.status === 409 && r.json && r.json.inProgress) return { inProgress: true };
  if (r.status === 401 || r.status >= 500) throw new Error('not now');
  return { ok: false, error: (r.json && r.json.error) || 'status ' + r.status };
}
async function flush() { if (conn.state !== 'local') return; await outbox.flush(sendCmd); render(); }
async function queue(type, payload, label, opts) { await outbox.add(type, payload, label, opts); render(); flush(); }

let prevState = null;
async function onLinkState(s) {
  if (s === 'local' && prevState !== 'local') {
    S.lastLocalAt = Date.now(); kv.set('lastLocalAt', S.lastLocalAt);
    if (S.connMsg === 'Paired. Connecting…') S.connMsg = 'Paired and connected.';
    await outbox.resolveUnknown(async it => { const r = await conn.request('/m/command/' + encodeURIComponent(it.id)); if (r.status !== 200) throw new Error('not now'); return r.json; });
    await reconcile(); await flush();
    if (S.pushToken) conn.request('/m/push-token', { method: 'POST', body: { token: S.pushToken } }).catch(() => {});
  }
  prevState = s; render();
}
// When the desktop comes back, the conversation it missed goes to it as one item for you to review. Nothing is replayed.
async function reconcile() {
  const missed = S.talk.filter(m => m.at > S.reconciledAt && (m.src === 'cloud' || (m.role === 'user' && m.mode !== 'local')));
  if (missed.length) await outbox.add('reconcile', { messages: missed.map(m => ({ role: m.role, text: m.text, at: m.at, src: m.src || 'you' })) }, `Cloud conversation for your review on the desktop (${missed.length} messages)`);
  S.reconciledAt = Date.now(); kv.set('reconciledAt', S.reconciledAt);
}

function cloudReady() { return S.fb.enabled; }
function mode() {
  const s = conn.state;
  if (s === 'local') return { k: 'local', label: 'LOCAL · DESKTOP' };
  if (s === 'offline') return { k: 'offline', label: 'OFFLINE' };
  if (s === 'connecting') return { k: 'away', label: 'CONNECTING' };
  if (cloudReady()) return { k: 'cloud', label: 'CLOUD · ' + (S.lastProvider ? H.PROVIDERS[S.lastProvider].label.split(' ')[0].toUpperCase() : 'FALLBACK') };
  if (s === 'unpaired') return { k: 'pair', label: 'PAIR PHONE' };
  return { k: 'away', label: 'DESKTOP AWAY' };
}

// ---------- talk ----------
async function addTalk(m) { m.at = m.at || Date.now(); S.talk.push(m); if (S.talk.length > 200) S.talk.splice(0, S.talk.length - 200); kv.set('talk', S.talk); render(); }
function extras() {
  const hq = window.__hq; if (!hq || !hq.R) return {};
  return { waiting: hq.R.decisions.filter(d => d.state === 'pending').map(d => d.title), tasks: hq.R.tasks.filter(t => !['completed', 'cancelled'].includes(t.status)).map(t => t.title) };
}
async function http(url, { method, headers, body }) {
  if (native) { const r = await CapacitorHttp.request({ url, method, headers, data: JSON.parse(body) }); let j = r.data; if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) {} } return { status: r.status, json: j }; }
  const r = await fetch(url, { method, headers, body }); let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, json: j };
}
async function say(text) {
  text = String(text || '').trim(); if (!text) return;
  const m = mode().k, local = conn.state === 'local';
  await addTalk({ role: 'user', text, mode: local ? 'local' : m });
  if (S.desktopTask) {
    await queue('task', { text }, 'Desktop task: ' + clip(text, 40));
    await addTalk({ role: 'note', text: local ? 'Sent to your desktop. It waits there for your review; nothing runs by itself.' : 'Saved. It goes to your desktop for your review when it is back.' });
    return;
  }
  if (local) { await queue('chat', { text }, 'Typed message (kept for review)'); return; }
  if (cloudReady()) {
    S.thinking = true; render();
    const secretsNow = { openai: await secrets.get('openaiKey'), anthropic: await secrets.get('anthropicKey') }; // API keys only; never a ChatGPT sign-in
    const r = await H.ask({ cfg: S.fb, secrets: secretsNow, usage: S.usage, history: S.talk, extras: extras(), http });
    S.thinking = false; S.usage = r.usage; kv.set('usage', S.usage);
    if (r.ok) { S.lastProvider = r.provider; await addTalk({ role: 'assistant', src: 'cloud', provider: r.provider, model: r.model, text: r.text }); }
    else await addTalk({ role: 'note', text: r.reason + ' Your message is saved and goes to your desktop for review when it is back.' });
    if (!r.ok) await queue('chat', { text }, 'Typed message (kept for review)');
    return;
  }
  await queue('chat', { text }, 'Typed message (kept for review)');
  await addTalk({ role: 'note', text: 'Saved. It goes to your desktop for review when it is back.' });
}

// ---------- voice ----------
const voice = createVoice({
  request: (p, o) => conn.request(p, o),
  fetchAudio: async p => { try { const r = await fetch(S.link.base.replace(/\/+$/, '') + p, { headers: { Authorization: 'Bearer ' + await secrets.get('deviceToken') } }); return r.ok ? await r.blob() : null; } catch (e) { return null; } },
  onState: s => { S.voice = s; render(); },
  onReply: r => {
    if (r.error) return addTalk({ role: 'note', text: r.error });
    if (r.transcript) addTalk({ role: 'user', text: r.transcript, mode: 'local', voice: true });
    if (r.reply) addTalk({ role: 'assistant', src: 'nexus', text: r.reply });
    if (r.note) addTalk({ role: 'note', text: r.note });
    if (r.reply && r.desktopPlayback && !S.toldPlayback) { S.toldPlayback = true; addTalk({ role: 'note', text: "Atarah spoke this through your desktop's speakers. Nexus can't send her voice to the phone yet, so her words show here." }); }
  },
});

// ---------- pairing, alerts ----------
async function pair(base, code, name) {
  base = String(base || '').trim().replace(/\/+$/, ''); if (!/^https?:\/\//.test(base)) base = 'https://' + base;
  let r; try { r = await fetch(base + '/m/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) }); } catch (e) { return 'Could not reach ' + base + '. Is Tailscale on, on both devices, and is the bridge running?'; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return j.error || 'Pairing failed (' + r.status + ').';
  await secrets.set('deviceToken', j.token); S.link = { base, name: j.name, deviceId: j.deviceId }; await kv.set('link', S.link);
  conn.reset(); return null;
}
async function unpair() { try { await conn.request('/m/device', { method: 'DELETE' }); } catch (e) {} await secrets.set('deviceToken', null); S.link.deviceId = null; await kv.set('link', S.link); conn.reset(); render(); }
async function enableAlerts() {
  if (!native) return 'Alerts work in the iPhone app, not in a browser.';
  const p = await PushNotifications.requestPermissions(); if (p.receive !== 'granted') return 'Alerts are off in Settings for Agent HQ.';
  await PushNotifications.register(); return null;
}
if (native) {
  PushNotifications.addListener('registration', t => { S.pushToken = t.value; kv.set('pushToken', t.value); if (conn.state === 'local') conn.request('/m/push-token', { method: 'POST', body: { token: t.value } }).catch(() => {}); render(); });
  PushNotifications.addListener('registrationError', e => { S.alertError = e.error || 'registration failed'; render(); });
  PushNotifications.addListener('pushNotificationActionPerformed', a => { const id = a.notification && a.notification.data && a.notification.data.hookId; if (!id) return; setTimeout(() => { const hq = window.__hq; const d = hq && hq.R.decisions.find(x => x.hookId === id); if (d) hq.openCard('decision', { id: d.id }); }, 1500); });
  App.addListener('appStateChange', ({ isActive }) => { if (isActive) conn.resume(); else { conn.pause(); voice.cancel(); } });
  Network.addListener('networkStatusChange', s => { S.online = s.connected; conn.setOnline(s.connected); });
  StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
}

// ---------- UI ----------
let root, sheet, chip;
function mount() {
  root = document.createElement('div'); root.id = 'mq';
  root.innerHTML = `<button id="mqChip" class="mq-chip" aria-label="Connection status"></button><button id="mqTalk" class="mq-talk" aria-label="Talk to Atarah"><span class="mq-crown" aria-hidden="true"></span></button>`;
  sheet = document.createElement('div'); sheet.id = 'mqSheet'; sheet.className = 'mq-sheet'; sheet.hidden = true; sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Atarah');
  document.body.append(root, sheet);
  chip = root.querySelector('#mqChip');
  chip.onclick = () => open(conn.state === 'unpaired' && !cloudReady() ? 'connect' : 'talk');
  root.querySelector('#mqTalk').onclick = () => open('talk');
  sheet.addEventListener('click', onClick); sheet.addEventListener('change', onChange);
  sheet.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'mqInput' && !e.shiftKey) { e.preventDefault(); sendInput(); } if (e.key === 'Escape') close(); });
}
let flashT = null;
function flash(text) { let el = document.getElementById('mqFlash'); if (!el) { el = document.createElement('div'); el.id = 'mqFlash'; el.className = 'mq-flash'; el.setAttribute('role', 'status'); document.body.append(el); } el.textContent = text; el.hidden = false; clearTimeout(flashT); flashT = setTimeout(() => { el.hidden = true; }, 5000); }
const hhmm = t => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'never';
function nexusLine() { const n = S.nexus; if (!n) return 'Nexus: not known yet.'; if (!n.configured) return "Nexus isn't connected to the bridge yet."; return `Nexus ${n.reachable ? 'is reachable' : 'is not answering'}; phone voice is ${n.voice ? 'on' : 'off'} on your desktop.`; }
function missingHTML() { const m = S.nexus && S.nexus.missing; return m && m.length ? `<h4>NOT AVAILABLE FROM NEXUS YET</h4><ul class="mq-missing">${m.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''; }
function open(tab) { S.tab = tab || S.tab; sheet.hidden = false; render(); const f = sheet.querySelector('#mqInput'); if (f && !native) f.focus(); }
function close() { sheet.hidden = true; }
function sendInput() { const f = sheet.querySelector('#mqInput'); if (!f) return; const v = f.value; f.value = ''; kv.set('draft', ''); say(v); }

function render() {
  if (!chip) return;
  const m = mode(); chip.className = 'mq-chip ' + m.k; chip.textContent = '● ' + m.label;
  const waiting = outbox.queued().length; root.querySelector('#mqTalk').dataset.n = waiting ? String(waiting) : '';
  if (sheet.hidden) return;
  // keep whatever is typed (and the focus) across a refresh, e.g. when the connection changes mid-typing
  const typed = {}; sheet.querySelectorAll('input[id],textarea[id]').forEach(el => { if (el.type !== 'checkbox') typed[el.id] = el.value; });
  const focused = document.activeElement && sheet.contains(document.activeElement) ? document.activeElement.id : null;
  const draft = typed.mqInput != null ? typed.mqInput : S.draft || '';
  const tabs = [['talk', 'TALK'], ['queue', 'QUEUE' + (waiting ? ' ' + waiting : '')], ['connect', 'CONNECT'], ['fallback', 'FALLBACK']];
  sheet.innerHTML = `<header class="mq-head"><span class="mq-title">ATARAH</span><span class="mq-mode ${m.k}">● ${esc(m.label)}</span><button class="mq-x" data-mq="close" aria-label="Close">✕</button></header>
   <nav class="mq-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${S.tab === k}" data-mq="tab" data-k="${k}">${l}</button>`).join('')}</nav>
   <section class="mq-body">${({ talk: talkHTML, queue: queueHTML, connect: connectHTML, fallback: fallbackHTML })[S.tab]()}</section>`;
  if (S.renderedTab === S.tab) for (const [id, v] of Object.entries(typed)) { const el = sheet.querySelector('#' + id); if (el) el.value = v; }
  S.renderedTab = S.tab;
  const f = sheet.querySelector('#mqInput'); if (f) { f.value = draft; f.oninput = () => { S.draft = f.value; kv.set('draft', f.value); }; }
  if (focused) { const el = sheet.querySelector('#' + focused); if (el) el.focus({ preventScroll: true }); }
  const list = sheet.querySelector('.mq-talklist'); if (list) list.scrollTop = list.scrollHeight;
}

function talkHTML() {
  const m = mode().k, local = m === 'local';
  const voiceOn = local && S.nexus && S.nexus.voice;
  const note = local ? `<p class="mq-note">${voiceOn ? "Tap MIC to talk to Atarah. She answers on your desktop's speakers and her words appear here." : esc(nexusLine())} Typed messages are kept on your desktop for your review; Atarah only takes voice for now.</p>`
    : m === 'cloud' ? `<p class="mq-note">Cloud assistant, not Atarah: it can talk and plan, but can't see your desktop, run anything or approve anything. Desktop tasks wait for your review when it's back. Last in touch with your desktop: ${hhmm(S.lastLocalAt)}.</p>`
    : `<p class="mq-note">${m === 'offline' ? 'No connection.' : 'Your desktop is not reachable.'} Last in touch: ${hhmm(S.lastLocalAt)}. Messages are saved and go to your desktop for review when it is back${S.fb.enabled ? '' : '. Turn on the cloud fallback to keep talking in the meantime'}.</p>`;
  const rows = S.talk.slice(-60).map(x => {
    if (x.role === 'note') return `<div class="mq-msg note">${esc(x.text)}</div>`;
    const who = x.role === 'user' ? 'YOU' : x.src === 'cloud' ? `CLOUD ASSISTANT · ${esc(H.PROVIDERS[x.provider] ? H.PROVIDERS[x.provider].label : x.provider)}` : 'ATARAH · NEXUS';
    return `<div class="mq-msg ${x.role === 'user' ? 'me' : x.src === 'cloud' ? 'cloud' : 'nexus'}"><b>${who}${x.voice ? ' · VOICE' : ''}</b>${esc(x.text)}</div>`;
  }).join('') || '<p class="mq-note">Talk to Atarah with MIC while your desktop is connected. When it is away, the cloud assistant can help you plan if you have turned it on.</p>';
  const mic = S.voice === 'recording' ? 'STOP' : S.voice === 'thinking' ? '…' : S.voice === 'speaking' ? 'HUSH' : 'MIC';
  return `${note}<div class="mq-talklist">${rows}${S.thinking ? '<div class="mq-msg note">Atarah is thinking…</div>' : ''}</div>
   <label class="mq-check"><input type="checkbox" data-mq="desktopTask" ${S.desktopTask ? 'checked' : ''}> Send as a desktop task (it waits there for your review)</label>
   <div class="mq-compose"><textarea id="mqInput" rows="2" placeholder="Message Atarah" aria-label="Message Atarah"></textarea>
   <button class="mq-btn" data-mq="mic" ${voiceOn ? '' : 'disabled title="Voice needs your desktop connected with phone voice on"'} aria-label="Voice">${mic}</button><button class="mq-btn gold" data-mq="send">SEND</button></div>`;
}
const STATE = { queued: 'WAITING', sending: 'SENDING', unknown: 'CHECKING', uncertain: 'CHECK DESKTOP', failed: 'NOT SENT' };
function queueHTML() {
  const items = outbox.items.slice().reverse();
  if (!items.length) return '<p class="mq-note">Nothing waiting. What you send while your desktop is away waits here and goes when it is back, for your review there. If an answer is lost, the app asks the desktop what happened instead of sending it again. Decisions are never queued.</p>';
  return `<div class="mq-list">${items.map(i => `<div class="mq-row"><span class="mq-state ${i.state}">${i.state === 'done' ? (i.result && i.result.held ? 'ON DESKTOP' : 'DONE') : STATE[i.state] || 'NOT SENT'}</span><span class="grow">${esc(i.label)}${i.result && i.result.error ? ` <span class="muted">· ${esc(i.result.error)}</span>` : ''}${i.result && i.result.held ? ' <span class="muted">· waiting for your review</span>' : ''}</span>${(i.state === 'failed' || i.state === 'uncertain') && !i.noResend && i.type !== 'decide' ? `<button class="mq-btn" data-mq="resend" data-id="${esc(i.id)}" data-u="${i.state === 'uncertain' ? 1 : ''}">SEND AGAIN</button>` : ''}${i.state === 'queued' ? `<button class="mq-btn" data-mq="drop" data-id="${esc(i.id)}">REMOVE</button>` : ''}</div>`).join('')}</div>
   <button class="mq-btn" data-mq="flush" ${conn.state === 'local' ? '' : 'disabled'}>SEND NOW</button>`;
}
function connectHTML() {
  const paired = !!S.link.deviceId, st = conn.state;
  return `<p class="mq-note">Your phone reaches the bridge on your desktop through Tailscale, then proves who it is with its own pairing. Run the bridge, open Atarah's card on the desktop and choose PAIR A PHONE to get a code.</p>
   <label class="mq-field">Desktop address<input id="mqBase" value="${esc(S.link.base)}" placeholder="https://your-pc.your-tailnet.ts.net" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url"></label>
   ${paired ? `<dl class="mq-kv"><dt>Paired as</dt><dd>${esc(S.link.name)}</dd><dt>Link</dt><dd>${st === 'local' ? 'Connected' : st === 'offline' ? 'No network' : st === 'unpaired' ? 'This phone was removed on the desktop. Pair again.' : 'Desktop not reachable'}</dd><dt>Nexus</dt><dd>${esc(nexusLine())}</dd><dt>Last in touch</dt><dd>${hhmm(S.lastLocalAt)}</dd></dl>
     <div class="mq-rowb"><button class="mq-btn" data-mq="saveBase">SAVE ADDRESS</button><button class="mq-btn" data-mq="test">TEST LINK</button><button class="mq-btn" data-mq="unpair">UNPAIR</button></div>`
     : `<label class="mq-field">Pairing code<input id="mqCode" placeholder="ABCD-EFGH" autocapitalize="characters" autocorrect="off" spellcheck="false"></label>
     <label class="mq-field">Name this phone<input id="mqName" value="${esc(S.link.name || 'iPhone')}"></label>
     <button class="mq-btn gold" data-mq="pair">PAIR</button>`}
   ${missingHTML()}
   <h4>ALERTS</h4><p class="mq-note">${S.pushToken ? 'Alerts are on. Your desktop tells this phone when something needs your decision.' : 'Get an alert when Claude Code or Nexus needs your decision while the app is closed.'}${S.alertError ? ' (' + esc(S.alertError) + ')' : ''}</p>
   ${S.pushToken ? '' : '<button class="mq-btn" data-mq="alerts">TURN ON ALERTS</button>'}
   <p class="mq-msg note" id="mqConnMsg" ${S.connMsg ? '' : 'hidden'}>${esc(S.connMsg || '')}</p>`;
}
function fallbackHTML() {
  const f = S.fb, u = H.checkLimits(f, S.usage).usage;
  const prov = p => {
    const P = H.PROVIDERS[p];
    if (p === 'chatgpt') return `<div class="mq-prov"><b>${P.label}</b><span class="mq-state queued">NOT AVAILABLE YET</span><p class="mq-note">${P.note} Nothing is sent to OpenAI from here until then.</p></div>`;
    return `<div class="mq-prov"><b>${P.label}</b><span class="mq-state ${S['has_' + p] ? 'done' : 'queued'}">${S['has_' + p] ? 'KEY SAVED' : 'NO KEY'}</span><p class="mq-note">${P.note}</p>
     <label class="mq-field">API key<input type="password" id="mqKey_${p}" placeholder="${S['has_' + p] ? 'saved in the Keychain' : 'paste key'}" autocomplete="off"></label>
     <label class="mq-field">Model<input id="mqModel_${p}" value="${esc(f.models[p])}" placeholder="model name" autocapitalize="off" autocorrect="off"></label>
     <div class="mq-rowb"><button class="mq-btn" data-mq="saveProv" data-p="${p}">SAVE</button>${S['has_' + p] ? `<button class="mq-btn" data-mq="forget" data-p="${p}">FORGET KEY</button>` : ''}</div></div>`;
  };
  return `<label class="mq-check big"><input type="checkbox" data-mq="fbEnabled" ${f.enabled ? 'checked' : ''}> Use the cloud when my desktop is unreachable</label>
   <p class="mq-note">The fallback runs on this phone, so it works with your desktop off. It can talk and plan; it can't run tools, open files, approve steps or use Atarah's voice. Desktop work is queued for Nexus.</p>
   <label class="mq-check"><input type="checkbox" data-mq="paid" ${f.paidApproved ? 'checked' : ''}> Allow paid API fallback (billed by the provider)</label>
   ${f.order.map(prov).join('')}
   <h4>WHAT THE CLOUD MAY SEE</h4>
   <label class="mq-check"><input type="checkbox" data-mq="ctx" data-k="conversation" ${f.context.conversation ? 'checked' : ''}> The recent conversation (otherwise only your latest message)</label>
   <label class="mq-check"><input type="checkbox" data-mq="ctx" data-k="waiting" ${f.context.waiting ? 'checked' : ''}> Titles of steps waiting for your decision</label>
   <label class="mq-check"><input type="checkbox" data-mq="ctx" data-k="tasks" ${f.context.tasks ? 'checked' : ''}> Titles of open tasks</label>
   <h4>DAILY LIMITS</h4><div class="mq-rowb"><label class="mq-field small">Requests<input type="number" min="1" max="1000" id="mqLimR" value="${f.limits.requests}"></label><label class="mq-field small">Tokens<input type="number" min="1000" step="1000" id="mqLimT" value="${f.limits.tokens}"></label><button class="mq-btn" data-mq="limits">SAVE</button></div>
   <p class="mq-note">Used today: ${u.requests} requests, ${u.tokens} tokens.</p>`;
}

async function saveFb() { await kv.set('fallback', S.fb); render(); }
async function onClick(e) {
  const b = e.target.closest('[data-mq]'); if (!b || b.disabled) return; const a = b.dataset.mq;
  if (a === 'close') return close();
  if (a === 'tab') { S.tab = b.dataset.k; return render(); }
  if (a === 'send') return sendInput();
  if (a === 'mic') { try { if (S.voice === 'recording') await voice.finish(); else if (S.voice === 'speaking') { voice.stopPlayback(); S.voice = 'idle'; render(); } else if (S.voice === 'idle') await voice.start(); } catch (err) { addTalk({ role: 'note', text: err.message }); } return; }
  if (a === 'resend') { if (b.dataset.u && !confirm('This may already have reached your desktop. Check there first. Send it again anyway?')) return; await outbox.resend(b.dataset.id); return flush(); }
  if (a === 'drop') { await outbox.remove(b.dataset.id); return render(); }
  if (a === 'flush') return flush();
  if (a === 'pair') { const base = sheet.querySelector('#mqBase').value, code = sheet.querySelector('#mqCode').value, name = sheet.querySelector('#mqName').value; S.connMsg = 'Pairing…'; render(); const err = await pair(base, code, name); if (err) S.link.base = base.trim(); S.connMsg = err || 'Paired. Connecting…'; return render(); }
  if (a === 'saveBase') { S.link.base = sheet.querySelector('#mqBase').value.trim().replace(/\/+$/, ''); await kv.set('link', S.link); conn.reset(); S.connMsg = 'Address saved.'; return render(); }
  if (a === 'test') { S.connMsg = 'Testing…'; render(); try { const r = await conn.request('/m/ping', { timeout: 6000 }); S.connMsg = r.status === 200 ? `Reached your desktop. ${r.json.waiting} step(s) waiting.` : (r.json && r.json.error) || 'The desktop answered ' + r.status + '.'; } catch (err) { S.connMsg = 'Could not reach your desktop. Check Tailscale is on, on both devices.'; } return render(); }
  if (a === 'unpair') { if (confirm('Unpair this phone? You will need a new code from your desktop to connect again.')) await unpair(); return; }
  if (a === 'alerts') { S.alertError = await enableAlerts(); return render(); }
  if (a === 'saveProv') { const p = b.dataset.p; const kEl = sheet.querySelector('#mqKey_' + p); const k = kEl.value.trim(); if (k) { await secrets.set(p + 'Key', k); S['has_' + p] = true; } kEl.value = ''; S.fb.models[p] = sheet.querySelector('#mqModel_' + p).value.trim(); return saveFb(); }
  if (a === 'forget') { const p = b.dataset.p; await secrets.set(p + 'Key', null); S['has_' + p] = false; return saveFb(); }
  if (a === 'limits') { S.fb.limits.requests = Math.max(1, +sheet.querySelector('#mqLimR').value || 40); S.fb.limits.tokens = Math.max(1000, +sheet.querySelector('#mqLimT').value || 60000); return saveFb(); }
}
async function onChange(e) {
  const b = e.target.closest('[data-mq]'); if (!b) return; const a = b.dataset.mq;
  if (a === 'desktopTask') { S.desktopTask = b.checked; return; }
  if (a === 'fbEnabled') { S.fb.enabled = b.checked; return saveFb(); }
  if (a === 'paid') {
    if (b.checked && !confirm('Allow the cloud fallback to use your paid API keys? Each answer is billed by the provider, up to your daily limits here.')) { b.checked = false; return; }
    S.fb.paidApproved = b.checked; return saveFb();
  }
  if (a === 'ctx') { S.fb.context[b.dataset.k] = b.checked; return saveFb(); }
}

// ---------- start ----------
async function boot() {
  S.link = Object.assign(S.link, await kv.get('link', {}));
  S.fb = Object.assign(H.defaults(), await kv.get('fallback', {})); delete S.fb.chatgpt; // older builds stored an access switch
  secrets.set('chatgptToken', null).catch(() => {});
  S.usage = await kv.get('usage', null); S.talk = await kv.get('talk', []); S.reconciledAt = await kv.get('reconciledAt', 0);
  S.draft = await kv.get('draft', ''); S.pushToken = await kv.get('pushToken', null); S.lastLocalAt = await kv.get('lastLocalAt', 0);
  for (const p of ['openai', 'anthropic']) S['has_' + p] = !!(await secrets.get(p + 'Key'));
  await outbox.load();
  document.documentElement.classList.add('hq-app'); if (native) document.documentElement.classList.add('hq-native');
  mount(); render();
  if (native) { const n = await Network.getStatus(); S.online = n.connected; conn.setOnline(n.connected); } else conn.connect();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
window.__mq = { S, conn, outbox, say, pair, open, mode };
