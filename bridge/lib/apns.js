'use strict';
// Minimal Apple Push Notification sender (token-based auth, HTTP/2). No dependencies.
// Needs an APNs key (.p8) from your Apple Developer account. TestFlight builds use the production endpoint.
const http2 = require('http2'), crypto = require('crypto'), fs = require('fs');

const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

function createApns({ keyFile, keyId, teamId, topic, production = true }) {
  if (!keyFile || !keyId || !teamId || !topic) return null;
  const key = fs.readFileSync(keyFile, 'utf8');
  let jwt = null, at = 0;
  function token() {
    const now = Math.floor(Date.now() / 1000);
    if (jwt && now - at < 3000) return jwt; // Apple accepts a token for up to an hour
    const h = b64u(JSON.stringify({ alg: 'ES256', kid: keyId }));
    const p = b64u(JSON.stringify({ iss: teamId, iat: now }));
    const sig = crypto.sign('sha256', Buffer.from(h + '.' + p), { key, dsaEncoding: 'ieee-p1363' });
    jwt = h + '.' + p + '.' + b64u(sig); at = now; return jwt;
  }
  const host = production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  function send(deviceToken, { title, body, data = {} }) {
    return new Promise(done => {
      let c;
      try { c = http2.connect(host); } catch (e) { return done({ ok: false, error: e.message }); }
      c.on('error', e => done({ ok: false, error: e.message }));
      const req = c.request({ ':method': 'POST', ':path': '/3/device/' + deviceToken, authorization: 'bearer ' + token(), 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json' });
      let status = 0, out = '';
      req.on('response', h => { status = h[':status']; });
      req.on('data', d => { out += d; });
      req.on('end', () => { c.close(); done({ ok: status === 200, status, body: out }); });
      req.on('error', e => { c.close(); done({ ok: false, error: e.message }); });
      req.end(JSON.stringify({ aps: { alert: { title, body }, sound: 'default' }, ...data }));
    });
  }
  return { send, token };
}

module.exports = { createApns, b64u };
