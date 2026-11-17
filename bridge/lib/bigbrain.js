'use strict';
// Big Brain, stage 1: the only part of Agent HQ that can authorise spending.
//
// Floors ASK (request); Aaron DECIDES (swipe review); Big Brain ISSUES a mandate, CHECKS it at checkout (authorise)
// and RECORDS everything (ledger). A mandate is used once, expires, and only covers what was approved.
//
//   goals          created or changed only through setGoal(), which the bridge exposes to the desktop page alone
//   request()      a floor proposes a basket -> a review for Aaron's swipe deck
//   submitReview() Aaron's swipes (+ optional reasons) -> a mandate (or nothing, if every item was dropped)
//   authorise()    immediately before checkout: re-checks items, total, merchant, delivery slot, expiry, funds; marks used
//   report()       the bank charge after checkout -> ledger, flagged if over the mandate's limit
//   revoke()       Aaron withdraws a mandate that has not been used
//
// Money is in pence (integers). Times are ms since epoch. Nothing here moves money or talks to a bank.
//
// Funds: read through a pluggable, read-only balance source. Monzo is not connected yet (stage 5), so the default
// source says "unavailable" — never a made-up balance — and Big Brain sends a top-up reminder instead.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { writeAtomic } = require('./events');

const HOUR = 3600e3;

// Default balance source until Monzo is wired in: honest about not knowing.
function unavailableBalanceSource(reason = 'Monzo is not connected to Big Brain yet (stage 5), so the pot balance cannot be read.') {
  return { name: 'none', async read() { return { status: 'unavailable', reason }; } };
}

const pence = v => Number.isInteger(v) && v >= 0 ? v : NaN;
const fmt = p => '£' + (p / 100).toFixed(2);

function createBigBrain({ dataDir, emit = () => {}, now = () => Date.now(), balanceSource = unavailableBalanceSource() }) {
  const dir = path.join(dataDir, 'bigbrain');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dir, 'state.json');
  const ledgerFile = path.join(dir, 'ledger.jsonl');

  let state = { goals: {}, reviews: {}, mandates: {} };
  try { const j = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (j && j.goals && j.reviews && j.mandates) state = j; } catch (e) { /* first run */ }
  const save = () => writeAtomic(stateFile, JSON.stringify(state));

  // ---------- ledger: append-only JSON lines, each entry chained to the previous one's hash ----------
  let lastSeq = 0, lastHash = 'genesis';
  try {
    for (const line of fs.readFileSync(ledgerFile, 'utf8').split('\n')) { if (!line.trim()) continue; const e = JSON.parse(line); lastSeq = e.seq; lastHash = e.hash; }
  } catch (e) { /* no ledger yet */ }
  function record(type, data) {
    const entry = { seq: lastSeq + 1, at: now(), type, ...data, prev: lastHash };
    entry.hash = crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
    fs.appendFileSync(ledgerFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    lastSeq = entry.seq; lastHash = entry.hash;
    return entry;
  }
  function readLedger() { try { return fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)); } catch (e) { return []; } }
  // true when no entry was changed, removed or reordered since it was written
  function verifyLedger() {
    let prev = 'genesis', seq = 0;
    for (const e of readLedger()) {
      const { hash, ...rest } = e;
      if (e.seq !== seq + 1 || e.prev !== prev) return { ok: false, at: e.seq };
      if (crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex') !== hash) return { ok: false, at: e.seq };
      prev = hash; seq = e.seq;
    }
    return { ok: true, entries: seq };
  }

  const tell = (event, data) => emit({ type: 'bigbrain', event, ...data });
  const id = (prefix) => prefix + '-' + crypto.randomBytes(6).toString('hex');

  // ---------- goals ----------
  // Only the desktop page reaches this (see bridge.js). Floors and phones cannot create or change a goal.
  function setGoal(g, { by }) {
    if (by !== 'desktop') return { ok: false, error: 'Goals can only be set from the desktop.' };
    const gid = String(g.id || '').trim();
    if (!/^[a-z0-9-]{2,40}$/.test(gid)) return { ok: false, error: 'Goal id: 2-40 lowercase letters, digits or dashes.' };
    const v = {
      id: gid, name: String(g.name || gid).slice(0, 80),
      budget: pence(g.budget),                       // per period, e.g. 8000 = £80
      periodDays: Number.isInteger(g.periodDays) && g.periodDays > 0 ? g.periodDays : NaN,
      maxTotal: pence(g.maxTotal),                    // per mandate, e.g. 7200 = £72 including delivery
      merchants: Array.isArray(g.merchants) ? g.merchants.map(String).filter(Boolean) : [],
      mandateHours: Number.isFinite(g.mandateHours) && g.mandateHours > 0 ? g.mandateHours : 48,
      substituteCeiling: Number.isFinite(g.substituteCeiling) && g.substituteCeiling >= 1 ? g.substituteCeiling : 1.10,
    };
    if (Number.isNaN(v.budget) || Number.isNaN(v.periodDays) || Number.isNaN(v.maxTotal)) return { ok: false, error: 'budget and maxTotal must be whole pence, periodDays a whole number of days.' };
    if (v.maxTotal > v.budget) return { ok: false, error: 'maxTotal cannot exceed the period budget.' };
    if (!v.merchants.length) return { ok: false, error: 'Name at least one merchant.' };
    const prev = state.goals[gid];
    state.goals[gid] = Object.assign({ createdAt: prev ? prev.createdAt : now() }, v, { updatedAt: now() });
    save(); record(prev ? 'goal-changed' : 'goal-created', { goal: state.goals[gid], by });
    tell('goal', { goal: gid });
    return { ok: true, goal: state.goals[gid] };
  }

  // spent in the current period = charges reported for this goal within the last periodDays
  function spentInPeriod(goal) {
    const since = now() - goal.periodDays * 24 * HOUR;
    return readLedger().filter(e => e.type === 'charge' && e.goal === goal.id && e.at >= since).reduce((s, e) => s + e.amount, 0);
  }

  async function funds(goal, need) {
    let r;
    try { r = await balanceSource.read(goal); } catch (e) { r = { status: 'unavailable', reason: 'The balance source failed: ' + e.message }; }
    if (r && r.status === 'available' && Number.isInteger(r.balance)) {
      if (r.balance >= need) return { status: 'enough', balance: r.balance, need };
      const shortfall = need - r.balance;
      record('funds-reminder', { goal: goal.id, kind: 'short', balance: r.balance, need, shortfall });
      tell('funds-reminder', { goal: goal.id, kind: 'short', text: `Top up the ${goal.name} pot: it holds ${fmt(r.balance)}, the basket needs ${fmt(need)} (${fmt(shortfall)} short).` });
      return { status: 'short', balance: r.balance, need, shortfall };
    }
    const reason = (r && r.reason) || 'Balance not available.';
    record('funds-reminder', { goal: goal.id, kind: 'unreadable', need, reason });
    tell('funds-reminder', { goal: goal.id, kind: 'unreadable', text: `Check the ${goal.name} pot holds at least ${fmt(need)}. ${reason}` });
    return { status: 'unreadable', need, reason };
  }

  const basketTotal = (items, deliveryFee) => items.reduce((s, i) => s + i.price * i.qty, 0) + (deliveryFee || 0);
  function cleanItems(items) {
    if (!Array.isArray(items) || !items.length) return null;
    const out = [];
    for (const i of items) {
      const it = { id: String(i.id || ''), name: String(i.name || i.id || '').slice(0, 120), qty: i.qty, price: i.price, category: i.category ? String(i.category).slice(0, 60) : null };
      if (!it.id || !Number.isInteger(it.qty) || it.qty < 1 || Number.isNaN(pence(it.price))) return null;
      out.push(it);
    }
    return out;
  }
  const cleanWindow = w => w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start ? { start: w.start, end: w.end } : null;

  // ---------- request: a floor proposes; Aaron reviews ----------
  async function request({ goal: gid, merchant, items, deliveryFee = 0, deliveryWindow, floor = 'unknown' }) {
    const goal = state.goals[gid];
    if (!goal) return { ok: false, error: 'No such goal. Goals are set on the desktop.' };
    if (!goal.merchants.includes(merchant)) return { ok: false, error: `${merchant} is not a merchant for ${goal.name}.` };
    const its = cleanItems(items), win = cleanWindow(deliveryWindow);
    if (!its) return { ok: false, error: 'Every item needs an id, a whole quantity and a price in pence.' };
    if (!win) return { ok: false, error: 'A delivery window (start, end) is required.' };
    if (Number.isNaN(pence(deliveryFee))) return { ok: false, error: 'deliveryFee must be whole pence.' };
    const total = basketTotal(its, deliveryFee), spent = spentInPeriod(goal), remaining = goal.budget - spent;
    const limit = Math.min(goal.maxTotal, remaining);
    if (total > limit) {
      record('request-refused', { goal: gid, floor, merchant, total, limit, reason: total > goal.maxTotal ? 'over-max-total' : 'over-remaining-budget' });
      return { ok: false, error: `Basket ${fmt(total)} is over the limit of ${fmt(limit)}${limit < goal.maxTotal ? ' left this period' : ''}. Drop items and ask again.`, total, limit };
    }
    const f = await funds(goal, total);
    const rid = id('rv');
    state.reviews[rid] = { id: rid, goal: gid, floor, merchant, items: its, deliveryFee, deliveryWindow: win, total, state: 'awaiting-review', funds: f.status, createdAt: now() };
    save(); record('review-requested', { review: rid, goal: gid, floor, merchant, total, items: its.length, funds: f.status });
    tell('review', { review: rid, goal: gid, total, items: its.length });
    return { ok: true, review: state.reviews[rid], funds: f };
  }

  // ---------- review -> mandate ----------
  // decisions: [{ item, keep: true|false, reason? }] for every item; substitutes: { itemId: ['category', …] | 'drop' }
  function submitReview(rid, { decisions, substitutes = {}, approvedBy = 'Aaron', via = 'phone' }) {
    const rv = state.reviews[rid];
    if (!rv) return { ok: false, error: 'No such review.' };
    if (rv.state !== 'awaiting-review') return { ok: false, error: 'This review was already ' + rv.state + '.' };
    if (!Array.isArray(decisions)) return { ok: false, error: 'decisions must be a list.' };
    const byItem = new Map(decisions.map(d => [String(d.item), d]));
    for (const it of rv.items) if (!byItem.has(it.id)) return { ok: false, error: `No decision for ${it.name}.` };
    const swipes = rv.items.map(it => { const d = byItem.get(it.id); return { item: it.id, keep: d.keep === true, reason: d.keep === true ? null : (d.reason ? String(d.reason).slice(0, 80) : null) }; });
    rv.swipes = swipes; rv.reviewedAt = now(); rv.reviewedVia = via;
    const kept = rv.items.filter(it => byItem.get(it.id).keep === true);
    record('swipes', { review: rid, goal: rv.goal, swipes, by: approvedBy, via });
    if (!kept.length) { rv.state = 'declined'; save(); tell('review-declined', { review: rid }); return { ok: true, mandate: null, note: 'Nothing was kept, so no mandate was issued.' }; }
    rv.state = 'approved';
    const m = issueMandate(rv, kept, substitutes, approvedBy, via);
    save();
    return { ok: true, mandate: m };
  }

  function issueMandate(rv, kept, substitutes, approvedBy, via) {
    const goal = state.goals[rv.goal];
    const subs = {};
    for (const it of kept) {
      const s = substitutes[it.id];
      subs[it.id] = Array.isArray(s) ? s.map(String).filter(Boolean) : 'drop'; // not stated at review = no substitute
    }
    const approvedAt = now();
    const mid = 'md-' + new Date(approvedAt).toISOString().slice(0, 10) + '-' + rv.goal + '-' + crypto.randomBytes(3).toString('hex');
    const m = {
      id: mid, goal: rv.goal, merchant: rv.merchant, review: rv.id,
      items: kept.map(i => ({ id: i.id, name: i.name, qty: i.qty, price: i.price, category: i.category })),
      substitutes: subs, substituteCeiling: goal.substituteCeiling,
      max_total: goal.maxTotal, delivery_window: rv.deliveryWindow,
      expires_at: approvedAt + goal.mandateHours * HOUR,
      approved_by: approvedBy, approved_via: via, approved_at: approvedAt,
      state: 'issued', fundsConfirmed: null,
    };
    state.mandates[mid] = m;
    record('mandate-issued', { mandate: mid, goal: m.goal, merchant: m.merchant, items: m.items.length, max_total: m.max_total, expires_at: m.expires_at, by: approvedBy, via });
    tell('mandate', { mandate: mid, goal: m.goal, expires_at: m.expires_at });
    return m;
  }

  function current(mid) {
    const m = state.mandates[mid];
    if (m && m.state === 'issued' && now() >= m.expires_at) {
      m.state = 'expired'; save(); record('mandate-expired', { mandate: mid }); tell('mandate-expired', { mandate: mid });
    }
    return m;
  }
  function sweep() { for (const mid of Object.keys(state.mandates)) current(mid); }

  // Aaron confirms the pot holds enough when the balance cannot be read (recorded as evidence)
  function confirmFunds(mid, { by = 'Aaron', via }) {
    const m = current(mid);
    if (!m) return { ok: false, error: 'No such mandate.' };
    if (m.state !== 'issued') return { ok: false, error: 'This mandate is ' + m.state + '.' };
    m.fundsConfirmed = { by, via, at: now() }; save();
    record('funds-confirmed', { mandate: mid, by, via });
    return { ok: true };
  }

  // ---------- authorise: the last check before the Buyer pays ----------
  // basket: { merchant, items: [{ id, qty, price, substituteFor?, category? }], deliveryFee, slot: { start, end } }
  async function authorise(mid, basket) {
    const m = current(mid);
    const refuse = (reasons) => { record('authorise-refused', { mandate: mid, reasons }); tell('authorise-refused', { mandate: mid, reasons }); return { ok: false, reasons }; };
    if (!m) return refuse(['no-such-mandate']);
    if (m.state === 'used') return refuse(['already-used']);
    if (m.state === 'expired') return refuse(['expired']);
    if (m.state === 'revoked') return refuse(['revoked']);
    const reasons = [];
    if (!basket || basket.merchant !== m.merchant) reasons.push('wrong-merchant');
    const items = (basket && cleanItems(basket.items)) || null;
    if (!items) return refuse(reasons.concat('malformed-basket'));
    const approved = new Map(m.items.map(i => [i.id, i]));
    const used = new Map();
    for (let k = 0; k < items.length; k++) {
      const it = items[k], raw = basket.items[k];
      const a = approved.get(it.id);
      if (a && !raw.substituteFor) { used.set(a.id, (used.get(a.id) || 0) + it.qty); continue; } // a price change on an approved item is caught only by the total (open question)
      const orig = raw.substituteFor ? approved.get(String(raw.substituteFor)) : null;
      if (!orig) { reasons.push('unapproved-item:' + it.id); continue; }
      const allowed = m.substitutes[orig.id];
      if (allowed === 'drop' || !Array.isArray(allowed) || !it.category || !allowed.includes(it.category)) { reasons.push('substitute-not-allowed:' + it.id); continue; }
      if (it.price > Math.round(orig.price * m.substituteCeiling)) reasons.push('substitute-too-expensive:' + it.id);
      used.set(orig.id, (used.get(orig.id) || 0) + it.qty);
    }
    for (const [aid, q] of used) if (q > approved.get(aid).qty) reasons.push('quantity-over:' + aid);
    const fee = pence(basket.deliveryFee || 0);
    if (Number.isNaN(fee)) reasons.push('malformed-basket');
    const total = basketTotal(items, fee || 0);
    if (total > m.max_total) reasons.push('over-max-total');
    const slot = cleanWindow(basket.slot);
    if (!slot || slot.start < m.delivery_window.start || slot.end > m.delivery_window.end) reasons.push('outside-delivery-window');
    if (reasons.length) return refuse(reasons);
    const goal = state.goals[m.goal];
    const f = await funds(goal, total);
    if (f.status === 'short') return refuse(['funds-short']);
    if (f.status === 'unreadable' && !m.fundsConfirmed) return refuse(['funds-unconfirmed']);
    m.state = 'used'; m.usedAt = now(); m.authorisedTotal = total; save();
    record('authorised', { mandate: mid, total, funds: f.status, fundsConfirmedBy: m.fundsConfirmed ? m.fundsConfirmed.by : null });
    tell('authorised', { mandate: mid, total });
    return { ok: true, total };
  }

  // ---------- report: what the bank actually charged ----------
  function report(mid, { amount, source = 'unknown', reference = null }) {
    const m = state.mandates[mid];
    if (!m) return { ok: false, error: 'No such mandate.' };
    if (Number.isNaN(pence(amount))) return { ok: false, error: 'amount must be whole pence.' };
    const overLimit = amount > m.max_total;
    record('charge', { mandate: mid, goal: m.goal, amount, overLimit, overBy: overLimit ? amount - m.max_total : 0, source, reference });
    tell('charge', { mandate: mid, amount, overLimit });
    return { ok: true, overLimit };
  }

  function revoke(mid, { by = 'Aaron', via }) {
    const m = current(mid);
    if (!m) return { ok: false, error: 'No such mandate.' };
    if (m.state !== 'issued') return { ok: false, error: 'This mandate is ' + m.state + '.' };
    m.state = 'revoked'; m.revokedAt = now(); save();
    record('mandate-revoked', { mandate: mid, by, via }); tell('mandate-revoked', { mandate: mid });
    return { ok: true };
  }

  return {
    setGoal, request, submitReview, confirmFunds, authorise, report, revoke, sweep, verifyLedger,
    goals: () => Object.values(state.goals),
    reviews: (filter) => Object.values(state.reviews).filter(r => !filter || r.state === filter).sort((a, b) => b.createdAt - a.createdAt),
    mandates: () => { sweep(); return Object.values(state.mandates).sort((a, b) => b.approved_at - a.approved_at); },
    mandate: (mid) => current(mid),
    ledger: (n = 100) => readLedger().slice(-n),
    balanceSource: () => balanceSource.name,
  };
}

module.exports = { createBigBrain, unavailableBalanceSource };
