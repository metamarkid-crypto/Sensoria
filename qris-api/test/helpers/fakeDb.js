'use strict';

/**
 * helpers/fakeDb.js — shared in-memory PostgREST-ish Supabase fake for tests.
 *
 * Implements exactly the query-builder surface the store/routes/worker use:
 *   select/insert/update, eq/neq/gt/gte/lte/in/is/not, order/limit,
 *   single/maybeSingle, head+count, awaited builders (list queries),
 *   and the RPCs create_qris_order + settle_transaction (kind-aware flip).
 *
 * Money-critical semantics mirrored from real PostgREST/Postgres:
 *   • guarded UPDATE + .single() → PGRST116 when 0 rows matched
 *   • .maybeSingle() → one object or null, never an exception
 *   • bare awaited builder → LIST query (data is an array)
 *   • UNIQUE(transaction_ref) on transactions and UNIQUE(matched_journal_id)
 *     on qris_orders → 23505 on duplicates (the journal-claim hard lock)
 */

const crypto = require('node:crypto');

/** Minimal deep clone so updates never alias test fixtures. */
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function makeFakeDb(seed = {}) {
  const state = {
    devices: [],
    plans: [],
    qris_merchants: [],
    qris_orders: [],
    transactions: [],
    ...(seed || {}),
  };

  let table;
  let q;

  /** Build one chained query against one table. */
  function query() {
    q = {
      _filters: [],
      _select: '*',
      _single: false,
      _maybe: false,
      _count: null,
      _head: false,
      _payload: null,
      _order: null,
      _limit: null,
      _mode: 'select',

      select(cols, opts = {}) {
        q._select = cols;
        if (opts && opts.count) q._count = opts.count;
        if (opts && opts.head) q._head = true;
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
      delete() {
        q._mode = 'delete';
        return q;
      },
      eq(col, val) { q._filters.push(['eq', col, val]); return q; },
      neq(col, val) { q._filters.push(['neq', col, val]); return q; },
      gt(col, val) { q._filters.push(['gt', col, val]); return q; },
      gte(col, val) { q._filters.push(['gte', col, val]); return q; },
      lte(col, val) { q._filters.push(['lte', col, val]); return q; },
      in(col, vals) { q._filters.push(['in', col, vals]); return q; },
      is(col, val) { q._filters.push(['is', col, val]); return q; },
      not(col, _op, val) { q._filters.push(['not', col, val]); return q; },
      order(col, opts = {}) {
        q._order = { col, ascending: opts.ascending !== false };
        return q;
      },
      limit(n) { q._limit = n; return q; },
      range() { return q; },
      single() { q._single = true; return q; },
      maybeSingle() { q._maybe = true; return q; },
      count(fn) { q._countFn = fn; return q; },

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
          case 'lte':
            return rv != null && rv <= val;
          case 'in':
            return val.map(String).includes(String(rv));
          case 'is':
            return val === null ? rv === null || rv === undefined : rv === val;
          case 'not':
            // .not('col', 'is', null) → col IS NOT NULL is the only store use.
            return !(rv === null || rv === undefined);
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
        // UNIQUE(matched_journal_id) emulation: claiming a journal another
        // order already holds is a 23505, never a success.
        if (
          table === 'qris_orders' &&
          q._payload.matched_journal_id != null &&
          rows.some((o) => o.matched_journal_id === q._payload.matched_journal_id && o.id !== row.id)
        ) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "qris_orders_matched_journal_id_key"' } };
        }
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
      // UNIQUE simulation: transaction_ref on transactions/qris_orders (the
      // collision-retry path in createOrderWithLedger).
      for (const inc of incoming) {
        if (
          (table === 'transactions' || table === 'qris_orders') &&
          state[table].some((r) => r.transaction_ref === inc.transaction_ref)
        ) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
      }
      const created = incoming.map((p) => ({
        id: p.id ?? `uuid-${Math.random().toString(16).slice(2, 10)}`,
        created_at: p.created_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...clone(p),
      }));
      state[table].push(...created);
      return { data: q._single ? clone(created[0]) : clone(created), error: null };
    }

    // SELECT
    let out = rows.filter(matches);
    if (q._order) {
      out = [...out].sort(
        (a, b) => (a[q._order.col] > b[q._order.col] ? 1 : a[q._order.col] < b[q._order.col] ? -1 : 0) * (q._order.ascending ? 1 : -1),
      );
    }
    if (q._limit != null) out = out.slice(0, q._limit);
    const mapped = out.map((r) => {
      if (q._select === '*' || !q._select) return clone(r);
      const cols = String(q._select).split(',').map((s) => s.trim());
      const picked = {};
      for (const c of cols) picked[c] = r[c];
      return picked;
    });
    if (q._head) return { data: null, error: null, count: mapped.length };
    if (q._single) return { data: mapped[0] ?? null, error: mapped.length ? null : { code: 'PGRST116', message: 'no rows' } };
    if (q._maybe) return { data: mapped[0] ?? null, error: null };
    return { data: clone(mapped), error: null, count: mapped.length };
  }

  const api = {
    from(t) {
      table = t;
      q = query();
      return q;
    },
    async rpc(fn, params) {
      state.rpcLog = state.rpcLog || [];
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
          id: crypto.randomUUID(), // real format — routes validate UUID shape
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

  api._state = state;
  return api;
}

module.exports = { makeFakeDb, clone };
