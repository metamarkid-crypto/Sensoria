'use strict';

/**
 * internal.test.js — dashboard ops endpoints (node:test, no network, no Supabase).
 *
 * Drives the REAL app stack (/internal/* mounted with HMAC) over node:http:
 *   • OTP link flow: /otp mints a PERSISTENT device_id + returns otp_token;
 *     /verify with the SAME device_id upserts the merchant (insert, then
 *     session-refresh on re-link); a wrong/failed OTP leaves nothing behind
 *   • QRIS paste: CRC-valid static payload stored; dynamic payload rejected
 *     with the blueprint's Indonesian message; unknown merchant 404
 *   • QRIS image upload: multipart round-trip (QRCode → PNG → multipart →
 *     jsQR decode → EMV validate → stored with source 'image')
 *   • status: merchant views + ready/summary flags
 *   • refresh: success rotates tokens; hard failure flags token_expired
 *   • worker/run: returns sweep accounting
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const QRCode = require('qrcode');

process.env.QRIS_API_SECRET = 'test-secret-internal';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
process.env.QRIS_CHECKOUT_TTL_MINUTES = '15';

const { createStore, _setGoBizFactory } = require('../src/store');
const { signPayload } = require('../src/hmac');
const { buildApp } = require('../app.js');
const { makeFakeDb } = require('./helpers/fakeDb');
const { crc16 } = require('../src/emv');

// ---------------------------------------------------------------------------
// GoBiz scripted factory — OTP/verify/refresh/getMe flows.
// ---------------------------------------------------------------------------

let goBizScript = { otpToken: 'OTP-TOKEN-1', tokens: { accessToken: 'AT-1', refreshToken: 'RT-1' }, me: { merchantId: 'GOBIZ-77', merchantName: 'Warung Internal' } };
let goBizCalls = [];
let failOtp = false;
let failVerify = false;

_setGoBizFactory(() => ({
  // store.withAccessToken only needs getJournals; internal routes construct
  // GoBizClient directly, so OTP/verify/refresh are stubbed at HTTP level
  // via transport injection in the routes (see below).
  async getJournals(merchantId) { return { hits: [], mutations: [], fetchedAt: '', merchantId }; },
}));

// The internal routes construct GoBizClient({ deviceId }) directly — to keep
// tests network-free we stub at the axios-transport level for ALL clients.
const { GoBizClient } = require('../src/gobiz');
const origRequest = GoBizClient.prototype._request;
GoBizClient.prototype._request = async function (method, path, data) {
  goBizCalls.push({ method, path, data, deviceId: this.deviceId, auth: this.accessToken ?? null });
  if (failOtp && path === '/goid/login/request') {
    throw Object.assign(new Error('gobiz otp down'), { status: 503, code: 'HTTP_503' });
  }
  if (failVerify && path === '/goid/token' && data && data.grant_type === 'otp') {
    throw Object.assign(new Error('otp salah'), { status: 401, code: 'HTTP_401' });
  }
  if (path === '/goid/login/request') {
    return { otp_token: goBizScript.otpToken };
  }
  if (path === '/goid/token' && data && data.grant_type === 'otp') {
    return { access_token: goBizScript.tokens.accessToken, refresh_token: goBizScript.tokens.refreshToken, expires_in: 3600 };
  }
  if (path === '/goid/token' && data && data.grant_type === 'refresh_token') {
    if (goBizScript.refreshFails) {
      throw Object.assign(new Error('refresh ditolak'), { status: 401, code: 'HTTP_401' });
    }
    return { access_token: 'AT-2', refresh_token: goBizScript.rotates ? 'RT-2' : null, expires_in: 3600 };
  }
  if (path === '/v1/users/me') {
    // Auth enforcement, like the real endpoint: getMe MUST carry the access
    // token verifyOtp minted (client.setAccessToken in merchantVerify). A
    // headerless users/me is the exact prod bug this stub pins as 401.
    if (!this.accessToken) {
      throw Object.assign(new Error('GET /v1/users/me gagal: missing auth header'), { status: 401, code: 'HTTP_401' });
    }
    return { user: { merchant_id: goBizScript.me.merchantId, full_name: goBizScript.me.merchantName } };
  }
  throw new Error(`unexpected ${method} ${path}`);
};

function resetGobiz() {
  goBizCalls = [];
  failOtp = false;
  failVerify = false;
  goBizScript = { otpToken: 'OTP-TOKEN-1', tokens: { accessToken: 'AT-1', refreshToken: 'RT-1' }, me: { merchantId: 'GOBIZ-77', merchantName: 'Warung Internal' } };
}

// ---------------------------------------------------------------------------
// HTTP helpers (signed JSON + multipart)
// ---------------------------------------------------------------------------

function buildTestApp(db) {
  return buildApp({ store: createStore({ client: db }) });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function signedReq(server, method, path, { body, raw = null, contentType = 'application/json' } = {}) {
  const payload = raw !== null ? raw : Buffer.from(JSON.stringify(body ?? {}), 'utf8');
  const stamp = Math.floor(Date.now() / 1000);
  const sig = signPayload(payload.toString('utf8'), 'test-secret-internal', stamp);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method,
        path,
        headers: {
          'Content-Type': contentType,
          // Explicit length: without it a GET body is silently dropped by
          // Node's server and the signature can never match.
          'Content-Length': String(payload.length),
          'X-Sensoria-Timestamp': String(stamp),
          'X-Sensoria-Sign': sig,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(d); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: d });
        });
      },
    );
    r.on('error', reject);
    if (payload.length) r.write(payload);
    r.end();
  });
}

/** Build a minimal multipart body with one text field + one file field. */
function multipartBody(fields, fileField, fileBuf, filename = 'qr.png') {
  const boundary = '----sensoriatest' + crypto.randomUUID().replace(/-/g, '');
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
  );
  chunks.push(fileBuf);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validStaticQris() {
  const entries = [
    ['00', '01'],
    ['01', '11'],
    ['26', '610014ID.CO.QRIS.WWW' + '0118A01B02C03D04E05F06'],
    ['52', '5812'],
    ['53', '360'],
    ['58', 'ID'],
    ['59', 'Warung Internal'],
    ['60', 'Jakarta'],
  ];
  const body = entries.map(([t, v]) => `${t}${String(v.length).padStart(2, '0')}${v}`).join('');
  return body + '6304' + crc16(body + '6304');
}

/** PNG bytes of a QR encoding `text`. */
async function qrPng(text) {
  return QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
}

// ---------------------------------------------------------------------------
// OTP link flow
// ---------------------------------------------------------------------------

test('otp step: mints persistent device_id, returns otp_token, pre-warms existing rows', async () => {
  resetGobiz();
  const db = makeFakeDb();
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const res = await signedReq(server, 'POST', '/internal/merchant/otp', { body: { phone: '+62 812-3456-7890' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.otp_token, 'OTP-TOKEN-1');
    assert.equal(res.body.phone, '81234567890');
    assert.match(res.body.device_id, /^[0-9a-f-]{36}$/);

    // The SAME device id must be what the client would send at verify —
    // captured from the client the route constructed.
    assert.equal(goBizCalls[0].deviceId, res.body.device_id);

    // Never-linked phone: no row created yet (linkMerchant does the write).
    assert.equal(db._state.qris_merchants.length, 0);
  } finally { server.close(); }
});

test('otp step: invalid phone → 400; GoBiz outage → 502 via error sink', async () => {
  resetGobiz();
  const db = makeFakeDb();
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    let res = await signedReq(server, 'POST', '/internal/merchant/otp', { body: { phone: 'abc' } });
    assert.equal(res.status, 400);

    failOtp = true;
    res = await signedReq(server, 'POST', '/internal/merchant/otp', { body: { phone: '81234567890' } });
    assert.equal(res.status, 503); // GoBizError status passes through the error sink
  } finally { server.close(); }
});

test('verify: links a new merchant with tokens + persistent device; re-link refreshes session', async () => {
  resetGobiz();
  const db = makeFakeDb();
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    // Step 1: OTP.
    const otpRes = await signedReq(server, 'POST', '/internal/merchant/otp', { body: { phone: '81234567890' } });
    const { otp_token: otpToken, device_id: deviceId } = otpRes.body;

    // Step 2: verify with the SAME device_id.
    const vRes = await signedReq(server, 'POST', '/internal/merchant/verify', {
      body: { phone: '81234567890', otp: '123456', otp_token: otpToken, device_id: deviceId },
    });
    assert.equal(vRes.status, 200, JSON.stringify(vRes.body));
    assert.equal(vRes.body.linked, true);
    assert.equal(vRes.body.merchant_id, 'GOBIZ-77');
    assert.equal(vRes.body.has_static_qris, false);

    // getMe MUST have gone out WITH the fresh access token (setAccessToken
    // after verifyOtp) — a headerless users/me is what 401'd prod verify.
    const meCall = goBizCalls.find((c) => c.path === '/v1/users/me');
    assert.ok(meCall, 'getMe was called during verify');
    assert.equal(meCall.auth, 'AT-1', 'users/me carried the access token from verifyOtp');
    assert.equal(meCall.deviceId, deviceId, 'getMe used the same persistent device id');

    const row = db._state.qris_merchants[0];
    assert.equal(row.merchant_id, 'GOBIZ-77');
    assert.equal(row.device_id, deviceId, 'persistent device id stored');
    assert.equal(row.access_token, 'AT-1');
    assert.equal(row.refresh_token, 'RT-1');
    assert.equal(row.status, 'active');

    // Re-link (same GoBiz identity, NEW device id + tokens) → update, not insert.
    const otp2 = await signedReq(server, 'POST', '/internal/merchant/otp', { body: { phone: '81234567890' } });
    const v2 = await signedReq(server, 'POST', '/internal/merchant/verify', {
      body: { phone: '81234567890', otp: '654321', otp_token: otp2.body.otp_token, device_id: otp2.body.device_id },
    });
    assert.equal(v2.body.linked, false);
    assert.equal(db._state.qris_merchants.length, 1, 'no duplicate merchant row');
    assert.equal(db._state.qris_merchants[0].device_id, otp2.body.device_id, 'device_id rotated on re-link');
    assert.equal(db._state.qris_merchants[0].access_token, 'AT-1');
  } finally { server.close(); }
});

test('verify: missing fields → 400; wrong OTP → error propagates, nothing stored', async () => {
  resetGobiz();
  const db = makeFakeDb();
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    let res = await signedReq(server, 'POST', '/internal/merchant/verify', { body: { phone: '81234567890' } });
    assert.equal(res.status, 400);

    failVerify = true;
    res = await signedReq(server, 'POST', '/internal/merchant/verify', {
      body: { phone: '81234567890', otp: '000000', otp_token: 'T', device_id: crypto.randomUUID() },
    });
    assert.equal(res.status, 401);
    assert.equal(db._state.qris_merchants.length, 0, 'no merchant row on failed verify');
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// QRIS paste + image
// ---------------------------------------------------------------------------

test('qr paste: valid static payload stored; dynamic payload rejected with clear message', async () => {
  resetGobiz();
  const db = makeFakeDb();
  const MERCHANT_ID = 'GOBIZ-77';
  db._state.qris_merchants.push({
    id: crypto.randomUUID(), merchant_id: MERCHANT_ID, merchant_name: 'Warung', phone: '81234567890',
    device_id: 'd1', access_token: 'a', refresh_token: 'r', status: 'active', static_qris: null,
    created_at: new Date().toISOString(),
  });
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    // Dynamic (mode 12) payload — the exact mistake the blueprint warns about.
    const staticPayload = validStaticQris();
    const { bodyEntries, buildTLV } = require('../src/emv');
    const entries = bodyEntries(staticPayload).map((e) => (e.tag === '01' ? { tag: '01', value: '12' } : e));
    const dynBody = buildTLV(entries);
    const dynamicPayload = dynBody + '6304' + crc16(dynBody + '6304');

    let res = await signedReq(server, 'POST', '/internal/merchant/qr', {
      body: { merchant_id: MERCHANT_ID, payload: dynamicPayload },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'INVALID_QRIS');
    assert.match(res.body.message, /DINAMIS/, 'explains the static-vs-dynamic mistake');

    // Tampered CRC → rejected.
    res = await signedReq(server, 'POST', '/internal/merchant/qr', {
      body: { merchant_id: MERCHANT_ID, payload: staticPayload.slice(0, -4) + '0000' },
    });
    assert.equal(res.status, 400);

    // Happy path.
    res = await signedReq(server, 'POST', '/internal/merchant/qr', {
      body: { merchant_id: MERCHANT_ID, payload: staticPayload },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.has_static_qris, true);
    assert.equal(res.body.static_qris_source, 'paste');
    assert.equal(res.body.ready, true);
    assert.equal(db._state.qris_merchants[0].static_qris, staticPayload);
    assert.equal(db._state.qris_merchants[0].static_qris_source, 'paste');

    // Unknown merchant → 404.
    res = await signedReq(server, 'POST', '/internal/merchant/qr', {
      body: { merchant_id: 'GOBIZ-NOPE', payload: staticPayload },
    });
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('qr-image: multipart PNG round-trip decodes, validates, and stores with source image', async () => {
  resetGobiz();
  const db = makeFakeDb();
  const MERCHANT_ID = 'GOBIZ-77';
  db._state.qris_merchants.push({
    id: crypto.randomUUID(), merchant_id: MERCHANT_ID, merchant_name: 'Warung', phone: '81234567890',
    device_id: 'd1', access_token: 'a', refresh_token: 'r', status: 'active', static_qris: null,
    created_at: new Date().toISOString(),
  });
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const payload = validStaticQris();
    const png = await qrPng(payload);
    const mp = multipartBody({ merchant_id: MERCHANT_ID }, 'file', png);

    const res = await signedReq(server, 'POST', '/internal/merchant/qr-image', {
      raw: mp.body,
      contentType: mp.contentType,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.has_static_qris, true);
    assert.equal(res.body.static_qris_source, 'image');
    assert.equal(db._state.qris_merchants[0].static_qris, payload, 'exact payload recovered from image');

    // A screenshot of a DYNAMIC QR encodes fine but fails EMV validation.
    const entries = require('../src/emv').bodyEntries(payload).map((e) => (e.tag === '01' ? { tag: '01', value: '12' } : e));
    const dynBody = require('../src/emv').buildTLV(entries);
    const dynPayload = dynBody + '6304' + crc16(dynBody + '6304');
    const mpDyn = multipartBody({ merchant_id: MERCHANT_ID }, 'file', await qrPng(dynPayload));
    const resDyn = await signedReq(server, 'POST', '/internal/merchant/qr-image', {
      raw: mpDyn.body,
      contentType: mpDyn.contentType,
    });
    assert.equal(resDyn.status, 400);
    assert.equal(resDyn.body.error, 'INVALID_QRIS');
  } finally { server.close(); }
});

test('qr-image: non-QR image → 400 DECODE_FAILED; missing file → 400', async () => {
  resetGobiz();
  const db = makeFakeDb();
  db._state.qris_merchants.push({
    id: crypto.randomUUID(), merchant_id: 'GOBIZ-77', merchant_name: 'W', phone: '81234567890',
    device_id: 'd1', access_token: 'a', refresh_token: 'r', status: 'active',
    created_at: new Date().toISOString(),
  });
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    // A PNG without any QR in it (plain 40x40 white image via pngjs).
    const { PNG } = require('pngjs');
    const png = new PNG({ width: 40, height: 40 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = 255;
    const plainPng = PNG.sync.write(png);
    const mp = multipartBody({ merchant_id: 'GOBIZ-77' }, 'file', plainPng);
    let res = await signedReq(server, 'POST', '/internal/merchant/qr-image', { raw: mp.body, contentType: mp.contentType });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'DECODE_FAILED');

    // No file at all.
    res = await signedReq(server, 'POST', '/internal/merchant/qr-image', { body: { merchant_id: 'GOBIZ-77' } });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

// ---------------------------------------------------------------------------
// Status + refresh + worker trigger
// ---------------------------------------------------------------------------

test('status: views + ready/summary flags', async () => {
  resetGobiz();
  const db = makeFakeDb();
  db._state.qris_merchants.push(
    {
      id: crypto.randomUUID(), merchant_id: 'G-READY', merchant_name: 'Ready', phone: '812',
      device_id: 'd', access_token: 'a', refresh_token: 'r', status: 'active',
      static_qris: validStaticQris(), static_qris_source: 'paste',
      token_updated_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      created_at: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(), merchant_id: 'G-EXPIRED', merchant_name: 'Broken', phone: '813',
      device_id: 'd', access_token: 'a', refresh_token: null, status: 'token_expired',
      token_updated_at: new Date(Date.now() - 50 * 3_600_000).toISOString(),
      created_at: new Date().toISOString(),
    },
  );
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const res = await signedReq(server, 'GET', '/internal/merchant/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.merchants.length, 2);
    assert.equal(res.body.summary.total, 2);
    assert.equal(res.body.summary.ready, 1);
    assert.equal(res.body.summary.token_expired, 1);

    const ready = res.body.merchants.find((m) => m.merchant_id === 'G-READY');
    assert.equal(ready.ready, true);
    assert.equal(ready.token_age_hours, 2);
    const broken = res.body.merchants.find((m) => m.merchant_id === 'G-EXPIRED');
    assert.equal(broken.ready, false);
    assert.equal(broken.has_static_qris, false);
  } finally { server.close(); }
});

test('refresh: rotates tokens; non-rotating refresh keeps the old refresh_token', async () => {
  resetGobiz();
  const db = makeFakeDb();
  db._state.qris_merchants.push({
    id: crypto.randomUUID(), merchant_id: 'G-1', merchant_name: 'W', phone: '812',
    device_id: 'dev-1', access_token: 'AT-OLD', refresh_token: 'RT-OLD', status: 'active',
    created_at: new Date().toISOString(),
  });
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    goBizScript.rotates = false;
    let res = await signedReq(server, 'POST', '/internal/merchant/refresh', { body: { merchant_id: 'G-1' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.rotated, false);
    const row = db._state.qris_merchants[0];
    assert.equal(row.access_token, 'AT-2', 'access token rotated');
    assert.equal(row.refresh_token, 'RT-OLD', 'non-rotated refresh kept');
    assert.equal(row.status, 'active');

    // Rotating refresh.
    goBizScript.rotates = true;
    res = await signedReq(server, 'POST', '/internal/merchant/refresh', { body: { merchant_id: 'G-1' } });
    assert.equal(res.body.rotated, true);
    assert.equal(db._state.qris_merchants[0].refresh_token, 'RT-2');
  } finally { server.close(); }
});

test('refresh: hard GoBiz failure flags token_expired; disabled merchant refused; unknown 404', async () => {
  resetGobiz();
  const db = makeFakeDb();
  db._state.qris_merchants.push(
    {
      id: crypto.randomUUID(), merchant_id: 'G-DEAD', merchant_name: 'W', phone: '812',
      device_id: 'dev-1', access_token: 'a', refresh_token: 'RT', status: 'active',
      created_at: new Date().toISOString(),
    },
    {
      id: crypto.randomUUID(), merchant_id: 'G-OFF', merchant_name: 'W', phone: '813',
      device_id: 'dev-2', access_token: 'a', refresh_token: 'RT', status: 'disabled',
      created_at: new Date().toISOString(),
    },
  );
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    goBizScript.refreshFails = true;
    let res = await signedReq(server, 'POST', '/internal/merchant/refresh', { body: { merchant_id: 'G-DEAD' } });
    assert.equal(res.status, 502);
    assert.equal(db._state.qris_merchants.find((m) => m.merchant_id === 'G-DEAD').status, 'token_expired');

    res = await signedReq(server, 'POST', '/internal/merchant/refresh', { body: { merchant_id: 'G-OFF' } });
    assert.equal(res.status, 403);

    res = await signedReq(server, 'POST', '/internal/merchant/refresh', { body: { merchant_id: 'G-NOPE' } });
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('worker/run: returns sweep accounting without throwing on empty DB', async () => {
  resetGobiz();
  const db = makeFakeDb();
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const res = await signedReq(server, 'POST', '/internal/worker/run', { body: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, expired: 0, polled: 0, settled: 0 });
  } finally { server.close(); }
});

test('internal endpoints are HMAC-gated (unsigned request rejected)', async () => {
  resetGobiz();
  const db = makeFakeDb();
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const payload = Buffer.from(JSON.stringify({ phone: '81234567890' }), 'utf8');
    const res = await new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/internal/merchant/otp', headers: { 'Content-Type': 'application/json' } },
        (rs) => {
          let d = '';
          rs.on('data', (c) => (d += c));
          rs.on('end', () => resolve({ status: rs.statusCode, body: JSON.parse(d) }));
        },
      );
      r.on('error', reject);
      r.end(payload);
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'MISSING_SIGNATURE');
  } finally { server.close(); }
});
