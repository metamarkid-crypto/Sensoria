'use strict';

/**
 * appUpdate.test.js — VPS-hosted Android self-update endpoints.
 *
 * Covered:
 *   • public check: update_available only for OLDER client; signed expiring
 *     download URL minted; apk_ready flag honest about disk state
 *   • download: valid signature streams bytes; tampered/expired/traversal
 *     signatures refused
 *   • internal publish (HMAC): config-only patch, .apk upload (octet-stream),
 *     bad version_code refused, empty patch → NOTHING_TO_UPDATE
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SECRET = 'test-secret-appupdate';
process.env.QRIS_API_SECRET = SECRET;
process.env.QRIS_INTERNAL_SECRET = SECRET;
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
process.env.QRIS_CHECKOUT_TTL_MINUTES = '15';

// Redirect the updates dir to a temp dir BEFORE requiring modules.
const updMod = require('../src/appUpdate');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appupd-'));
updMod.setUpdatesDir(tmpDir);

const { buildApp } = require('../app');
const { createStore } = require('../src/store');
const { makeFakeDb } = require('./helpers/fakeDb');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function signedReq(server, method, urlPath, { body = null, raw = null, contentType = 'application/json', internal = true } = {}) {
  const payload = raw !== null ? raw : Buffer.from(body != null ? JSON.stringify(body) : '{}', 'utf8');
  const ts = Math.floor(Date.now() / 1000);
  const secret = internal ? process.env.QRIS_INTERNAL_SECRET : process.env.QRIS_API_SECRET;
  const sign = crypto.createHmac('sha256', secret).update(`${ts}.${payload.toString('utf8')}`).digest('hex');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
        headers: {
          'content-type': contentType,
          // Explicit length: without it a GET body is silently dropped by
          // Node's server and the signature can never match (same trap as
          // internal.test.js).
          'Content-Length': String(payload.length),
          'x-sensoria-timestamp': String(ts),
          'x-sensoria-sign': sign,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (payload.length > 0) req.write(payload);
    req.end();
  });
}

test.after(() => {
  updMod.setUpdatesDir(path.join(__dirname, '..', 'updates'));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* windows tmp */ }
});

test('check: older client gets update + signed url; same/never-configured client gets none', async () => {
  updMod.writeConfig({
    latest_version_code: 9,
    latest_version_name: '1.0.9',
    apk_file: 'u9.apk',
    release_notes: 'Perbaikan bug',
    mandatory: false,
  });
  const app = buildApp({ store: createStore({ client: makeFakeDb() }) });
  const server = await listen(app);

  const same = await signedReq(server, 'GET', '/api/app-update/check?version_code=9');
  const sameBody = JSON.parse(same.body.toString());
  assert.equal(same.status, 200);
  assert.equal(sameBody.update_available, false);

  const older = await signedReq(server, 'GET', '/api/app-update/check?version_code=8');
  const olderBody = JSON.parse(older.body.toString());
  assert.equal(olderBody.update_available, true);
  assert.equal(olderBody.latest_version_name, '1.0.9');
  assert.equal(olderBody.release_notes, 'Perbaikan bug');
  assert.ok(olderBody.download_url && olderBody.download_url.includes('/api/app-update/download?f=u9.apk&exp='));
  assert.equal(olderBody.apk_ready, false); // file not on disk yet
  server.close();
});

test('download: valid signature streams; tampered/expired/bad-names refused', async () => {
  fs.writeFileSync(path.join(tmpDir, 'u9.apk'), Buffer.from('PK-FAKE-APK-BYTES'));
  updMod.writeConfig({ apk_file: 'u9.apk' });
  const app = buildApp({ store: createStore({ client: makeFakeDb() }) });
  const server = await listen(app);

  const exp = Math.floor(Date.now() / 1000) + 600;
  const sig = crypto.createHmac('sha256', SECRET).update(`u9.apk.${exp}`).digest('hex');
  const ok = await signedReq(server, 'GET', `/api/app-update/download?f=u9.apk&exp=${exp}&sig=${sig}`);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.toString().includes('PK-FAKE-APK-BYTES'));

  const tampered = await signedReq(server, 'GET', `/api/app-update/download?f=u9.apk&exp=${exp}&sig=${'0'.repeat(64)}`);
  assert.equal(tampered.status, 403);

  const expiredExp = Math.floor(Date.now() / 1000) - 10;
  const expiredSig = crypto.createHmac('sha256', SECRET).update(`u9.apk.${expiredExp}`).digest('hex');
  const expired = await signedReq(server, 'GET', `/api/app-update/download?f=u9.apk&exp=${expiredExp}&sig=${expiredSig}`);
  assert.equal(expired.status, 403);

  const traversal = await signedReq(server, 'GET', `/api/app-update/download?f=..%2Fconfig.json&exp=${exp}&sig=x`);
  assert.ok(traversal.status === 403 || traversal.status === 400);
  server.close();
});

test('internal publish: cfg patch, bad code refused, .apk upload stored, empty patch 400', async () => {
  const app = buildApp({ store: createStore({ client: makeFakeDb() }) });
  const server = await listen(app);

  const patch = await signedReq(server, 'POST', '/internal/app-update', {
    body: { version_code: 10, version_name: '1.0.10', notes: 'uji', mandatory: false },
  });
  assert.equal(patch.status, 200);
  assert.equal(JSON.parse(patch.body.toString()).config.latest_version_code, 10);

  const bad = await signedReq(server, 'POST', '/internal/app-update', { body: { version_code: 'abc' } });
  assert.equal(bad.status, 400);

  const empty = await signedReq(server, 'POST', '/internal/app-update', { body: {} });
  assert.equal(empty.status, 400);

  const withApk = await signedReq(server, 'POST', '/internal/app-update', {
    raw: Buffer.from('PK-apk-bytes'),
    contentType: 'application/octet-stream',
  });
  assert.equal(withApk.status, 200);
  const stored = JSON.parse(withApk.body.toString()).config.apk_file;
  assert.match(stored, /\.apk$/);
  assert.ok(fs.existsSync(path.join(tmpDir, stored)));

  const status = await signedReq(server, 'GET', '/internal/app-update/status');
  assert.equal(status.status, 200);
  assert.equal(JSON.parse(status.body.toString()).config.latest_version_code, 10);
  server.close();
});
