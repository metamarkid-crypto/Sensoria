'use strict';

/**
 * gobiz.test.js — unit tests for the GoBiz SDK port (node:test, zero net).
 * HTTP is stubbed with a scripted fake transport; no live GoBiz calls.
 *
 * Run: npm test  (from qris-api/)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GoBizClient,
  GoBizError,
  isAuthError,
  normalizePhone,
  newDeviceId,
  redact,
} = require('../src/gobiz');

// ---------------------------------------------------------------------------
// Fake transport — records requests, answers from a script
// ---------------------------------------------------------------------------

/** transport = { request(config) → { data } } mirroring the axios surface. */
function makeTransport(handler) {
  const calls = [];
  return {
    calls,
    async request(config) {
      calls.push(config);
      return handler(config);
    },
  };
}

const ok = (data) => ({ data });

// ---------------------------------------------------------------------------
// Helpers & headers
// ---------------------------------------------------------------------------

test('normalizePhone strips +62 / 62 / 0 prefixes and junk', () => {
  assert.equal(normalizePhone('+62 812-3456-7890'), '81234567890');
  assert.equal(normalizePhone('6281234567890'), '81234567890');
  assert.equal(normalizePhone('081234567890'), '81234567890');
  assert.equal(normalizePhone('81234567890'), '81234567890');
  assert.equal(normalizePhone('whatsapp'), '');
  assert.equal(normalizePhone(123), '');
});

test('newDeviceId returns a fresh UUID each call (persistence is the caller job)', () => {
  const a = newDeviceId();
  const b = newDeviceId();
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
});

test('deviceId is STABLE across all requests of one client instance', async () => {
  const t = makeTransport(() => ok({ otp_token: 'tok' }));
  const client = new GoBizClient({ deviceId: 'fixed-device', transport: t });
  await client.requestOtp('8123456789');
  assert.equal(client.deviceId, 'fixed-device');
  assert.equal(t.calls[0].headers['x-uniqueid'], 'fixed-device');
});

test('headers carry the go-merchant web fingerprint + bearer when set', () => {
  const client = new GoBizClient({ deviceId: 'dev1', accessToken: 'at' });
  const h = client.headers();
  assert.equal(h['x-appid'], 'go-biz-web-dashboard');
  assert.equal(h['Authentication-Type'], 'go-id');
  assert.equal(h['X-AppVersion'], 'platform-v3.101.0-8918927d');
  assert.equal(h['x-uniqueid'], 'dev1');
  assert.equal(h.Authorization, 'Bearer at');

  const anon = new GoBizClient({ deviceId: 'dev1' }).headers();
  assert.equal(anon.Authorization, undefined);
});

// ---------------------------------------------------------------------------
// requestOtp
// ---------------------------------------------------------------------------

test('requestOtp POSTs /goid/login/request and returns otpToken + deviceId', async () => {
  const t = makeTransport((cfg) => {
    assert.equal(cfg.method, 'post');
    assert.ok(cfg.url.endsWith('/goid/login/request'));
    assert.deepEqual(cfg.data, {
      client_id: 'go-biz-web-new',
      phone_number: '8123456789',
      country_code: '62',
    });
    return ok({ otp_token: 'OTP-TOKEN-1' });
  });
  const client = new GoBizClient({ deviceId: 'dev1', transport: t });
  const res = await client.requestOtp('+628123456789');
  assert.equal(res.otpToken, 'OTP-TOKEN-1');
  assert.equal(res.deviceId, 'dev1');
  assert.equal(res.phone, '8123456789');
});

test('requestOtp unwraps data.otp_token and rejects missing token', async () => {
  const nested = makeTransport(() => ok({ data: { otp_token: 'NESTED' } }));
  const res = await new GoBizClient({ deviceId: 'd', transport: nested }).requestOtp('81234');
  assert.equal(res.otpToken, 'NESTED');

  const empty = makeTransport(() => ok({}));
  await assert.rejects(
    () => new GoBizClient({ deviceId: 'd', transport: empty }).requestOtp('81234'),
    /otp_token/,
  );
  await assert.rejects(() => new GoBizClient({ deviceId: 'd', transport: empty }).requestOtp('x'), /tidak valid/);
});

// ---------------------------------------------------------------------------
// verifyOtp / refreshToken
// ---------------------------------------------------------------------------

test('verifyOtp sends grant_type=otp and extracts token pair', async () => {
  const t = makeTransport((cfg) => {
    assert.ok(cfg.url.endsWith('/goid/token'));
    assert.deepEqual(cfg.data, {
      client_id: 'go-biz-web-new',
      data: { otp: '123456', otp_token: 'OTP-TOKEN-1' },
      grant_type: 'otp',
    });
    return ok({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 });
  });
  const res = await new GoBizClient({ deviceId: 'd', transport: t }).verifyOtp('123456', 'OTP-TOKEN-1');
  assert.deepEqual({ a: res.accessToken, r: res.refreshToken, e: res.expiresIn }, { a: 'AT', r: 'RT', e: 3600 });
});

test('refreshToken sends grant_type=refresh_token and tolerates non-rotated refresh', async () => {
  const t = makeTransport((cfg) => {
    assert.deepEqual(cfg.data, {
      client_id: 'go-biz-web-new',
      grant_type: 'refresh_token',
      data: { refresh_token: 'RT-OLD' },
    });
    return ok({ access_token: 'AT2' }); // no refresh_token in the answer
  });
  const res = await new GoBizClient({ deviceId: 'd', transport: t }).refreshToken('RT-OLD');
  assert.equal(res.accessToken, 'AT2');
  assert.equal(res.refreshToken, null); // caller keeps the old one

  await assert.rejects(() => new GoBizClient({ deviceId: 'd', transport: t }).refreshToken(''), /Refresh token kosong/);
});

// ---------------------------------------------------------------------------
// getMe
// ---------------------------------------------------------------------------

test('getMe extracts merchant_id/full_name from user (and data.user fallback)', async () => {
  const t = makeTransport(() => ok({ user: { merchant_id: 99123, full_name: 'Warung Sensoria' } }));
  const me = await new GoBizClient({ deviceId: 'd', transport: t }).getMe();
  assert.equal(me.merchantId, '99123');
  assert.equal(me.merchantName, 'Warung Sensoria');

  const nested = makeTransport(() => ok({ data: { user: { merchant_id: 'M-1', name: 'Nested' } } }));
  const me2 = await new GoBizClient({ deviceId: 'd', transport: nested }).getMe();
  assert.equal(me2.merchantId, 'M-1');
  assert.equal(me2.merchantName, 'Nested');
});

test('getMe without merchant_id is a loud failure (identity is what we store)', async () => {
  const t = makeTransport(() => ok({ user: { full_name: 'No id' } }));
  await assert.rejects(() => new GoBizClient({ deviceId: 'd', transport: t }).getMe(), /merchant_id/);
});

// ---------------------------------------------------------------------------
// getJournals
// ---------------------------------------------------------------------------

test('getJournals queries settlement/capture for the merchant and normalizes sen → rupiah', async () => {
  const t = makeTransport((cfg) => {
    assert.ok(cfg.url.endsWith('/journals/search'));
    assert.equal(cfg.headers.accept, 'application/vnd.journal.v1+json');
    const clauses = cfg.data.query[0].clauses;
    assert.deepEqual(clauses[0].value, ['settlement', 'capture']);
    assert.equal(clauses[3].value, 'M-1');
    return ok({
      hits: [
        { id: 'j1', reference_id: 'ref-1', amount: 4900000, metadata: { transaction: { status: 'settlement', transaction_time: '2026-09-14T01:00:00Z', merchant_id: 'M-1' } } },
        { id: 'j2', reference_id: 'ref-2', amount: 2500000, metadata: { transaction: { status: 'capture', transaction_time: '2026-09-14T01:05:00Z' } } },
        { id: 'j3', reference_id: 'ref-3', amount: 999, metadata: { transaction: { status: 'pending' } } }, // filtered out
      ],
    });
  });
  const res = await new GoBizClient({ deviceId: 'd', transport: t }).getJournals('M-1');
  assert.equal(res.mutations.length, 2);
  assert.deepEqual(
    res.mutations.map((m) => [m.referenceId, m.amountIdr]),
    [
      ['ref-1', 49000],
      ['ref-2', 25000],
    ],
  );
});

test('getJournals honours startTime and defaults to a 30-day look-back', async () => {
  let seenFrom;
  const t = makeTransport((cfg) => {
    seenFrom = cfg.data.query[0].clauses[1].value;
    return ok({ hits: [] });
  });
  const c = new GoBizClient({ deviceId: 'd', transport: t });
  await c.getJournals('M-1', '2026-09-01T00:00:00Z');
  assert.equal(seenFrom, '2026-09-01T00:00:00Z');
  await c.getJournals('M-1');
  assert.ok(Math.abs(Date.parse(seenFrom) - (Date.now() - 30 * 86400e3)) < 60000);
});

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

test('API errors become GoBizError with status + apiMessage; 401 is detectable', async () => {
  const failing = makeTransport(() => {
    const e = new Error('Request failed');
    e.response = { status: 401, data: { errors: [{ message: 'Unauthorized' }] } };
    throw e;
  });
  const client = new GoBizClient({ deviceId: 'd', transport: failing });
  const err = await client.getMe().catch((e) => e);
  assert.ok(err instanceof GoBizError);
  assert.equal(err.status, 401);
  assert.equal(err.apiMessage, 'Unauthorized');
  assert.match(err.message, /gagal: Unauthorized/);
  assert.equal(isAuthError(err), true);
  assert.equal(isAuthError(new Error('x')), false);
});

test('network failures surface as NETWORK_ERROR without a status', async () => {
  const dead = makeTransport(() => {
    throw new Error('ECONNREFUSED');
  });
  const err = await new GoBizClient({ deviceId: 'd', transport: dead }).getMe().catch((e) => e);
  assert.equal(err.code, 'NETWORK_ERROR');
  assert.equal(err.status, null);
  assert.equal(isAuthError(err), false);
});

// ---------------------------------------------------------------------------
// redact
// ---------------------------------------------------------------------------

test('redact hides token-like fields before any debug output', () => {
  const out = redact({ access_token: 'A', refresh_token: 'B', nested: { Authorization: 'Bearer x', amount: 5 } });
  assert.deepEqual(out, { access_token: '[REDACTED]', refresh_token: '[REDACTED]', nested: { Authorization: '[REDACTED]', amount: 5 } });
});
