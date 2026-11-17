'use strict';
// Big Brain stage 1: mandates, the ledger, funds checks, and who may set goals.
// Run: node --test "bridge/test/*.test.js"   (from the repository root)
const test = require('node:test'), assert = require('node:assert'), { spawn } = require('child_process');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { createBigBrain } = require('../lib/bigbrain');

const HOUR = 3600e3;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hq-bb-'));
const T0 = Date.parse('2026-11-26T09:00:00Z');                      // a Thursday: review day
const WINDOW = { start: Date.parse('2026-12-01T08:00:00Z'), end: Date.parse('2026-12-01T12:00:00Z') }; // Tuesday slot
const GOAL = { id: 'groceries', name: 'Groceries', budget: 8000, periodDays: 14, maxTotal: 7200, merchants: ["Sainsbury's"], mandateHours: 48, substituteCeiling: 1.10 };
const ITEMS = [
  { id: 'milk', name: 'Milk 4 pints', qty: 2, price: 165, category: 'dairy' },
  { id: 'bread', name: 'Wholemeal loaf', qty: 1, price: 140, category: 'bakery' },
  { id: 'coffee', name: 'Coffee 200g', qty: 1, price: 450, category: 'hot drinks' },
];

function setup(opts = {}) {
  const dir = opts.dir || tmp(); let clock = opts.clock || T0; const events = [];
  const bb = createBigBrain({ dataDir: dir, emit: e => events.push(e), now: () => clock, balanceSource: opts.balanceSource });
  return { dir, bb, events, tick: ms => { clock += ms; }, at: () => clock };
}
async function issued(t, extra = {}) {
  t.bb.setGoal(GOAL, { by: 'desktop' });
  const r = await t.bb.request({ goal: 'groceries', merchant: "Sainsbury's", items: ITEMS, deliveryFee: 0, deliveryWindow: WINDOW, floor: 'shopping' });
  assert.equal(r.ok, true, r.error);
  const s = t.bb.submitReview(r.review.id, { decisions: [{ item: 'milk', keep: true }, { item: 'bread', keep: true }, { item: 'coffee', keep: false, reason: 'too expensive' }], substitutes: { milk: ['dairy'] }, ...extra });
  assert.equal(s.ok, true, s.error); return s.mandate;
}
const basket = (over = {}) => Object.assign({ merchant: "Sainsbury's", items: [{ id: 'milk', qty: 2, price: 165 }, { id: 'bread', qty: 1, price: 140 }], deliveryFee: 0, slot: { start: WINDOW.start, end: WINDOW.start + 2 * HOUR } }, over);

test('a mandate covers only the kept items, expires after 48 hours, and records the swipe reasons', async () => {
  const t = setup(); const m = await issued(t);
  assert.deepEqual(m.items.map(i => i.id), ['milk', 'bread']);
  assert.equal(m.max_total, 7200); assert.equal(m.expires_at - m.approved_at, 48 * HOUR); assert.equal(m.state, 'issued');
  assert.deepEqual(m.substitutes, { milk: ['dairy'], bread: 'drop' }, 'an item without a stated substitute is dropped, never swapped');
  const sw = t.bb.ledger().find(e => e.type === 'swipes');
  assert.deepEqual(sw.swipes.find(s => s.item === 'coffee'), { item: 'coffee', keep: false, reason: 'too expensive' });
});

test('a mandate is used once only', async () => {
  const t = setup({ balanceSource: { name: 'test', read: async () => ({ status: 'available', balance: 8000 }) } });
  const m = await issued(t);
  assert.equal((await t.bb.authorise(m.id, basket())).ok, true);
  const again = await t.bb.authorise(m.id, basket());
  assert.equal(again.ok, false); assert.deepEqual(again.reasons, ['already-used']);
});

test('an expired mandate cannot be used', async () => {
  const t = setup({ balanceSource: { name: 'test', read: async () => ({ status: 'available', balance: 8000 }) } });
  const m = await issued(t); t.tick(48 * HOUR + 1);
  const r = await t.bb.authorise(m.id, basket()); assert.equal(r.ok, false); assert.deepEqual(r.reasons, ['expired']);
  assert.equal(t.bb.mandate(m.id).state, 'expired');
});

test('authorise refuses unapproved items, over-limit totals, the wrong merchant and slots outside the window', async () => {
  const t = setup({ balanceSource: { name: 'test', read: async () => ({ status: 'available', balance: 8000 }) } });
  const m = await issued(t);
  const r1 = await t.bb.authorise(m.id, basket({ items: [{ id: 'milk', qty: 2, price: 165 }, { id: 'chocolate', qty: 1, price: 200 }] }));
  assert.ok(r1.reasons.includes('unapproved-item:chocolate'));
  const r2 = await t.bb.authorise(m.id, basket({ items: [{ id: 'milk', qty: 2, price: 3700 }] }));
  assert.ok(r2.reasons.includes('over-max-total'));
  const r3 = await t.bb.authorise(m.id, basket({ merchant: 'Tesco' }));
  assert.ok(r3.reasons.includes('wrong-merchant'));
  const r4 = await t.bb.authorise(m.id, basket({ slot: { start: WINDOW.end, end: WINDOW.end + HOUR } }));
  assert.ok(r4.reasons.includes('outside-delivery-window'));
  const r5 = await t.bb.authorise(m.id, basket({ items: [{ id: 'milk', qty: 3, price: 165 }] }));
  assert.ok(r5.reasons.includes('quantity-over:milk'));
  // substitutes: allowed category within 110% passes the item check; a dropped item or a dearer one does not
  const r6 = await t.bb.authorise(m.id, basket({ items: [{ id: 'bread', qty: 1, price: 140, substituteFor: 'milk', category: 'bakery' }] }));
  assert.ok(r6.reasons.includes('substitute-not-allowed:bread') || r6.reasons.some(x => x.startsWith('substitute-not-allowed')));
  const r7 = await t.bb.authorise(m.id, basket({ items: [{ id: 'oatmilk', qty: 2, price: 190, substituteFor: 'milk', category: 'dairy' }] }));
  assert.ok(r7.reasons.includes('substitute-too-expensive:oatmilk'), '190p > 110% of 165p');
  assert.equal(t.bb.mandate(m.id).state, 'issued', 'refusals leave the mandate unused');
  const ok = await t.bb.authorise(m.id, basket({ items: [{ id: 'oatmilk', qty: 2, price: 180, substituteFor: 'milk', category: 'dairy' }, { id: 'bread', qty: 1, price: 140 }] }));
  assert.equal(ok.ok, true, JSON.stringify(ok.reasons));
});

test('requests over the per-mandate limit or the remaining period budget are refused', async () => {
  const t = setup(); t.bb.setGoal(GOAL, { by: 'desktop' });
  const big = await t.bb.request({ goal: 'groceries', merchant: "Sainsbury's", items: [{ id: 'x', qty: 1, price: 7300 }], deliveryWindow: WINDOW });
  assert.equal(big.ok, false); assert.equal(big.limit, 7200);
  const m = await issued(t); t.bb.report(m.id, { amount: 5000, source: 'test' });
  const after = await t.bb.request({ goal: 'groceries', merchant: "Sainsbury's", items: [{ id: 'y', qty: 1, price: 3500 }], deliveryWindow: WINDOW });
  assert.equal(after.ok, false); assert.equal(after.limit, 3000, '£80 budget minus £50 already charged this period');
});

test('with no balance source the funds check is honest: it sends a reminder and relies on the pot limit', async () => {
  const t = setup();                                    // default source: Monzo not connected
  const m = await issued(t);
  const rem = t.events.filter(e => e.event === 'funds-reminder');
  assert.ok(rem.length >= 1 && /not connected/i.test(rem[0].text), 'a reminder that names why the balance is unknown');
  assert.ok(!t.bb.ledger().some(e => 'balance' in e && e.kind === 'unreadable'), 'no balance is invented');
  const r = await t.bb.authorise(m.id, basket()); assert.equal(r.ok, true, JSON.stringify(r.reasons));
  const a = t.bb.ledger().find(e => e.type === 'authorised');
  assert.equal(a.funds, 'unreadable'); assert.equal(a.basis, 'pot-limit', 'the ledger says checkout relied on the pot limit');
  // still bounded: a basket over the mandate limit is refused even with no balance to read
  const m2 = await issued(t);
  assert.ok((await t.bb.authorise(m2.id, basket({ items: [{ id: 'milk', qty: 2, price: 3700 }] }))).reasons.includes('over-max-total'));
});

test('an approved item more than 10% dearer is held and sent back for review, once', async () => {
  const t = setup({ balanceSource: { name: 'test', read: async () => ({ status: 'available', balance: 8000 }) } });
  const m = await issued(t);
  const ok = await t.bb.authorise(m.id, basket({ items: [{ id: 'milk', qty: 2, price: 182 }, { id: 'bread', qty: 1, price: 140 }] }));
  assert.equal(ok.ok, true, '182p is within 110% of 165p (181.5 rounded)');
  const m2 = await issued(t);
  const r = await t.bb.authorise(m2.id, basket({ items: [{ id: 'milk', qty: 2, price: 183 }, { id: 'bread', qty: 1, price: 140 }] }));
  assert.equal(r.ok, false); assert.deepEqual(r.reasons, ['price-rise-held:milk']); assert.deepEqual(r.held, ['milk']);
  const held = t.bb.reviews('awaiting-review').filter(v => v.floor === 'price-rise:' + m2.id);
  assert.equal(held.length, 1); assert.deepEqual(held[0].items.map(i => [i.id, i.price]), [['milk', 183]]);
  assert.ok(t.events.some(e => e.event === 'price-rise-held' && /Milk 4 pints is now £1.83 \(was £1.65\)/.test(e.text)));
  await t.bb.authorise(m2.id, basket({ items: [{ id: 'milk', qty: 2, price: 183 }] }));
  assert.equal(t.bb.reviews('awaiting-review').filter(v => v.floor === 'price-rise:' + m2.id).length, 1, 'a retry does not raise a second review');
  assert.equal((await t.bb.authorise(m2.id, basket({ items: [{ id: 'bread', qty: 1, price: 140 }] }))).ok, true, 'the rest can still be bought');
});

test('an over-limit basket drops optional items, dearest first, and is refused only if it still cannot fit', async () => {
  const t = setup(); t.bb.setGoal(GOAL, { by: 'desktop' });
  const items = [
    { id: 'chicken', name: 'Chicken', qty: 1, price: 5000 },
    { id: 'wine', name: 'Wine', qty: 1, price: 1500, optional: true },
    { id: 'crisps', name: 'Crisps', qty: 2, price: 200, optional: true },
    { id: 'cake', name: 'Cake', qty: 1, price: 900, optional: true },
  ];                                                     // £85 against a £72 limit
  const r = await t.bb.request({ goal: 'groceries', merchant: "Sainsbury's", items, deliveryWindow: WINDOW });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.review.dropped, ['wine'], 'dropping the £15 wine is enough');
  assert.deepEqual(r.review.items.map(i => i.id), ['chicken', 'crisps', 'cake']); assert.equal(r.review.total, 6300);
  assert.ok(t.events.some(e => e.event === 'items-dropped' && /Wine/.test(e.text)));
  const no = await t.bb.request({ goal: 'groceries', merchant: "Sainsbury's", items: [{ id: 'beef', qty: 1, price: 7000 }, { id: 'tea', qty: 1, price: 400 }], deliveryWindow: WINDOW });
  assert.equal(no.ok, false, 'nothing optional to drop'); assert.equal(no.limit, 7200);
});

test('the budget runs in fixed cycles from the top-up date', async () => {
  const topUp = Date.parse('2026-11-24T00:00:00Z');     // a Tuesday, two days before T0
  const t = setup(); t.bb.setGoal(Object.assign({}, GOAL, { cycleStart: topUp }), { by: 'desktop' });
  const g = t.bb.goals()[0];
  assert.equal(g.cycle.start, topUp); assert.equal(g.cycle.end, topUp + 14 * 24 * HOUR);
  const m = await issued(t); t.bb.report(m.id, { amount: 5000, source: 'test' });
  assert.equal(t.bb.goals()[0].spent, 5000);
  t.tick(11 * 24 * HOUR);                                // 7 Dec: still day 13 of the cycle
  const late = await t.bb.request({ goal: 'groceries', merchant: "Sainsbury's", items: [{ id: 'y', qty: 1, price: 3500 }], deliveryWindow: WINDOW });
  assert.equal(late.limit, 3000, 'same cycle: £30 left');
  t.tick(1 * 24 * HOUR);                                 // 8 Dec: the new cycle starts on the top-up date
  assert.equal(t.bb.goals()[0].spent, 0);
  assert.equal((await t.bb.request({ goal: 'groceries', merchant: "Sainsbury's", items: [{ id: 'y', qty: 1, price: 3500 }], deliveryWindow: WINDOW })).ok, true);
});

test('a short pot blocks checkout and the reminder states the shortfall', async () => {
  const t = setup({ balanceSource: { name: 'test', read: async () => ({ status: 'available', balance: 300 }) } });
  const m = await issued(t);
  const r = await t.bb.authorise(m.id, basket()); assert.deepEqual(r.reasons, ['funds-short']);
  assert.ok(t.events.some(e => e.event === 'funds-reminder' && /short/.test(e.text)));
});

test('the ledger is append-only, chained, and survives a restart', async () => {
  const t = setup(); const m = await issued(t);
  t.bb.report(m.id, { amount: 7500, source: 'test' });
  const before = t.bb.ledger(); assert.equal(t.bb.verifyLedger().ok, true);
  assert.equal(before.find(e => e.type === 'charge').overLimit, true, '£75 charged against a £72 mandate is flagged');
  const reopened = createBigBrain({ dataDir: t.dir, now: () => t.at() });
  assert.deepEqual(reopened.ledger(), before); assert.equal(reopened.mandate(m.id).state, 'issued');
  reopened.revoke(m.id, { via: 'desktop' });
  const after = reopened.ledger(); assert.deepEqual(after.slice(0, before.length), before, 'earlier entries untouched'); assert.equal(after.at(-1).type, 'mandate-revoked');
  // tampering is detected
  const file = path.join(t.dir, 'bigbrain', 'ledger.jsonl');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"amount":7500', '"amount":7000'));
  assert.equal(reopened.verifyLedger().ok, false);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('goals can only be set by the desktop', () => {
  const t = setup();
  assert.equal(t.bb.setGoal(GOAL, { by: 'phone' }).ok, false);
  assert.equal(t.bb.setGoal(GOAL, { by: 'floor' }).ok, false);
  assert.equal(t.bb.setGoal(GOAL, { by: 'desktop' }).ok, true);
});

// ---------- through a real bridge ----------
const PORT = 5200 + Math.floor(Math.random() * 300); const DATA = tmp(); let proc;
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((ok, bad) => { const data = body !== undefined ? JSON.stringify(body) : null; const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: Object.assign(data ? { 'Content-Type': 'application/json' } : {}, headers) }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} ok({ status: res.statusCode, body: j, text: b }); }); }); r.on('error', bad); if (data) r.write(data); r.end(); });
}
test('bridge: the page sets goals, phones review and decide, phones cannot set goals', async () => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'bridge.js'), '--pair'], { env: Object.assign({}, process.env, { HQ_PORT: String(PORT), HQ_DATA: DATA, HQ_NEXUS_KEY: 'nk' }) });
  const code = await new Promise((ok, bad) => { let out = ''; const t = setTimeout(() => bad(new Error('no start ' + out)), 8000); proc.stdout.on('data', d => { out += d; const m = /Pairing code: (\S+)/.exec(out); if (m) { clearTimeout(t); ok(m[1]); } }); });
  try {
    const tok = /"token":"([a-f0-9]+)"/.exec((await req('GET', '/')).text)[1]; const page = { 'X-HQ-Token': tok };
    const pr = await req('POST', '/m/pair', { body: { code, name: 'Phone' } }); const auth = { Authorization: 'Bearer ' + pr.body.token };
    assert.equal((await req('POST', '/bigbrain/goal', { body: GOAL })).status, 403, 'not without the page key');
    assert.equal((await req('POST', '/bigbrain/goal', { headers: page, body: GOAL })).status, 200);
    assert.equal((await req('POST', '/bigbrain/goal', { headers: auth, body: GOAL })).status, 403, 'a phone token is not a page key');
    assert.equal((await req('POST', '/m/bigbrain/goal', { headers: auth, body: GOAL })).status, 404);
    assert.equal((await req('POST', '/m/command', { headers: auth, body: { id: 'c-goal-attempt-1', type: 'bb-goal', goal: GOAL } })).status, 400);
    const rq = await req('POST', '/bigbrain/request', { headers: page, body: { goal: 'groceries', merchant: "Sainsbury's", items: ITEMS, deliveryWindow: WINDOW } });
    assert.equal(rq.status, 200, rq.text);
    const view = await req('GET', '/m/bigbrain', { headers: auth });
    assert.equal(view.body.reviews[0].state, 'awaiting-review'); assert.equal(view.body.balanceSource, 'none');
    const cmd = { id: 'c-bb-review-0001', type: 'bb-review', review: rq.body.review.id, decisions: ITEMS.map(i => ({ item: i.id, keep: i.id !== 'coffee', reason: i.id === 'coffee' ? 'too expensive' : undefined })) };
    const r1 = await req('POST', '/m/command', { headers: auth, body: cmd });
    assert.equal(r1.body.ok, true); assert.ok(r1.body.mandate.id.startsWith('md-'));
    const r2 = await req('POST', '/m/command', { headers: auth, body: cmd });
    assert.equal(r2.body.duplicate, true, 'a resent review is answered, not run again');
    assert.equal((await req('GET', '/bigbrain', { headers: page })).body.mandates.length, 1);
    const led = await req('GET', '/bigbrain/ledger', { headers: page });
    assert.equal(led.body.verified.ok, true); assert.ok(led.body.entries.some(e => e.type === 'mandate-issued'));
  } finally { await new Promise(ok => { proc.on('exit', ok); proc.kill(); }); fs.rmSync(DATA, { recursive: true, force: true }); }
});
