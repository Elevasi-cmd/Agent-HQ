import test from 'node:test'; import assert from 'node:assert';
import * as H from '../src/harness.js';
const cfgWith = o => Object.assign(H.defaults(), { enabled: true }, o);
const hist = [{ role: 'user', text: 'hello' }];
const okHttp = (calls, reply) => async (url, o) => { calls.push({ url, ...o, body: JSON.parse(o.body) }); return { status: 200, json: reply }; };

test('fallback is off by default and paid providers need approval', async () => {
  const d = H.defaults(); assert.equal(d.enabled, false); assert.equal(d.paidApproved, false);
  const r = await H.ask({ cfg: cfgWith({ models: { openai: 'm', anthropic: '', chatgpt: '' } }), secrets: { openai: 'sk' }, usage: null, history: hist, http: async () => { throw new Error('must not call'); } });
  assert.equal(r.ok, false); assert.match(r.reason, /paid fallback not approved/);
});
test('ChatGPT plan is never usable without a verified integration, and its token is never sent as an API key', async () => {
  const cfg = cfgWith({ paidApproved: true, models: { chatgpt: 'x', openai: '', anthropic: '' } });
  const u = H.usable(cfg, { chatgpt: 'tok' }); assert.deepEqual(u.list, []); assert.match(u.why.chatgpt, /no supported sign-in/);
  assert.deepEqual(H.usable(cfg, {}, { chatgpt: { verified: false, ask: async () => ({}) } }).list, []);
  assert.throws(() => H.request('chatgpt', cfg, 'tok', { system: '', messages: [] }), /No API-key request/);
  const r = await H.ask({ cfg, secrets: { chatgpt: 'tok' }, usage: null, history: hist, http: async () => { throw new Error('must not call'); } });
  assert.equal(r.ok, false); assert.match(r.reason, /ChatGPT \(your plan\) \(no supported sign-in/);
  assert.equal('chatgpt' in H.defaults(), false, 'no ChatGPT endpoint or access switch in settings');
  // a verified integration (none exists yet) would be called through its own interface, not the API-key path
  const ok = await H.ask({ cfg, secrets: {}, usage: null, history: hist, http: async () => { throw new Error('must not call'); }, integrations: { chatgpt: { verified: true, ask: async () => ({ text: 'plan reply', tokens: 3 }) } } });
  assert.equal(ok.ok, true); assert.equal(ok.provider, 'chatgpt'); assert.equal(ok.text, 'plan reply');
});
test('OpenAI request uses the Responses API and is parsed', async () => {
  const calls = []; const cfg = cfgWith({ paidApproved: true, models: { openai: 'my-model', anthropic: '', chatgpt: '' } });
  const r = await H.ask({ cfg, secrets: { openai: 'sk-1' }, usage: null, history: hist, http: okHttp(calls, { output: [{ content: [{ type: 'output_text', text: 'hi there' }] }], usage: { total_tokens: 42 } }) });
  assert.equal(r.ok, true); assert.equal(r.text, 'hi there'); assert.equal(r.usage.requests, 1); assert.equal(r.usage.tokens, 42);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses'); assert.equal(calls[0].headers.authorization, 'Bearer sk-1'); assert.equal(calls[0].body.model, 'my-model'); assert.equal(calls[0].body.store, false);
});
test('Anthropic request shape and fallback order: first provider fails, second answers', async () => {
  const calls = []; const cfg = cfgWith({ paidApproved: true, order: ['openai', 'anthropic'], models: { openai: 'a', anthropic: 'claude-x', chatgpt: '' } });
  const http = async (url, o) => { calls.push(url); if (url.includes('openai')) return { status: 500, json: { error: { message: 'down' } } }; return { status: 200, json: { content: [{ type: 'text', text: 'from claude' }], usage: { input_tokens: 5, output_tokens: 7 } } }; };
  const r = await H.ask({ cfg, secrets: { openai: 'k1', anthropic: 'k2' }, usage: null, history: hist, http });
  assert.equal(r.ok, true); assert.equal(r.provider, 'anthropic'); assert.equal(r.usage.tokens, 12); assert.equal(r.usage.requests, 2);
});
test('daily limits stop requests, and reset the next day', async () => {
  const cfg = cfgWith({ paidApproved: true, models: { openai: 'a', anthropic: '', chatgpt: '' }, limits: { requests: 2, tokens: 1000 } });
  const day = new Date('2026-10-28T10:00:00Z');
  const r = await H.ask({ cfg, secrets: { openai: 'k' }, usage: { day: '2026-10-28', requests: 2, tokens: 0 }, history: hist, now: day, http: async () => { throw new Error('must not call'); } });
  assert.equal(r.ok, false); assert.match(r.reason, /limit of 2/);
  const next = H.checkLimits(cfg, { day: '2026-10-28', requests: 2, tokens: 0 }, new Date('2026-10-29T08:00:00Z')); assert.equal(next.ok, true);
});
test('the cloud only sees what you allow', () => {
  const history = [{ role: 'assistant', text: 'old reply' }, { role: 'user', text: 'one' }, { role: 'note', text: 'ignored' }, { role: 'assistant', text: 'two' }, { role: 'user', text: 'three' }];
  const base = H.defaults();
  const a = H.buildContext(base, history, { waiting: ['Refund 5521'], tasks: ['Q3 report'] });
  assert.deepEqual(a.messages.map(m => m.content), ['one', 'two', 'three']); assert.ok(!a.system.includes('Refund'));
  const b = H.buildContext(Object.assign(H.defaults(), { context: { conversation: false, waiting: true, tasks: false } }), history, { waiting: ['Refund 5521'], tasks: ['Q3 report'] });
  assert.deepEqual(b.messages.map(m => m.content), ['three']); assert.ok(b.system.includes('Refund 5521')); assert.ok(!b.system.includes('Q3'));
});
