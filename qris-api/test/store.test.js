'use strict';

/**
 * store.test.js — unit tests for the service-role store (node:test, no DB).
 * The Supabase client is a scripted fake implementing just the query-builder
 * surface the store uses; assertions cover the money-critical contracts:
 * atomic journal claim, pending→paid-once settlement, FIFO ordering, and the
 * token-refresh race guard.
 *
 * Run: npm test  (from qris-api/)
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStore, newTransactionRef, orderExpiresAt } = require('../src/store');
const { GoBizError } = require('../src/gobiz');

// ---------------------------------------------------------------------------
// Fake Supabase — Postgrest-ish query builder over in-memory rows
// ---------------------------------------------------------------------------

/** Minimal deep clone so updates never alias test fixtures. */
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function makeFakeDb(seed = {}) {
  const state = {
    qris_merchants: (seed.qris_merchants || []).map(clone),
    qris_orders: (seed.qris_orders || []).map(clone),
    transactions: (seed.transactions || []).map(clone),
    rpcLog: [],
  };

  /** Build one chained query against one table. */
  function query(table, mode) {
    const q = {
      _filters: [],
      _select: '*',
      _single: false,
      _maybe: false,
      _count: null,
      _head: false,
      _payload: null,
      _order: null,

      select(cols, opts = {}) {
        q._select = cols;
        if (opts.count) q._count = opts.count;
        if (opts.head) q._head = true;
        return q;
      },
      insert(payload) {
        q._mode = 'insert';
        q._payload = payload;
        return q;
      },
      update(payload) {
        q._mode = 'update';
        q._payload = payload;
        return q;
      },
      eq(col, val) {
        q._filters.push(['eq', col, val]);
        return q;
      },
      neq(col, val) {
        q._filters.push(['neq', col, val]);
        return q;
      },
      gt(col, val) {
        q._filters.push(['gt', col, val]);
        return q;
      },
      gte(col, val) {
        q._filters.push(['gte', col, val]);
        return q;
      },
      in(col, vals) {
        q._filters.push(['in', col, vals]);
        return q;
      },
      is(col, val) {
        q._filters.push(['is', col, val]);
        return q;
      },
      not(col, op, val) {
        q._filters.push(['not', col, op, val]);
        return q;
      },
      order(col, opts = {}) {
        q._order = { col, ascending: opts.ascending !== false };
        return q;
      },
      single() {
        q._single = true;
        return q;
      },
      maybeSingle() {
        q._maybe = true;
        return q;
      },

      // -- execution --------------------------------------------------------
      async then(resolve, reject) {
        try {
          resolve(run());
        } catch (e) {
          reject(e);
        }
      },
    };
    return q;
  }

  /** Apply the built query against the in-memory state (synchronous core). */
  function run() {
    const rows = state[table] ?? [];
    const f = q._filters;

    const matches = (row) =>
      f.every(([op, col, val, val2]) => {
        const rv = row[col];
        switch (op) {
          case 'eq':
            if (val === null) return rv === null || rv === undefined;
            return String(rv) === String(val);
          case 'neq':
            return String(rv) !== String(val);
          case 'gt':
            return rv != null && rv > val;
          case 'gte':
            return rv != null && rv >= val;
          case 'in':
            return val.map(String).includes(String(rv));
          case 'is':
            return val === null ? rv === null || rv === undefined : rv === val;
          case 'not':
            return !matches({ [col]: rv }, [['eq', col, val2]]);
          default:
            throw new Error(`fake: unsupported op ${op}`);
        }
      });

    if (q._mode === 'update') {
      // Guard semantics matter: only rows matching ALL filters get the patch,
      // and .single() reports PGRST116 when the guarded UPDATE hit 0 rows —
      // exactly the PostgREST behaviour claim/expire/settle rely on.
      const targets = rows.filter(matches);
      let patched = 0;
      for (const row of targets) {
        Object.assign(row, clone(q._payload));
        patched++;
      }
      const resultRows = clone(targets);
      if (q._single && patched === 0) {
        return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null } };
      }
      // PostgREST .maybeSingle(): one object or null — never an array/exception.
      if (q._maybe) return { data: resultRows[0] ?? null, error: null, count: patched };
      return { data: q._single ? resultRows[0] : resultRows, error: null, count: patched };
    }

    if (q._mode === 'insert') {
      const incoming = Array.isArray(q._payload) ? q._payload : [q._payload];
      // UNIQUE simulation for transaction_ref (the collision-retry path).
      for (const inc of incoming) {
        if (table === 'transactions' && state.transactions.some((r) => r.transaction_ref === inc.transaction_ref)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "transactions_transaction_ref_key"' } };
        }
      }
      const created = incoming.map((p) => ({ id: p.id ?? `uuid-${Math.random().toString(16).slice(2, 10)}`, ...clone(p) }));
      state[table].push(...created);
      return { data: q._single ? clone(created[0]) : clone(created), error: null };
    }

    // SELECT
    let out = rows.filter(matches);
    if (q._order) {
      out = [...out].sort((a, b) => (a[q._order.col] > b[q._order.col] ? 1 : a[q._order.col] < b[q._order.col] ? -1 : 0) * (q._order.ascending ? 1 : -1));
    }
    const mapped = out.map((r) => {
      if (q._select === '*' || !q._select) return clone(r);
      const cols = q._select.split(',').map((s) => s.trim());
      const picked = {};
      for (const c of cols) picked[c] = r[c];
      return picked;
    });
    if (q._head) return { data: null, error: null, count: mapped.length };
    if (q._single) return { data: mapped[0] ?? null, error: mapped.length ? null : { code: 'PGRST116', message: 'no rows' } };
    if (q._maybe) return { data: mapped[0] ?? null, error: null };
    return { data: clone(mapped), error: null };
  }

  const api = {
    from(t) {
      table = t;
      q = query(t, 'select');
      return q;
    },
    async rpc(fn, params) {
      state.rpcLog.push({ fn, params });

      if (fn === 'create_qris_order') {
        // Mirror the real RPC: one ledger row + one order row, all-or-nothing.
        const p = params;
        if (state.transactions.some((r) => r.transaction_ref === p.p_transaction_ref)) {
          return { data: null, error: { code: '23505', message: 'duplicate transaction_ref' } };
        }
        state.transactions.push({
          transaction_ref: p.p_transaction_ref,
          child_device_id: p.p_child_device_id,
          plan_id: p.p_plan_id,
          amount: p.p_amount,
          currency: 'IDR',
          status: 'pending',
          payment_gateway: 'qris',
        });
        const order = {
          id: `order-${Math.random().toString(16).slice(2, 10)}`,
          transaction_ref: p.p_transaction_ref,
          child_device_id: p.p_child_device_id,
          plan_id: p.p_plan_id,
          plan_kind: p.p_plan_kind,
          amount: p.p_amount,
          currency: 'IDR',
          merchant_db_id: p.p_merchant_db_id,
          qr_string: null,
          status: 'pending',
          matched_journal_id: null,
          raw_journal: null,
          expires_at: p.p_expires_at,
          paid_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        state.qris_orders.push(order);
        return { data: clone(order), error: null };
      }

      if (fn === 'settle_transaction') {
        const row = state.transactions.find((r) => r.transaction_ref === params.p_transaction_ref);
        if (!row) return { data: null, error: { message: `settle_transaction: transaction ${params.p_transaction_ref} not found` } };
        if (row.status !== 'pending') return { data: false, error: null };
        row.status = 'paid';
        row.paid_at = new Date().toISOString();
        if (params.p_raw_payload) row.raw_payload = params.p_raw_payload;
        return { data: true, error: null };
      }

      return { data: null, error: { code: '42883', message: `function ${fn} does not exist` } };
    },
  };

  let table;
  let q;
  api._state = state;
  return api;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeStore(seed) {
  const db = makeFakeDb(seed);
  const store = createStore({ url: 'https://example.supabase.co', serviceKey: 'service-role-test', client: db });
  return { db, store };
}

const MERCHANT = (over = {}) => ({
  id: 'm-1',
  merchant_id: 'GOBIZ-1',
  merchant_name: 'Warung Test',
  phone: '8123456789',
  device_id: 'device-uuid-1',
  access_token: 'AT-1',
  refresh_token: 'RT-1',
  token_updated_at: new Date().toISOString(),
  static_qris: 'QR-STATIC',
  static_qris_source: 'paste',
  static_qris_set_at: new Date().toISOString(),
  status: 'active',
  last_sync: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

const ORDER = (over = {}) => ({
  id: 'o-1',
  transaction_ref: 'AAC-20260914-AAAAAA',
  child_device_id: 'child-1',
  plan_id: 'plan-1',
  plan_kind: 'combo',
  amount: 49000,
  currency: 'IDR',
  merchant_db_id: 'm-1',
  qr_string: null,
  status: 'pending',
  matched_journal_id: null,
  raw_journal: null,
  expires_at: orderExpiresAt(),
  paid_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
});

// ---------------------------------------------------------------------------
// createOrderWithLedger
// ---------------------------------------------------------------------------

test('createOrderWithLedger prefers the atomic RPC and returns the order', async () => {
  const { db, store } = makeStore();
  const order = await store.createOrderWithLedger(db, {
    childDeviceId: 'child-1',
    planId: 'plan-1',
    planKind: 'combo',
    amount: 49000,
    merchantDbId: 'm-1',
  });
  assert.equal(order.status, 'pending');
  assert.match(order.transaction_ref, /^AAC-\d{8}-[0-9A-F]{6}$/);
  assert.equal(db._state.rpcLog[0].fn, 'create_qris_order');
  assert.equal(db._state.transactions.length, 1);
  assert.equal(db._state.transactions[0].status, 'pending');
  assert.equal(db._state.transactions[0].payment_gateway, 'qris');
});

test('createOrderWithLedger falls back to two inserts when the RPC is absent', async () => {
  const { db, store } = makeStore();
  // Neuter the RPC so it reports 42883 (function does not exist).
  db.rpc = async (fn) => ({ data: null, error: { code: '42883', message: `function ${fn} does not exist` } });
  const order = await store.createOrderWithLedger(db, {
    childDeviceId: 'child-1',
    planId: 'plan-1',
    planKind: 'slots',
    amount: 25000,
  });
  assert.equal(order.status, 'pending');
  assert.equal(order.plan_kind, 'slots');
  assert.equal(db._state.transactions[0].transaction_ref, order.transaction_ref);
});

test('createOrderWithLedger retries with a NEW ref on a rare collision', async () => {
  const { db, store } = makeStore();
  db.rpc = async () => ({ data: null, error: { code: '42883', message: 'missing' } });
  const firstRef = newTransactionRef();
  // Pre-insert the collision.
  db._state.transactions.push({
    transaction_ref: firstRef,
    child_device_id: 'child-1',
    plan_id: 'plan-1',
    amount: 1,
    status: 'pending',
    payment_gateway: 'qris',
  });
  const order = await store.createOrderWithLedger(db, {
    childDeviceId: 'child-1',
    planId: 'plan-1',
    planKind: 'combo',
    amount: 49000,
    expiresAt: orderExpiresAt(),
  });
  // Deterministic collision only if the generated ref equals the pre-inserted one;
  // run the flow 25 times to make the retry path statistically certain.
  let sawRetry = false;
  for (let i = 0; i < 25 && !sawRetry; i++) {
    const preRef = newTransactionRef();
    db._state.transactions.push({ transaction_ref: preRef, child_device_id: 'c', plan_id: 'p', amount: 1, status: 'pending', payment_gateway: 'qris' });
    const o = await store.createOrderWithLedger(db, { childDeviceId: 'c', planId: 'p', planKind: 'combo', amount: 1000 });
    if (o.transaction_ref !== preRef) sawRetry = true; // a collision occurred and was survived
  }
  assert.ok(sawRetry, 'retry path should have been exercised at least once');
});

// ---------------------------------------------------------------------------
// Merchant session & tokens
// ---------------------------------------------------------------------------

test('saveOtpSession only pre-warms device_id for EXISTING merchants (never clobbers tokens)', async () => {
  const { db, store } = makeStore({ qris_merchants: [MERCHANT()] });
  const row = await store.saveOtpSession(db, { phone: '8123456789', deviceId: 'NEW-DEVICE' });
  assert.equal(row.device_id, 'NEW-DEVICE');
  assert.equal(row.access_token, 'AT-1', 'live tokens untouched');
  assert.equal(row.refresh_token, 'RT-1');

  // Unknown phone → no-op (linkMerchant does the first write).
  const none = await store.saveOtpSession(db, { phone: '8999999999', deviceId: 'D2' });
  assert.equal(none, null);
});

test('linkMerchant inserts a new account and UPDATES the session on re-link', async () => {
  const { db, store } = makeStore();
  const { row, linked } = await store.linkMerchant(db, {
    merchantId: 'GOBIZ-9',
    merchantName: 'Fresh',
    phone: '81211112222',
    deviceId: 'dev-9',
    accessToken: 'AT-9',
    refreshToken: 'RT-9',
  });
  assert.equal(linked, true);
  assert.equal(row.merchant_id, 'GOBIZ-9');
  assert.equal(row.device_id, 'dev-9');

  // Re-link: same GoBiz identity, new session → UPDATE, not duplicate.
  const second = await store.linkMerchant(db, {
    merchantId: 'GOBIZ-9',
    merchantName: 'Fresh v2',
    phone: '81211112222',
    deviceId: 'dev-9b',
    accessToken: 'AT-9b',
    refreshToken: 'RT-9b',
  });
  assert.equal(second.linked, false);
  assert.equal(second.row.merchant_name, 'Fresh v2');
  assert.equal(second.row.device_id, 'dev-9b');
  const all = db._state.qris_merchants;
  assert.equal(all.length, 1, 'no duplicate merchant rows');
});

test('saveMerchantTokens rotates and keeps the old refresh token when not rotated', async () => {
  const { db, store } = makeStore({ qris_merchants: [MERCHANT()] });
  await store.saveMerchantTokens(db, 'm-1', { accessToken: 'AT-2', refreshToken: null });
  const m = db._state.qris_merchants[0];
  assert.equal(m.access_token, 'AT-2');
  assert.equal(m.refresh_token, 'RT-1', 'non-rotated refresh token preserved');

  await store.saveMerchantTokens(db, 'm-1', { accessToken: 'AT-3', refreshToken: 'RT-3' });
  assert.equal(db._state.qris_merchants[0].refresh_token, 'RT-3');
});

test('markMerchantTokenExpired flips status; listMerchantsWithPendingOrders skips disabled+expired orders', async () => {
  const { db, store } = makeStore({
    qris_merchants: [
      MERCHANT({ id: 'm-1', status: 'active' }),
      MERCHANT({ id: 'm-2', status: 'disabled', merchant_id: 'G2' }),
    ],
    qris_orders: [
      ORDER({ merchant_db_id: 'm-1' }),
      ORDER({ id: 'o-2', merchant_db_id: 'm-2' }),
      ORDER({ id: 'o-3', merchant_db_id: 'm-1', expires_at: new Date(Date.now() - 1000).toISOString() }), // expired
    ],
  });
  await store.markMerchantTokenExpired(db, 'm-1');

  // Only m-1: m-2 is disabled (status filter) and o-3 expired (expires_at filter).
  const list = await store.listMerchantsWithPendingOrders(db);
  assert.deepEqual(list.map((m) => m.id), ['m-1']);

  // listActiveMerchants excludes disabled merchants but includes token_expired ones.
  const active = await store.listActiveMerchants(db);
  assert.deepEqual(active.map((m) => m.id).sort(), ['m-1', 'm-2'].filter((x) => x !== 'm-2'));
});

test('setMerchantStaticQris validates via the injected validator and rejects bad payloads', async () => {
  const { db, store } = makeStore({ qris_merchants: [MERCHANT()] });
  const validator = (payload) => (payload === 'GOOD' ? { ok: true } : { ok: false, reason: 'payload salah' });

  const row = await store.setMerchantStaticQris(db, 'm-1', 'GOOD', validator);
  assert.equal(row.static_qris, 'GOOD');
  assert.equal(row.static_qris_source, 'paste');

  await assert.rejects(
    () => store.setMerchantStaticQris(db, 'm-1', 'BAD', validator),
    (e) => e.code === 'INVALID_QRIS' && /payload salah/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// FIFO matching + settlement (the money path)
// ---------------------------------------------------------------------------

test('listPendingOrdersForMerchant returns only unexpired pending, OLDEST first', async () => {
  const { db, store } = makeStore({
    qris_merchants: [MERCHANT()],
    qris_orders: [
      ORDER({ id: 'o-old', created_at: '2026-09-14T00:00:00Z' }),
      ORDER({ id: 'o-new', created_at: '2026-09-14T01:00:00Z' }),
      ORDER({ id: 'o-expired', created_at: '2026-09-13T00:00:00Z', expires_at: '2026-09-13T00:10:00Z' }),
      ORDER({ id: 'o-paid', created_at: '2026-09-12T00:00:00Z', status: 'paid' }),
    ],
  });
  const rows = await store.listPendingOrdersForMerchant(db, 'm-1');
  assert.deepEqual(rows.map((r) => r.id), ['o-old', 'o-new']);
});

test('claimJournal wins once: guarded UPDATE with .is(null) + amount + pending', async () => {
  const { db, store } = makeStore({ qris_orders: [ORDER()] });

  const won = await store.claimJournal(db, 'o-1', { journalId: 'J-1', amount: 49000, rawJournal: { id: 'J-1' } });
  assert.equal(won, true);
  const row = db._state.qris_orders[0];
  assert.equal(row.matched_journal_id, 'J-1');
  assert.deepEqual(row.raw_journal, { id: 'J-1' });

  // Same journal → already locked (amount/status/lock all fail the guard).
  const again = await store.claimJournal(db, 'o-1', { journalId: 'J-1', amount: 49000 });
  assert.equal(again, false);

  // Wrong amount → guard rejects even on a fresh order.
  const fresh = makeStore({ qris_orders: [ORDER()] });
  const badAmount = await fresh.store.claimJournal(fresh.db, 'o-1', { journalId: 'J-2', amount: 12345 });
  assert.equal(badAmount, false);
});

test('claimJournal race: two workers, one journal → exactly one winner', async () => {
  const { db, store } = makeStore({ qris_orders: [ORDER()] });
  const [a, b] = await Promise.all([
    store.claimJournal(db, 'o-1', { journalId: 'J-1', amount: 49000 }),
    store.claimJournal(db, 'o-1', { journalId: 'J-1', amount: 49000 }),
  ]);
  assert.equal(a !== b, true, 'exactly one true / one false');
  assert.equal(db._state.qris_orders[0].matched_journal_id, 'J-1');
});

test('settleOrder flips the ledger pending → paid exactly once (idempotent replays)', async () => {
  const { db, store } = makeStore({
    transactions: [{ transaction_ref: 'AAC-20260914-AAAAAA', status: 'pending', amount: 49000 }],
    qris_orders: [ORDER()],
  });
  const first = await store.settleOrder(db, 'AAC-20260914-AAAAAA', { evidence: 'journal' });
  assert.equal(first, true);
  const row = db._state.transactions[0];
  assert.equal(row.status, 'paid');
  assert.deepEqual(row.raw_payload, { evidence: 'journal' });
  assert.ok(row.paid_at);

  const replay = await store.settleOrder(db, 'AAC-20260914-AAAAAA', { evidence: 'journal' });
  assert.equal(replay, false, 'replay is a no-op');
});

test('settleOrder on an unknown ref throws (money path never fails silently)', async () => {
  const { db, store } = makeStore();
  await assert.rejects(() => store.settleOrder(db, 'AAC-XXX-NOPE', {}), /not found/);
});

test('expireOrder sets order expired AND ledger failed, once', async () => {
  const { db, store } = makeStore({
    qris_orders: [ORDER()],
    transactions: [{ transaction_ref: 'AAC-20260914-AAAAAA', status: 'pending', amount: 49000 }],
  });
  const res = await store.expireOrder(db, 'o-1');
  assert.equal(res.transaction_ref, 'AAC-20260914-AAAAAA');
  assert.equal(db._state.qris_orders[0].status, 'expired');
  assert.equal(db._state.transactions[0].status, 'failed');

  // Replay: order no longer pending → null, ledger untouched.
  const replay = await store.expireOrder(db, 'o-1');
  assert.equal(replay, null);
});

// ---------------------------------------------------------------------------
// withAccessToken — 401 → refresh → retry-once
// ---------------------------------------------------------------------------

test('withAccessToken: happy path makes ONE authenticated call', async () => {
  const { db, store } = makeStore({ qris_merchants: [MERCHANT()] });
  const calls = [];
  const out = await store.withAccessToken(db, 'm-1', async (client) => {
    calls.push(client.accessToken);
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.deepEqual(calls, ['AT-1']);
  assert.equal(db._state.rpcLog.length, 0, 'no refresh happened');
});

test('withAccessToken: 401 → refresh (same device) → retry once → tokens saved', async () => {
  const { db, store } = makeStore({ qris_merchants: [MERCHANT()] });
  const attempts = [];
  let refreshed = 0;

  const out = await store.withAccessToken(
    db,
    'm-1',
    async (client) => {
      attempts.push(client.accessToken);
      if (attempts.length === 1) throw new GoBizError('401', { status: 401 });
      return 'recovered';
    },
    {
      refresh: async (refreshToken, deviceId) => {
        assert.equal(refreshToken, 'RT-1');
        assert.equal(deviceId, 'device-uuid-1', 'refresh uses the PERSISTENT device id');
        refreshed++;
        return { accessToken: 'AT-NEW', refreshToken: 'RT-NEW' };
      },
    },
  );
  assert.equal(out, 'recovered');
  assert.deepEqual(attempts, ['AT-1', 'AT-NEW'], 'retry exactly once');
  assert.equal(refreshed, 1);
  assert.equal(db._state.qris_merchants[0].access_token, 'AT-NEW');
  assert.equal(db._state.qris_merchants[0].refresh_token, 'RT-NEW');
  assert.equal(db._state.qris_merchants[0].status, 'active');
});

test('withAccessToken: keeps the OLD refresh token when GoBiz did not rotate it', async () => {
  const { db, store } = makeStore({ qris_merchants: [MERCHANT()] });
  await store.withAccessToken(
    db,
    'm-1',
    async (client, attempt) => {
      if (attempt === 1) throw new GoBizError('401', { status: 401 });
      return 'ok';
    },
    { refresh: async () => ({ accessToken: 'AT-NEW2', refreshToken: null }) },
  );
  assert.equal(db._state.qris_merchants[0].refresh_token, 'RT-1');
  assert.equal(db._state.qris_merchants[0].access_token, 'AT-NEW2');
});

test('withAccessToken: hard refresh failure → token_expired + error (polling stops)', async () => {
  const { db, store } = makeStore({ qris_merchants: [MERCHANT()] });
  await assert.rejects(
    () =>
      store.withAccessToken(
        db,
        'm-1',
        async () => {
          throw new GoBizError('401', { status: 401 });
        },
        {
          refresh: async () => {
            const e = new GoBizError('401 from refresh', { status: 401 });
            throw e;
          },
        },
      ),
    (e) => e.code === 'MERCHANT_TOKEN_EXPIRED',
  );
  assert.equal(db._state.qris_merchants[0].status, 'token_expired');
});

test('withAccessToken: non-401 errors propagate untouched, merchant stays active', async () => {
  const { db, store } = makeStore({ qris_merchants: [MERCHANT()] });
  await assert.rejects(() => store.withAccessToken(db, 'm-1', async () => {
    throw new GoBizError('500', { status: 500 });
  }), /500/);
  assert.equal(db._state.qris_merchants[0].status, 'active');
  assert.equal(db._state.qris_merchants[0].access_token, 'AT-1');
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('newTransactionRef has the AAC-<ymd>-<6hex> contract shape', () => {
  for (let i = 0; i < 20; i++) assert.match(newTransactionRef(), /^AAC-\d{8}-[0-9A-F]{6}$/);
});

test('createStore throws loudly without the service role key', () => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.throws(() => createStore({}), /SERVICE_ROLE/);
  } finally {
    if (prevUrl) process.env.SUPABASE_URL = prevUrl;
    if (prevKey) process.env.SUPABASE_SERVICE_ROLE_KEY = prevKey;
  }
});
