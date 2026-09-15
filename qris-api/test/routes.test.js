'use strict';

/**
 * routes.test.js — checkout path integration tests (no network, no Supabase).
 *
 * Strategy:
 *   • Build the REAL express app (app.buildApp) but inject a store backed by
 *     the shared in-memory PostgREST fake (test/helpers/fakeDb.js) and a
 *     scripted GoBiz factory, then drive it over node:http so middleware,
 *     HMAC, rate limiting and routes are exercised exactly as production.
 *   • Sign requests with the exported signPayload() — the same function the
 *     admin dashboard server actions will use.
 *
 * Covered: /api/health; HMAC accept + every reject branch (missing header,
 * bad timestamp, skew, tampered body, wrong secret); checkout happy path
 * (contract keys, EMV-valid dynamic QR, amount = plans.price, ledger pending
 * row); validation errors (404/403/429/503); FIFO instant-verify settle via
 * /api/qris-status (oldest order wins, journal claim lock, paid_at set);
 * instant-verify resilience (GoBiz failure → status still answers); IP rate
 * limit.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.QRIS_API_SECRET = 'test-secret-routes';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
process.env.QRIS_CHECKOUT_TTL_MINUTES = '15';

const { createStore } = require('../src/store');
const { signPayload } = require('../src/hmac');
const { buildApp } = require('../app.js');
const { makeFakeDb } = require('./helpers/fakeDb');

// ---------------------------------------------------------------------------
// GoBiz stub — journals are scripted per test via the store's factory seam.
// ---------------------------------------------------------------------------

let journalScript = [];

// Replace the GoBizClient factory INSIDE store.withAccessToken so tests never
// touch the network: getJournals() returns the scripted mutations (as the SDK
// would after its sen→IDR normalization).
require('../src/store')._setGoBizFactory(() => ({
  async getJournals(merchantId) {
    return {
      hits: [],
      mutations: journalScript.filter((m) => !m.merchantId || m.merchantId === merchantId),
      fetchedAt: new Date().toISOString(),
    };
  },
}));

// ---------------------------------------------------------------------------
// App factory for tests — the REAL app.js stack with an injected store.
// ---------------------------------------------------------------------------

function buildTestApp(db) {
  return buildApp({ store: createStore({ client: db }) });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, method, path, { body, secret = 'test-secret-routes', sign = true, ts, tamper = false } = {}) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(raw, 'utf8');
    const headers = { 'Content-Type': 'application/json' };
    if (sign) {
      const stamp = ts ?? Math.floor(Date.now() / 1000);
      const sig = signPayload(raw, secret, stamp);
      headers['X-Sensoria-Timestamp'] = String(stamp);
      headers['X-Sensoria-Sign'] = tamper ? sig.slice(0, -2) + 'zz' : sig;
    }
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      },
    );
    req.on('error', reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DEVICE_CHILD = crypto.randomUUID();
const DEVICE_PARENT = crypto.randomUUID();
const PLAN_COMBO = crypto.randomUUID();
const PLAN_SLOTS = crypto.randomUUID();
const MERCHANT_DB_ID = crypto.randomUUID();

function seedBase(db, { price = 49000 } = {}) {
  db._state.devices.push(
    { id: DEVICE_CHILD, role: 'Child', created_at: new Date().toISOString() },
    { id: DEVICE_PARENT, role: 'Parent', created_at: new Date().toISOString() },
  );
  db._state.plans.push(
    { id: PLAN_COMBO, name: 'Combo 1 Bulan', kind: 'combo', price, currency: 'IDR', is_active: true },
    { id: PLAN_SLOTS, name: 'Slot Parent +1', kind: 'slots', price: 25000, currency: 'IDR', is_active: true },
  );
  db._state.qris_merchants.push({
    id: MERCHANT_DB_ID,
    merchant_id: 'GOBIZ-1',
    merchant_name: 'Warung Sensoria',
    phone: '812345678',
    device_id: 'dev-uuid-1',
    access_token: 'at-1',
    refresh_token: 'rt-1',
    status: 'active',
    static_qris: validStaticQris(),
    created_at: new Date().toISOString(),
  });
}

/** Hand-built CRC-valid static payload (mirrors emv.test fixtures). */
function validStaticQris() {
  const entries = [
    ['00', '01'],
    ['01', '11'],
    ['26', '610014ID.CO.QRIS.WWW' + '0118A01B02C03D04E05F06'],
    ['52', '5812'],
    ['53', '360'],
    ['58', 'ID'],
    ['59', 'Warung Sensoria'],
    ['60', 'Jakarta'],
  ];
  const { crc16 } = require('../src/emv');
  const body = entries.map(([t, v]) => `${t}${String(v.length).padStart(2, '0')}${v}`).join('');
  return body + '6304' + crc16(body + '6304');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('GET /api/health answers ok without auth', async () => {
  const db = makeFakeDb();
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const res = await request(server, 'GET', '/api/health', { sign: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.service, 'qris-api');
  } finally { server.close(); }
});

test('HMAC: missing headers / bad timestamp / skew / tamper / wrong secret are rejected', async () => {
  const db = makeFakeDb();
  seedBase(db);
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const base = { device_id: DEVICE_CHILD, plan_id: PLAN_COMBO };

    let res = await request(server, 'POST', '/api/qris-checkout', { body: base, sign: false });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'MISSING_SIGNATURE');

    res = await request(server, 'POST', '/api/qris-checkout', { body: base, ts: 'abc' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'BAD_TIMESTAMP');

    res = await request(server, 'POST', '/api/qris-checkout', {
      body: base, ts: Math.floor(Date.now() / 1000) - 4000, // beyond 300 s skew
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'TIMESTAMP_SKEW');

    res = await request(server, 'POST', '/api/qris-checkout', { body: base, tamper: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'BAD_SIGNATURE');

    res = await request(server, 'POST', '/api/qris-checkout', { body: base, secret: 'wrong-secret' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'BAD_SIGNATURE');
  } finally { server.close(); }
});

test('checkout happy path: contract keys, dynamic QR, ledger pending row, amount from plans', async () => {
  const db = makeFakeDb();
  seedBase(db, { price: 49000 });
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const res = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: PLAN_COMBO },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.order_id, 'order_id present');
    assert.ok(res.body.qris_image_base64, 'qris_image_base64 present');
    assert.ok(res.body.qris_expires_at, 'qris_expires_at present');
    assert.equal(res.body.amount, 49000);

    // The QR string embedded in the order must be a VALID dynamic payload.
    const order = db._state.qris_orders[0];
    assert.equal(order.amount, 49000);
    assert.equal(order.plan_kind, 'combo');
    assert.equal(order.merchant_db_id, MERCHANT_DB_ID);
    const { verifyCRC, bodyEntries } = require('../src/emv');
    assert.equal(verifyCRC(order.qr_string), true, 'dynamic QR CRC valid');
    const tags = Object.fromEntries(bodyEntries(order.qr_string).map((e) => [e.tag, e.value]));
    assert.equal(tags['01'], '12', 'point of initiation is dynamic');
    assert.equal(tags['54'], '49000', 'amount tag 54 embedded');

    // Ledger row created as pending with the SAME transaction_ref.
    const ledger = db._state.transactions[0];
    assert.equal(ledger.status, 'pending');
    assert.equal(ledger.transaction_ref, order.transaction_ref);
    assert.equal(ledger.amount, 49000);
    assert.equal(ledger.payment_gateway, 'qris');

    // PNG sanity: base64 decodes and carries the PNG magic.
    const png = Buffer.from(res.body.qris_image_base64, 'base64');
    assert.equal(png.slice(1, 4).toString('ascii'), 'PNG');
  } finally { server.close(); }
});

test('checkout validation: unknown device / parent device / unknown plan / inactive plan', async () => {
  const db = makeFakeDb();
  seedBase(db);
  db._state.plans.push({ id: crypto.randomUUID(), name: 'Dead', kind: 'combo', price: 1000, is_active: false });
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    let res = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: crypto.randomUUID(), plan_id: PLAN_COMBO },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'DEVICE_NOT_FOUND');

    res = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_PARENT, plan_id: PLAN_COMBO },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'NOT_A_CHILD_DEVICE');

    res = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: crypto.randomUUID() },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'PLAN_NOT_FOUND');

    res = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: db._state.plans[2].id },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'PLAN_INACTIVE');
  } finally { server.close(); }
});

test('checkout without linked merchant → 503 NO_MERCHANT (no QR, no ledger row)', async () => {
  const db = makeFakeDb();
  seedBase(db);
  db._state.qris_merchants = []; // nothing linked
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const res = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: PLAN_COMBO },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'NO_MERCHANT');
    assert.equal(db._state.qris_orders.length, 0);
    assert.equal(db._state.transactions.length, 0);
  } finally { server.close(); }
});

test('checkout with corrupted stored static QR → 503 MERCHANT_QRIS_INVALID, no order', async () => {
  const db = makeFakeDb();
  seedBase(db);
  db._state.qris_merchants[0].static_qris = '0002010102116304DEAD';
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    const res = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: PLAN_COMBO },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'MERCHANT_QRIS_INVALID');
    assert.equal(db._state.qris_orders.length, 0);
  } finally { server.close(); }
});

test('per-device open-order cap → 429 after QRIS_MAX_OPEN_ORDERS checkouts', async () => {
  const db = makeFakeDb();
  seedBase(db);
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    for (let i = 0; i < 3; i++) {
      const res = await request(server, 'POST', '/api/qris-checkout', {
        body: { device_id: DEVICE_CHILD, plan_id: PLAN_SLOTS },
      });
      assert.equal(res.status, 201, `order ${i}`);
    }
    const res = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: PLAN_SLOTS },
    });
    assert.equal(res.status, 429);
    assert.equal(res.body.error, 'TOO_MANY_ORDERS');
  } finally { server.close(); }
});

test('status + instant verify: FIFO oldest wins, journal claim locks, order+ledger go paid', async () => {
  const db = makeFakeDb();
  seedBase(db);
  const app = buildTestApp(db);
  const server = await listen(app);

  journalScript = [
    { referenceId: 'JRN-2', amountIdr: 49000, paymentTime: new Date().toISOString(), merchantId: 'GOBIZ-1' },
  ];
  try {
    // Two orders, same nominal — the OLDER one must win the journal.
    const r1 = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: PLAN_COMBO },
    });
    const r2 = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: PLAN_COMBO },
    });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    // Force distinct created_at ordering (fake stamps both within the same ms).
    const [older, newer] = db._state.qris_orders;
    older.created_at = new Date(Date.now() - 60_000).toISOString();

    const st = await request(server, 'POST', '/api/qris-status', { body: { order_id: r1.body.order_id } });
    assert.equal(st.status, 200, JSON.stringify(st.body));
    assert.equal(st.body.status, 'paid');
    assert.ok(st.body.paid_at);
    assert.equal(st.body.transaction_ref, older.transaction_ref);

    // Order 1 settled; order 2 untouched pending.
    const [o1, o2] = db._state.qris_orders;
    assert.equal(o1.status, 'paid');
    assert.equal(o1.matched_journal_id, 'JRN-2');
    assert.equal(o2.status, 'pending');
    assert.equal(o2.matched_journal_id, null);

    // Ledger flipped to paid by the kind-aware RPC.
    const ledger = db._state.transactions.find((t) => t.transaction_ref === older.transaction_ref);
    assert.equal(ledger.status, 'paid');
    assert.ok(ledger.paid_at);

    // The journal is spent: re-verifying the OTHER order cannot reuse it.
    const st2 = await request(server, 'POST', '/api/qris-status', { body: { order_id: r2.body.order_id } });
    assert.equal(st2.body.status, 'pending');
  } finally { server.close(); }
});

test('status: GoBiz failure never 500s — row state is returned', async () => {
  const db = makeFakeDb();
  seedBase(db);
  const app = buildTestApp(db);
  const server = await listen(app);
  journalScript = []; // merchant reachable, but lookup explodes below
  try {
    const created = await request(server, 'POST', '/api/qris-checkout', {
      body: { device_id: DEVICE_CHILD, plan_id: PLAN_SLOTS },
    });
    assert.equal(created.status, 201);

    // Poison: make the merchant lookup explode mid-flight (GoBiz/db down).
    const store = app.get('store');
    const origGet = store.getMerchantByDbId;
    store.getMerchantByDbId = async () => {
      throw Object.assign(new Error('gobiz down'), { code: 'NETWORK_ERROR' });
    };

    const st = await request(server, 'POST', '/api/qris-status', { body: { order_id: created.body.order_id } });
    assert.equal(st.status, 200);
    assert.equal(st.body.status, 'pending');
    store.getMerchantByDbId = origGet;
  } finally {
    server.close();
  }
});

test('status 404 for unknown order; 400 for malformed id', async () => {
  const db = makeFakeDb();
  seedBase(db);
  const app = buildTestApp(db);
  const server = await listen(app);
  try {
    let res = await request(server, 'POST', '/api/qris-status', { body: { order_id: crypto.randomUUID() } });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'ORDER_NOT_FOUND');

    res = await request(server, 'POST', '/api/qris-status', { body: { order_id: 'not-a-uuid' } });
    assert.equal(res.status, 400);

    res = await request(server, 'POST', '/api/qris-status', { body: {} });
    assert.equal(res.status, 400);
  } finally { server.close(); }
});

test('rate limit: 429 when one IP bursts past QRIS_RATE_MAX', async () => {
  const db = makeFakeDb();
  seedBase(db);
  process.env.QRIS_RATE_MAX = '2'; // limiter reads env at buildApp() time
  let server;
  try {
    const app = buildTestApp(db);
    server = await listen(app);

    // Two allowed requests…
    const r1 = await request(server, 'POST', '/api/qris-status', { body: { order_id: crypto.randomUUID() } });
    const r2 = await request(server, 'POST', '/api/qris-status', { body: { order_id: crypto.randomUUID() } });
    assert.equal(r1.status, 404); // unknown order — but passed the limiter
    assert.equal(r2.status, 404);

    // …third from the same IP is throttled.
    const r3 = await request(server, 'POST', '/api/qris-status', { body: { order_id: crypto.randomUUID() } });
    assert.equal(r3.status, 429);
    assert.equal(r3.body.error, 'RATE_LIMITED');
  } finally {
    delete process.env.QRIS_RATE_MAX;
    if (server) server.close();
  }
});
