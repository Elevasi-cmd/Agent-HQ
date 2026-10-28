'use strict';
// Paired phones. Each phone gets its own random token; only a SHA-256 hash of it is stored.
// Pairing needs a short one-time code shown on your desktop, valid for 10 minutes.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_TTL = 10 * 60 * 1000;
const MAX_FAILS = 10, FAIL_WINDOW = 10 * 60 * 1000;

const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');

function createDevices(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'devices.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { list = []; }
  const save = () => fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
  let code = null;          // { value, until }
  let fails = [];           // timestamps of failed claims

  return {
    startPairing() {
      let v = ''; const b = crypto.randomBytes(8);
      for (let i = 0; i < 8; i++) v += ALPHABET[b[i] % ALPHABET.length];
      code = { value: v, until: Date.now() + CODE_TTL };
      return { code: v.slice(0, 4) + '-' + v.slice(4), expiresIn: CODE_TTL / 1000 };
    },
    // Returns { device, token } or { error, status }
    claim(raw, name) {
      const now = Date.now(); fails = fails.filter(t => now - t < FAIL_WINDOW);
      if (fails.length >= MAX_FAILS) return { error: 'Too many wrong codes. Start pairing again on your desktop in a few minutes.', status: 429 };
      const given = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const ok = code && now < code.until && given.length === code.value.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(code.value));
      if (!ok) { fails.push(now); return { error: 'That code is wrong or has expired.', status: 403 }; }
      code = null; // single use
      const token = crypto.randomBytes(32).toString('hex');
      const device = { id: 'd' + crypto.randomBytes(5).toString('hex'), name: String(name || 'iPhone').slice(0, 60), tokenHash: sha(token), created: new Date().toISOString(), lastSeen: null, apns: null };
      list.push(device); save();
      return { device, token };
    },
    auth(header) {
      const m = /^Bearer\s+([a-f0-9]{64})$/i.exec(String(header || ''));
      if (!m) return null;
      const h = sha(m[1]);
      const d = list.find(x => x.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
      if (d) { d.lastSeen = new Date().toISOString(); }
      return d || null;
    },
    setApns(id, token) { const d = list.find(x => x.id === id); if (!d) return false; d.apns = token ? String(token).slice(0, 200) : null; save(); return true; },
    remove(id) { const n = list.length; list = list.filter(x => x.id !== id); if (list.length !== n) { save(); return true; } return false; },
    list() { return list.map(({ tokenHash, ...rest }) => ({ ...rest, apns: !!rest.apns })); },
    withPush() { return list.filter(d => d.apns); },
    flush: save,
  };
}

module.exports = { createDevices, sha };
