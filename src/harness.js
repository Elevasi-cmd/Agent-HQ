// Cloud fallback harness. It runs on the phone itself, so it keeps working when the desktop is unreachable.
// It covers conversation and planning only: no files, no tools, no approvals and no Atarah voice engine.
// Anything that needs the desktop is queued for Nexus by the app, not done here.

export const PROVIDERS = {
  chatgpt: { label: 'ChatGPT (your plan)', paid: false, note: 'Sign in with ChatGPT. Stays off until OpenAI confirms this app can use your plan.' },
  openai: { label: 'OpenAI API', paid: true, note: 'Your own OpenAI API key. Billed by OpenAI, separately from ChatGPT.' },
  anthropic: { label: 'Anthropic API', paid: true, note: 'Your own Anthropic API key. Billed by Anthropic.' },
};

export function defaults() {
  return {
    enabled: false,                       // use the cloud when the desktop is unreachable
    order: ['chatgpt', 'openai', 'anthropic'],
    paidApproved: false,                  // paid API providers stay off until you approve them
    models: { chatgpt: '', openai: '', anthropic: '' },
    chatgpt: { access: false, endpoint: 'https://api.openai.com/v1/responses' },
    context: { conversation: true, waiting: false, tasks: false },
    limits: { requests: 40, tokens: 60000 },  // per day
  };
}

export const today = (d = new Date()) => d.toISOString().slice(0, 10);

export function usable(cfg, secrets) {
  const list = [], why = {};
  for (const p of cfg.order) {
    if (!PROVIDERS[p]) continue;
    if (p === 'chatgpt') { if (!cfg.chatgpt.access || !secrets.chatgpt) { why[p] = 'waiting for confirmed access'; continue; } }
    else {
      if (!secrets[p]) { why[p] = 'no key saved'; continue; }
      if (!cfg.paidApproved) { why[p] = 'paid fallback not approved'; continue; }
    }
    if (!cfg.models[p]) { why[p] = 'no model chosen'; continue; }
    list.push(p);
  }
  return { list, why };
}

export function checkLimits(cfg, usage, now = new Date()) {
  const u = usage && usage.day === today(now) ? usage : { day: today(now), requests: 0, tokens: 0 };
  if (u.requests >= cfg.limits.requests) return { ok: false, reason: `Today's limit of ${cfg.limits.requests} cloud requests is used up.`, usage: u };
  if (u.tokens >= cfg.limits.tokens) return { ok: false, reason: `Today's limit of ${cfg.limits.tokens} tokens is used up.`, usage: u };
  return { ok: true, usage: u };
}

// Not labelled as Atarah: her identity and voice live on the desktop, and continuity across providers isn't agreed yet.
export const SYSTEM = "You are a cloud assistant on the user's phone, standing in while their desktop assistant, Atarah (part of their Nexus system), can't be reached. You are not Atarah and must not say you are. You can talk, plan and draft. You cannot run tools, read or change files, use the desktop, see live status or approve anything, so never present anything as current desktop state. When the user wants something done on the desktop, say so plainly and suggest sending it as a desktop task; it will wait for their review there. Keep replies short.";

export function buildContext(cfg, history, extras = {}) {
  let system = SYSTEM;
  if (cfg.context.waiting && extras.waiting && extras.waiting.length) system += `\n\nWaiting for the user's decision: ${extras.waiting.slice(0, 10).join('; ')}`;
  if (cfg.context.tasks && extras.tasks && extras.tasks.length) system += `\n\nOpen tasks: ${extras.tasks.slice(0, 15).join('; ')}`;
  const convo = history.filter(m => m.role === 'user' || m.role === 'assistant');
  const messages = (cfg.context.conversation ? convo.slice(-20) : convo.slice(-1)).map(m => ({ role: m.role, content: String(m.text).slice(0, 4000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  return { system, messages };
}

export function request(provider, cfg, secret, ctx) {
  if (provider === 'anthropic') return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: { model: cfg.models.anthropic, max_tokens: 800, system: ctx.system, messages: ctx.messages },
  };
  // OpenAI API and ChatGPT plan both use the Responses API; the plan sends the user's sign-in token instead of an API key.
  return {
    url: provider === 'chatgpt' ? cfg.chatgpt.endpoint : 'https://api.openai.com/v1/responses',
    headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
    body: { model: cfg.models[provider], instructions: ctx.system, input: ctx.messages, max_output_tokens: 800, store: false },
  };
}

export function parse(provider, j) {
  j = j || {};
  if (provider === 'anthropic') {
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const u = j.usage || {}; return { text, tokens: (u.input_tokens || 0) + (u.output_tokens || 0) };
  }
  let text = j.output_text || '';
  if (!text && Array.isArray(j.output)) text = j.output.flatMap(o => o.content || []).filter(c => c.type === 'output_text' || c.type === 'text').map(c => c.text).join('\n');
  const u = j.usage || {}; return { text, tokens: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0) };
}

// http(url, { method, headers, body }) -> Promise<{ status, json }>
export async function ask({ cfg, secrets, usage, history, extras, http, now }) {
  const lim = checkLimits(cfg, usage, now);
  if (!cfg.enabled) return { ok: false, reason: 'Cloud fallback is switched off.', usage: lim.usage };
  if (!lim.ok) return { ok: false, reason: lim.reason, usage: lim.usage };
  const { list, why } = usable(cfg, secrets);
  if (!list.length) return { ok: false, reason: 'No cloud provider is ready: ' + Object.entries(why).map(([p, w]) => `${PROVIDERS[p].label} (${w})`).join(', ') + '.', usage: lim.usage };
  const ctx = buildContext(cfg, history, extras);
  let last = '', u = lim.usage;
  for (const p of list) {
    const r = request(p, cfg, secrets[p], ctx);
    u = { ...u, requests: u.requests + 1 };
    try {
      const res = await http(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body) });
      if (res.status >= 200 && res.status < 300) {
        const o = parse(p, res.json);
        return { ok: true, provider: p, model: cfg.models[p], text: o.text || '(the reply had no text)', usage: { ...u, tokens: u.tokens + (o.tokens || 0) } };
      }
      last = `${PROVIDERS[p].label} answered ${res.status}${res.json && res.json.error ? ': ' + (res.json.error.message || res.json.error.type || '') : ''}`;
    } catch (e) { last = `${PROVIDERS[p].label}: ${e.message}`; }
    if (u.requests >= cfg.limits.requests) break;
  }
  return { ok: false, reason: 'The cloud providers did not answer. ' + last, usage: u };
}
