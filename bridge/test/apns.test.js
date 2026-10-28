'use strict';
const test = require('node:test'), assert = require('node:assert'), crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path');
const { createApns } = require('../lib/apns');
test('APNs auth token is a valid ES256 JWT signed with the .p8 key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apns-')), 'AuthKey_TEST.p8'); fs.writeFileSync(f, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const a = createApns({ keyFile: f, keyId: 'ABC123', teamId: 'TEAM42', topic: 'com.example.app' });
  const [h, p, s] = a.token().split('.'); const dec = x => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h), { alg: 'ES256', kid: 'ABC123' }); assert.equal(dec(p).iss, 'TEAM42');
  assert.ok(crypto.verify('sha256', Buffer.from(h + '.' + p), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(createApns({}), null, 'no key configured means push is simply off');
});
