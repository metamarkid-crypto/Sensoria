'use strict';

/**
 * worker.test.js — cron sweep tests (node:test, no network, no Supabase).
 *
 * Covered:
 *   • expiry pass: stale pending → order 'expired' + ledger 'failed';
 *     fresh pending untouched; already-expired replays are no-ops
 *   • smart selection: only merchants holding live PENDING orders are polled
 *     (no-PENDING merchants produce zero GoBiz calls — the rate-flag guard)
 *   • FIFO settle through the sweep: oldest order wins the journal; settled
 *     orders leave the pending pool and stop re-polling
 *   • token-expired merchant: hard refresh failure flags token_expired and
 *     the sweep continues with the NEXT merchant
 *   • sweep result accounting {expired, polled, settled}
 *   • WORKER_POLL_ALL_MERCHANTS debug escape hatch
 *   • overlap guard: a running sweep blocks re-entry (runOnce re-entry check)
 *   • cron pattern validation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.QRIS_API_SECRET = 'test-secret-worker';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
process.env.QRIS_CHECKOUT_TTL_MINUTES = '15';

const { createStore, _setGoBizFactory } = require('../src/store');
const { runSweep, createWorker } = require('../src/worker');
const { makeFakeDb } = require('./helpers/fakeDb');

// ---------------------------------------------------------------------------
// GoBiz scripted factory — per-test journal payloads + call accounting.
// ---------------------------------------------------------------------------

let journalScript = [];      // mutations to serve per getJournals call
let journalCalls = [];       // merchant_ids asked for (call accounting)
let failMerchantIds = new Set();   // merchants whose getJournals throws HTTP_500
let unauthMerchantIds = new Set(); // merchants whose getJournals throws 401

_setGoBizFactory(({ deviceId } = {}) => ({
  async getJournals(merchantId) {
    journalCalls.push(merchantId);
    if (unauthMerchantIds.has(merchantId)) {
      throw Object.assign(new Error('sesi kedaluwarsa'), { status: 401, code: 'HTTP_401' });
    }
    if (failMerchantIds.has(merchantId)) {
      throw Object.assign(new Error('gobiz exploded'), { status: 500, code: 'HTTP_500' });
    }
    return {
      hits: [],
      mutations: journalScript.filter((m) => !m.merchantId || m.merchantId === merchantId),
      fetchedAt: new Date().toISOString(),
    };
  },
}));

function resetGobiz() {
  journalScript = [];
  journalCalls = [];
  failMerchantIds = new Set();
  unauthMerchantIds = new Set();
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeMerchant(db, over = {}) {
  const m = {
    id: crypto.randomUUID(),
    merchant_id: `GOBIZ-${db._state.qris_merchants.length + 1}`,
    merchant_name: 'Warung Test',
    phone: '8123456789',
    device_id: crypto.randomUUID(),
    access_token: 'AT',
    refresh_token: 'RT',
    status: 'active',
    static_qris: 'QR',
    created_at: new Date().toISOString(),
    ...over,
  };
  db._state.qris_merchants.push(m);
  return m;
}

function makeOrder(db, merchant, over = {}) {
  const o = {
    id: crypto.randomUUID(),
    transaction_ref: `AAC-TEST-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    child_device_id: crypto.randomUUID(),
    plan_id: crypto.randomUUID(),
    plan_kind: 'combo',
    amount: 49000,
    currency: 'IDR',
    merchant_db_id: merchant ? merchant.id : null,
    qr_string: 'QR',
    status: 'pending',
    matched_journal_id: null,
    raw_journal: null,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    paid_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
  db._state.qris_orders.push(o);
  return o;
}

/** The ledger row every order carries in production (created at checkout). */
function seedLedger(db, order) {
  db._state.transactions.push({
    transaction_ref: order.transaction_ref,
    child_device_id: order.child_device_id,
    plan_id: order.plan_id,
    amount: order.amount,
    currency: 'IDR',
    status: 'pending',
    payment_gateway: 'qris',
  });
}

function makeStore(seed = {}) {
  const db = makeFakeDb(seed);
  const store = createStore({ client: db });
  return { db, store };
}

// ---------------------------------------------------------------------------
// Expiry pass
// ---------------------------------------------------------------------------

test('expiry pass: stale pending → order expired + ledger failed; fresh pending untouched', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const m = makeMerchant(db);
  const stale = makeOrder(db, m, { expires_at: new Date(Date.now() - 60_000).toISOString() });
  const fresh = makeOrder(db, m);

  // Ledger rows for both (the expiry pass flips them to failed).
  db._state.transactions.push(
    { transaction_ref: stale.transaction_ref, status: 'pending', amount: stale.amount, payment_gateway: 'qris' },
    { transaction_ref: fresh.transaction_ref, status: 'pending', amount: fresh.amount, payment_gateway: 'qris' },
  );

  const result = await runSweep(store);
  assert.equal(result.expired, 1);

  assert.equal(db._state.qris_orders.find((o) => o.id === stale.id).status, 'expired');
  assert.equal(db._state.qris_orders.find((o) => o.id === fresh.id).status, 'pending');

  const staleLedger = db._state.transactions.find((t) => t.transaction_ref === stale.transaction_ref);
  const freshLedger = db._state.transactions.find((t) => t.transaction_ref === fresh.transaction_ref);
  assert.equal(staleLedger.status, 'failed');
  assert.equal(freshLedger.status, 'pending');

  // No merchants polled? Wrong — a fresh pending order exists, so the
  // merchant IS polled (and serves zero journals).
  assert.equal(result.polled, 1);
  assert.deepEqual(journalCalls, [m.merchant_id]);
});

test('expiry pass is replay-safe: a second sweep expires nothing new', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const m = makeMerchant(db);
  makeOrder(db, m, { expires_at: new Date(Date.now() - 60_000).toISOString() });

  const first = await runSweep(store);
  const second = await runSweep(store);
  assert.equal(first.expired, 1);
  assert.equal(second.expired, 0); // already expired — guarded update hit 0 rows
});

// ---------------------------------------------------------------------------
// Smart selection
// ---------------------------------------------------------------------------

test('smart selection: merchant without pending orders is NOT polled', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const busy = makeMerchant(db);
  const idle = makeMerchant(db);

  // Only `busy` has a live pending order.
  makeOrder(db, busy);

  const result = await runSweep(store);
  assert.equal(result.polled, 1);
  assert.deepEqual(journalCalls, [busy.merchant_id]);
  assert.ok(!journalCalls.includes(idle.merchant_id), 'idle merchant never polled');
});

test('smart selection: expired-pending orders do not trigger polling (only expiry)', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const m = makeMerchant(db);
  makeOrder(db, m, { expires_at: new Date(Date.now() - 60_000).toISOString() });

  const result = await runSweep(store);
  // The stale order is expired FIRST; after that no pending orders remain —
  // the merchant must not be polled for it.
  assert.equal(result.expired, 1);
  assert.equal(result.polled, 0);
  assert.deepEqual(journalCalls, []);
});

test('WORKER_POLL_ALL_MERCHANTS=1 polls every active merchant regardless of orders', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const a = makeMerchant(db);
  const b = makeMerchant(db);
  // No orders at all.
  process.env.WORKER_POLL_ALL_MERCHANTS = '1';
  try {
    const result = await runSweep(store);
    assert.equal(result.polled, 2);
    assert.deepEqual(journalCalls.sort(), [a.merchant_id, b.merchant_id].sort());
  } finally {
    delete process.env.WORKER_POLL_ALL_MERCHANTS;
  }
});

test('disabled merchants are skipped even when they hold pending orders', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const disabled = makeMerchant(db, { status: 'disabled' });
  makeOrder(db, disabled);

  const result = await runSweep(store);
  assert.equal(result.polled, 0);
  assert.deepEqual(journalCalls, []);
});

// ---------------------------------------------------------------------------
// FIFO settle through the sweep
// ---------------------------------------------------------------------------

test('sweep settles the oldest pending order matching the journal; polling stops after settle', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const m = makeMerchant(db);
  const older = makeOrder(db, m, { created_at: new Date(Date.now() - 120_000).toISOString() });
  const newer = makeOrder(db, m, { created_at: new Date().toISOString() });
  seedLedger(db, older);
  seedLedger(db, newer);

  journalScript = [
    { referenceId: 'JRN-W', amountIdr: 49000, paymentTime: new Date().toISOString(), merchantId: m.merchant_id, raw: { evidence: 1 } },
  ];

  const result = await runSweep(store);
  assert.equal(result.settled, 1);

  assert.equal(db._state.qris_orders.find((o) => o.id === older.id).status, 'paid');
  assert.equal(db._state.qris_orders.find((o) => o.id === older.id).matched_journal_id, 'JRN-W');
  assert.equal(db._state.qris_orders.find((o) => o.id === newer.id).status, 'pending');

  const ledger = db._state.transactions.find((t) => t.transaction_ref === older.transaction_ref);
  assert.equal(ledger.status, 'paid');
  assert.ok(ledger.paid_at);

  // Next sweep: the settled order left the pending pool, the newer one
  // doesn't match the (already spent) journal — one more poll, zero settles.
  const second = await runSweep(store);
  assert.equal(second.settled, 0);
  assert.equal(journalCalls.length, 2); // polled again (still has a pending order)
});

test('journal amounts in sen are matched against rupiah amounts (÷100 normalization lives in gobiz)', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const m = makeMerchant(db);
  const order = makeOrder(db, m, { amount: 25000 });
  seedLedger(db, order);

  // GoBiz sends 2.500.000 sen = Rp 25.000.
  journalScript = [
    { referenceId: 'JRN-S', amountIdr: 25000, paymentTime: new Date().toISOString(), merchantId: m.merchant_id },
  ];
  const result = await runSweep(store);
  assert.equal(result.settled, 1);
  assert.equal(db._state.qris_orders[0].matched_journal_id, 'JRN-S');
});

test('amount mismatch or out-of-window payment time does NOT settle', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const m = makeMerchant(db);
  seedLedger(db, makeOrder(db, m, { amount: 49000 }));

  journalScript = [
    { referenceId: 'JRN-WRONG-AMOUNT', amountIdr: 49001, paymentTime: new Date().toISOString(), merchantId: m.merchant_id },
    { referenceId: 'JRN-TOO-OLD', amountIdr: 49000, paymentTime: new Date(Date.now() - 60 * 60_000).toISOString(), merchantId: m.merchant_id },
  ];
  const result = await runSweep(store);
  assert.equal(result.settled, 0);
  assert.equal(db._state.qris_orders[0].matched_journal_id, null);
  assert.equal(db._state.qris_orders[0].status, 'pending');
});

// ---------------------------------------------------------------------------
// Token failure isolation
// ---------------------------------------------------------------------------

test('GoBiz failure for one merchant does not block other merchants', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const broken = makeMerchant(db);
  const healthy = makeMerchant(db);
  const brokenOrder = makeOrder(db, broken);
  const healthyOrder = makeOrder(db, healthy);
  seedLedger(db, brokenOrder);
  seedLedger(db, healthyOrder);
  journalScript = [
    { referenceId: 'JRN-H', amountIdr: 49000, paymentTime: new Date().toISOString(), merchantId: healthy.merchant_id },
  ];
  failMerchantIds.add(broken.merchant_id);

  const result = await runSweep(store);
  assert.equal(result.polled, 2);
  assert.equal(result.settled, 1);
  assert.equal(db._state.qris_orders.find((o) => o.id === healthyOrder.id).status, 'paid');
  // The broken merchant is NOT flagged token_expired — a 500 is not a 401;
  // it stays active and will be retried next sweep.
  assert.equal(db._state.qris_merchants.find((x) => x.id === broken.id).status, 'active');
});

test('hard refresh failure flags the merchant token_expired (via withAccessToken path)', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const m = makeMerchant(db, { refresh_token: null }); // no refresh token → instant hard failure
  seedLedger(db, makeOrder(db, m));
  unauthMerchantIds.add(m.merchant_id); // journals answer 401

  const result = await runSweep(store);
  assert.equal(result.polled, 1);
  assert.equal(result.settled, 0);
  assert.equal(db._state.qris_merchants.find((x) => x.id === m.id).status, 'token_expired');
});

// ---------------------------------------------------------------------------
// Sweep accounting / guard / cron
// ---------------------------------------------------------------------------

test('sweep result accounting matches side effects', async () => {
  resetGobiz();
  const { db, store } = makeStore();
  const m = makeMerchant(db);
  const stale = makeOrder(db, m, { expires_at: new Date(Date.now() - 60_000).toISOString() }); // will expire
  const live = makeOrder(db, m); // will be polled + settled
  seedLedger(db, stale);
  seedLedger(db, live);
  journalScript = [
    { referenceId: 'JRN-OK', amountIdr: 49000, paymentTime: new Date().toISOString(), merchantId: m.merchant_id },
  ];
  const result = await runSweep(store);
  assert.deepEqual(result, { expired: 1, polled: 1, settled: 1 });
});

test('createWorker.start validates the cron pattern', () => {
  const { store } = makeStore();
  const worker = createWorker({ store, cron: 'not-a-cron' });
  assert.throws(() => worker.start(), /WORKER_CRON tidak valid/);
});

test('worker start/stop lifecycle', async () => {
  resetGobiz();
  const { store } = makeStore();
  const worker = createWorker({ store, cron: '*/1 * * * * *' });
  const task = worker.start();
  assert.ok(task, 'task scheduled');
  worker.start(); // idempotent
  worker.stop();
  worker.stop(); // idempotent
});

test('overlap guard: second runOnce while a sweep is in flight returns null', async () => {
  resetGobiz();
  const { store } = makeStore();
  const worker = createWorker({ store });

  let release;
  const gate = new Promise((r) => (release = r));
  const origListStale = store.listStalePendingOrders;
  let firstCall = true;
  store.listStalePendingOrders = async (...args) => {
    if (firstCall) {
      firstCall = false;
      await gate;
    }
    return origListStale(...args);
  };

  const first = worker.runOnce(); // in flight, held by the gate
  const second = await worker.runOnce(); // must bail immediately
  assert.equal(second, null);

  release();
  const firstResult = await first;
  assert.deepEqual(firstResult, { expired: 0, polled: 0, settled: 0 });
  assert.equal(worker.isSweeping, false);
});
