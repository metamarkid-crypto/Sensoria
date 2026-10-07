'use strict';

/**
 * web.test.js — browser checkout + webhook integration tests (no network).
 *
 * Uses the REAL express stack (buildApp) with the in-memory fakeDb store,
 * then drives HTTP over node:http:
 *   • POST /api/checkout-session (HMAC) mints a token bound to the child.
 *   • GET /pay/:token renders the plan page (region switch, MYR/IDR plans).
 *   • GET /pay/:token/plan/:planId creates the order server-side; the MY
 *     path redirects to the (stubbed) gateway URL, the ID path renders QRIS.
 *   • POST /api/webhook/toyyibpay settles on a VALID MD5 hash and rejects
 *     tampered ones; a replay is a no-op.
 *   • GET /pay/:token/status/:ref serves the poll JSON (device-scoped).
 * toyyibPay HTTP is stubbed at the module boundary (global.fetch).
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.QRIS_API_SECRET = 'test-secret-web';
process.env.PAY_CHECKOUT_TOKEN_SECRET = 'test-token-secret-web';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
process.env.QRIS_CHECKOUT_TTL_MINUTES = '15';
process.env.TOYYIBPAY_SECRET_KEY = 'toyyib-test-key';
process.env.TOYYIBPAY_CATEGORY_CODE = 'cat-test';
process.env.PAY_WEBHOOK_BASE_URL = 'https://pay.test';
process.env.PAY_PAGE_BASE_URL = 'https://pay.test';
process.env.TP_POLL_DISABLED = '1';

const { createStore } = require('../src/store');
const { signPayload } = require('../src/hmac');
const { buildApp } = require('../app.js');
const { makeFakeDb } = require('./helpers/fakeDb');

const CHILD_ID = '11111111-2222-4333-8444-555555555555';
const PARENT_ID = '99999999-2222-4333-8444-555555555555';
const MY_PLAN = '22222222-2222-4333-8444-555555555555';
const ID_PLAN = '33333333-2222-4333-8444-555555555555';
const MERCHANT_ID = 'merchant-row-1';

function seedDb() {
  const db = makeFakeDb();
  db._state.devices = [
    { id: CHILD_ID, role: 'Child', pairing_code: null },
    { id: PARENT_ID, role: 'Parent', pairing_code: null },
  ];
  db._state.plans = [
    { id: MY_PLAN, name: 'Combo 1 Bulan MY', description: null, kind: 'combo', price: 25, currency: 'MYR', duration_months: 1, is_active: true, created_at: '2026-01-01T00:00:00Z' },
    { id: ID_PLAN, name: 'Combo 1 Bulan', description: null, kind: 'combo', price: 35000, currency: 'IDR', duration_months: 1, is_active: true, created_at: '2026-01-01T00:00:00Z' },
  ];
  db._state.qris_merchants = [
    {
      id: MERCHANT_ID,
      merchant_id: 'go-xyz',
      merchant_name: 'Sensoria',
      phone: '812',
      device_id: 'dev',
      access_token: 'at',
      refresh_token: 'rt',
      token_updated_at: null,
      static_qris: validStaticQris(),
      static_qris_source: 'paste',
      static_qris_set_at: null,
      status: 'active',
      last_sync: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ];
  return db;
}

function buildTestApp(db) {
  return buildApp({ store: createStore({ client: db }) });
}

/** Hand-built CRC-valid static QRIS payload (mirrors emv.test fixtures). */
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

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, method, path, { body, sign = false, form } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload = '';
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
      if (sign) {
        const stamp = Math.floor(Date.now() / 1000);
        headers['X-Sensoria-Timestamp'] = String(stamp);
        headers['X-Sensoria-Sign'] = signPayload(payload, 'test-secret-web', stamp);
      }
    }
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* html */ }
          resolve({ status: res.statusCode, body: json, raw: data, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Mint a session token over the SIGNED mobile endpoint. */
async function mintSession(server, deviceId, lang = 'id') {
  const res = await request(server, 'POST', '/api/checkout-session', { body: { device_id: deviceId, lang }, sign: true });
  assert.equal(res.status, 201, `checkout-session → 201 (got ${res.status}: ${res.raw})`);
  assert.ok(res.body.token && res.body.url.startsWith('/pay/'));
  return res.body;
}

test('checkout-session: HMAC required, device must be a Child', async () => {
  const server = await listen(buildTestApp(seedDb()));
  try {
    const unsigned = await request(server, 'POST', '/api/checkout-session', { body: { device_id: CHILD_ID } });
    assert.equal(unsigned.status, 401); // HMAC gate
    const parent = await request(server, 'POST', '/api/checkout-session', { body: { device_id: PARENT_ID }, sign: true });
    assert.equal(parent.status, 403); // NOT_A_CHILD_DEVICE
    const ghost = await request(server, 'POST', '/api/checkout-session', { body: { device_id: CHILD_ID.slice(0, -1) + '0' }, sign: true });
    assert.equal(ghost.status, 404);
  } finally {
    server.close();
  }
});

test('checkout page: token page renders IDR plans by default and switches to MYR', async () => {
  const db = seedDb();
  const server = await listen(buildTestApp(db));
  try {
    const { token } = await mintSession(server, CHILD_ID, 'ms');
    const idPage = await request(server, 'GET', `/pay/${token}`);
    assert.equal(idPage.status, 200);
    assert.match(idPage.raw, /Combo 1 Bulan/);
    assert.match(idPage.raw, /Rp35\.000/);
    assert.doesNotMatch(idPage.raw, /RM25/);

    const myPage = await request(server, 'GET', `/pay/${token}?region=MY`);
    assert.equal(myPage.status, 200);
    assert.match(myPage.raw, /RM25/);
    assert.doesNotMatch(myPage.raw, /Rp35\.000/);
  } finally {
    server.close();
  }
});

test('checkout page: invalid/garbage token → expired page (403)', async () => {
  const server = await listen(buildTestApp(seedDb()));
  try {
    const res = await request(server, 'GET', '/pay/not-a-real-token');
    assert.equal(res.status, 403);
    assert.match(res.raw, /Expired|Tamat/);
  } finally {
    server.close();
  }
});

test('MY path: order created, ledger pending MYR, redirect to gateway URL', async () => {
  const db = seedDb();
  // Stub the gateway HTTP boundary — NO real network.
  const createdBills = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/index.php/api/createBill')) {
      const body = new URLSearchParams(opts.body);
      createdBills.push(Object.fromEntries(body.entries()));
      return { text: async () => JSON.stringify([{ BillCode: 'testbill1' }]) };
    }
    throw new Error('unexpected fetch ' + url);
  };
  const server = await listen(buildTestApp(db));
  try {
    const { token } = await mintSession(server, CHILD_ID, 'en');
    const res = await request(server, 'GET', `/pay/${token}/plan/${MY_PLAN}?provider=toyyibpay`);
    assert.equal(res.status, 302, 'should redirect to the gateway bill');
    assert.match(res.headers.location, /toyyibpay\.com\/testbill1/);

    const bill = createdBills[0];
    assert.equal(bill.billExternalReferenceNo, 'AAC-' + bill.billExternalReferenceNo.split('AAC-')[1]); // ref passthrough
    assert.equal(bill.billAmount, '2500', 'RM25 = 2500 sen');
    assert.equal(bill.enableDuitNowQR, '1');
    assert.ok(bill.billCallbackUrl.includes('/api/webhook/toyyibpay'));

    // Ledger + order created pending with MYR.
    assert.equal(db._state.transactions.length, 1);
    assert.equal(db._state.transactions[0].currency, 'MYR');
    assert.equal(db._state.transactions[0].status, 'pending');
    assert.equal(db._state.qris_orders[0].currency, 'MYR');
    assert.equal(db._state.qris_orders[0].raw_journal.billCode, 'testbill1');

    // Status poll (device-scoped): pending until the webhook lands.
    const ref = db._state.qris_orders[0].transaction_ref;
    const poll = await request(server, 'GET', `/pay/${token}/status/${ref}`);
    assert.equal(poll.status, 200);
    assert.equal(poll.body.status, 'pending');
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test('ID path: dynamic QRIS rendered, amount from plans', async () => {
  const db = seedDb();
  const server = await listen(buildTestApp(db));
  try {
    const { token } = await mintSession(server, CHILD_ID, 'id');
    const res = await request(server, 'GET', `/pay/${token}/plan/${ID_PLAN}?provider=qris-gobiz`);
    assert.equal(res.status, 200);
    assert.match(res.raw, /data:image\/png;base64,/);
    assert.match(res.raw, /AAC-/); // transaction ref shown
  } finally {
    server.close();
  }
});

test('toyyibPay webhook: valid hash settles, tampered hash rejected, replay no-op', async () => {
  const db = seedDb();
  const realFetch = global.fetch;
  global.fetch = async () => ({ text: async () => JSON.stringify([{ BillCode: 'testbill2' }]) });
  const server = await listen(buildTestApp(db));
  try {
    const { token } = await mintSession(server, CHILD_ID);
    await request(server, 'GET', `/pay/${token}/plan/${MY_PLAN}?provider=toyyibpay`);
    const ref = db._state.qris_orders[0].transaction_ref;

    const cb = (over = {}) => ({
      refno: 'TP-1',
      status: '1',
      reason: 'Payment successful',
      billcode: 'testbill2',
      order_id: ref,
      amount: '25.00',
      transaction_time: '2026-10-07 10:00:00',
      hash: crypto.createHash('md5').update(`toyyib-test-key1${ref}TP-1ok`).digest('hex'),
      ...over,
    });

    const bad = await request(server, 'POST', '/api/webhook/toyyibpay', { form: cb({ hash: 'deadbeef'.repeat(4) }) });
    assert.equal(bad.status, 403);
    assert.equal(db._state.transactions[0].status, 'pending', 'tampered callback must NOT settle');

    const good = await request(server, 'POST', '/api/webhook/toyyibpay', { form: cb() });
    assert.equal(good.status, 200);
    assert.equal(good.body.outcome, 'settled');
    assert.equal(db._state.transactions[0].status, 'paid');
    assert.equal(db._state.qris_orders[0].status, 'paid');
    assert.equal(db._state.qris_orders[0].matched_journal_id, 'toyyibpay:testbill2');

    const replay = await request(server, 'POST', '/api/webhook/toyyibpay', { form: cb() });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.outcome, 'already');
    assert.equal(db._state.transactions.length, 1, 'no double ledger');
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});

test('pollToyyibPayOrder settles an unpaid-but-actually-paid bill (callback lost)', async () => {
  const db = seedDb();
  const realFetch = global.fetch;
  const server = await listen(buildTestApp(db));
  try {
    global.fetch = async () => ({ text: async () => JSON.stringify([{ BillCode: 'testbill3' }]) });
    const { token } = await mintSession(server, CHILD_ID);
    await request(server, 'GET', `/pay/${token}/plan/${MY_PLAN}?provider=toyyibpay`);

    const providers = require('../src/providers');
    const store = server.app === undefined ? null : null; // fetch store via app.get
    // Grab the real store the app built: re-create is fine — same fake db.
    const store2 = createStore({ client: db });
    const order = await store2.getOrderById(db, db._state.qris_orders[0].id);

    global.fetch = async () => ({
      text: async () =>
        JSON.stringify([
          { billpaymentStatus: '2', billpaymentAmount: '25.00' },
          { billpaymentStatus: '1', billpaymentAmount: '25.00', billpaymentChannel: 'DuitNow QR', billpaymentInvoiceNo: 'TP-9' },
        ]),
    });
    const outcome = await providers.pollToyyibPayOrder(store2, db, order);
    assert.equal(outcome, 'settled');
    assert.equal(db._state.transactions[0].status, 'paid');
    void store;
  } finally {
    global.fetch = realFetch;
    server.close();
  }
});
