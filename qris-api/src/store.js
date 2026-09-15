'use strict';

/**
 * store.js — Supabase service-role data access for the Sensoria QRIS API.
 *
 * Owns exactly two of the qris-api tables (migration 20260914_qris_api.sql):
 *
 *   qris_merchants — one row per linked GoBiz merchant account (web session):
 *                    tokens + PERSISTENT device_id + static QRIS payload.
 *   qris_orders    — payment intents: QR state + FIFO matching state. The
 *                    MONEY ledger is public.transactions; this module only
 *                    writes ledger rows at checkout (status='pending') and
 *                    settles them through the settle_transaction RPC.
 *
 * SECURITY: this module requires the SERVICE ROLE key and must only ever be
 * imported from server code (qris-api service / worker). The service role
 * bypasses RLS — the mobile app never touches these tables; it talks to the
 * HTTP endpoints and re-reads its own entitlements.
 *
 * CONCURRENCY contract (FIFO matcher, blueprint §3.2):
 *   One GoBiz journal reference settles exactly one order. The claim is a
 *   conditional UPDATE guarded on `matched_journal_id IS NULL` — under two
 *   workers racing on the same journal, exactly one UPDATE reports count=1
 *   and the loser gets count=0 and skips. Do NOT replace with
 *   select-then-update.
 */

const { createClient } = require('@supabase/supabase-js');
const { GoBizClient, isAuthError } = require('./gobiz');

const QRIS_CHECKOUT_TTL_MINUTES = parseInt(process.env.QRIS_CHECKOUT_TTL_MINUTES || '15', 10);

/** Injectable for tests — defaults to the real GoBiz SDK client. */
let goBizFactory = (opts) => new GoBizClient(opts);
/** Injectable for tests — default refresh via the SDK (same device id!). */
let defaultRefresh = async (refreshToken, deviceId) => {
  const client = goBizFactory({ deviceId });
  const out = await client.refreshToken(refreshToken);
  return { accessToken: out.accessToken, refreshToken: out.refreshToken };
};

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Build the store. Reads SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and
 * SUPABASE_SERVICE_ROLE_KEY — either from the explicit opts or the env.
 * Throws loudly at boot when the service key is missing: silently running
 * without settlement would be a money bug.
 *
 * @param {{ url?: string, serviceKey?: string, client?: object }} [opts]
 *        `client` injects a ready Supabase client (tests).
 */
function createStore(opts = {}) {
  const url = opts.url || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = opts.serviceKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('store: SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY wajib di-set (service role).');
  }
  const db =
    opts.client ||
    createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': 'sensoria-qris-api/1.0' } },
    });

  return {
    db,
    // -- merchants ----------------------------------------------------------
    getMerchantByPhone,
    getMerchantByMerchantId,
    getMerchantByDbId,
    listActiveMerchants,
    listMerchantsWithPendingOrders,
    saveOtpSession,
    linkMerchant,
    saveMerchantTokens,
    markMerchantTokenExpired,
    setMerchantStaticQris,
    touchMerchantSync,
    setMerchantStatus,
    // -- orders -------------------------------------------------------------
    createOrderWithLedger,
    getOrderByRef,
    getOrderById,
    listPendingOrdersForMerchant,
    listUnexpiredPendingOrders,
    listStalePendingOrders,
    expireOrder,
    attachQrToOrder,
    countRecentOrdersForDevice,
    // -- settlement ---------------------------------------------------------
    claimJournal,
    settleOrder,
    markOrderPaid,
    // -- checkout (routes) --------------------------------------------------
    getChildDevice,
    getPlan,
    listActivePlans,
    pickMerchantForCheckout,
    // -- session guard ------------------------------------------------------
    withAccessToken,
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Uniform Supabase error → Error with the Postgrest code attached. */
function dbErr(operation, error) {
  const e = new Error(`store.${operation}: ${error.message}`);
  e.code = error.code;
  e.details = error.details;
  e.hint = error.hint;
  return e;
}

function orderExpiresAt(now = new Date()) {
  return new Date(now.getTime() + QRIS_CHECKOUT_TTL_MINUTES * 60 * 1000).toISOString();
}

/** AAC-<yyyymmdd>-<6 hex> — THE key joining qris_orders ↔ public.transactions. */
function newTransactionRef(now = new Date()) {
  const ymd = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `AAC-${ymd}-${cryptoRandHex(3).toUpperCase()}`;
}

function cryptoRandHex(bytes) {
  // node:crypto without pulling the module into every test context — lazily.
  const { randomBytes } = require('node:crypto');
  return randomBytes(bytes).toString('hex');
}

/** Same field list as the migration, used by every merchant read. */
const MERCHANT_COLUMNS =
  'id, merchant_id, merchant_name, phone, device_id, access_token, refresh_token, token_updated_at, static_qris, static_qris_source, static_qris_set_at, status, last_sync, created_at, updated_at';

const ORDER_COLUMNS =
  'id, transaction_ref, child_device_id, plan_id, plan_kind, amount, currency, merchant_db_id, qr_string, status, matched_journal_id, raw_journal, expires_at, paid_at, created_at, updated_at';

// ---------------------------------------------------------------------------
// Merchants — session & tokens
// ---------------------------------------------------------------------------

/** The row for a phone (bare digits, e.g. '812…'), or null. */
async function getMerchantByPhone(db, phone) {
  const { data, error } = await db
    .from('qris_merchants')
    .select(MERCHANT_COLUMNS)
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw dbErr('getMerchantByPhone', error);
  return data;
}

/** The row for the GoBiz identity (users/me merchant_id), or null. */
async function getMerchantByMerchantId(db, merchantId) {
  const { data, error } = await db
    .from('qris_merchants')
    .select(MERCHANT_COLUMNS)
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (error) throw dbErr('getMerchantByMerchantId', error);
  return data;
}

async function getMerchantByDbId(db, id) {
  const { data, error } = await db.from('qris_merchants').select(MERCHANT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw dbErr('getMerchantByDbId', error);
  return data;
}

/** All merchants eligible for polling (active or token-expired-but-retryable). */
async function listActiveMerchants(db) {
  const { data, error } = await db
    .from('qris_merchants')
    .select(MERCHANT_COLUMNS)
    .in('status', ['active', 'token_expired'])
    .order('created_at', { ascending: true });
  if (error) throw dbErr('listActiveMerchants', error);
  return data || [];
}

/** SMART SELECTION: only merchants that currently hold unexpired PENDING orders. */
async function listMerchantsWithPendingOrders(db) {
  const { data, error } = await db
    .from('qris_orders')
    .select('merchant_db_id')
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .not('merchant_db_id', 'is', null);
  if (error) throw dbErr('listMerchantsWithPendingOrders', error);

  const ids = [...new Set((data || []).map((r) => r.merchant_db_id).filter(Boolean))];
  if (ids.length === 0) return [];

  const { data: merchants, error: mErr } = await db
    .from('qris_merchants')
    .select(MERCHANT_COLUMNS)
    .in('id', ids)
    .neq('status', 'disabled');
  if (mErr) throw dbErr('listMerchantsWithPendingOrders(merchants)', mErr);
  return merchants || [];
}

/**
 * Remember the FRESH device_id of an in-progress OTP link, per phone.
 *
 * "Pola asli" (blueprint §4.3): the otp_token + device_id travel to the
 * admin dashboard and MUST come back on /verify — this call only pre-warms
 * device persistence for ALREADY-LINKED rows. It deliberately does NOT touch
 * access/refresh tokens: an abandoned re-link must leave the live session
 * intact, and the CHECK constraint on qris_merchants.status has no
 * 'pending_link' state for a token-less skeleton row. For a never-linked
 * phone this is a no-op (returns null) — linkMerchant() does the first write.
 */
async function saveOtpSession(db, { phone, deviceId }) {
  const existing = await getMerchantByPhone(db, phone);
  if (!existing) return null;
  const { data, error } = await db
    .from('qris_merchants')
    .update({ device_id: deviceId, updated_at: new Date().toISOString() })
    .eq('id', existing.id)
    .select(MERCHANT_COLUMNS)
    .single();
  if (error) throw dbErr('saveOtpSession', error);
  return data;
}

/**
 * Persist a fully verified link: verifyOtp → getMe succeeded.
 * When the account already exists (same GoBiz merchant_id) we UPDATE the
 * session (tokens + PERSISTENT device_id + status) instead of inserting.
 */
async function linkMerchant(db, { merchantId, merchantName, phone, deviceId, accessToken, refreshToken }) {
  const now = new Date().toISOString();
  const existing = await getMerchantByMerchantId(db, merchantId);
  if (existing) {
    const { data, error } = await db
      .from('qris_merchants')
      .update({
        merchant_name: merchantName,
        phone,
        device_id: deviceId,
        access_token: accessToken,
        refresh_token: refreshToken,
        token_updated_at: now,
        status: 'active',
        updated_at: now,
      })
      .eq('id', existing.id)
      .select(MERCHANT_COLUMNS)
      .single();
    if (error) throw dbErr('linkMerchant(update)', error);
    return { row: data, linked: false };
  }
  const { data, error } = await db
    .from('qris_merchants')
    .insert({
      merchant_id: merchantId,
      merchant_name: merchantName,
      phone,
      device_id: deviceId,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_updated_at: now,
      status: 'active',
    })
    .select(MERCHANT_COLUMNS)
    .single();
  if (error) throw dbErr('linkMerchant(insert)', error);
  return { row: data, linked: true };
}

/** Rotate tokens after a successful refresh. Keeps the old refresh token when GoBiz did not rotate. */
async function saveMerchantTokens(db, merchantDbId, { accessToken, refreshToken }) {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('qris_merchants')
    .update({
      ...(accessToken ? { access_token: accessToken } : {}),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      token_updated_at: now,
      status: 'active',
      updated_at: now,
    })
    .eq('id', merchantDbId)
    .select(MERCHANT_COLUMNS)
    .single();
  if (error) throw dbErr('saveMerchantTokens', error);
  return data;
}

/** Refresh failed hard (401/403) — flag for the dashboard; polling stops. */
async function markMerchantTokenExpired(db, merchantDbId) {
  const { data, error } = await db
    .from('qris_merchants')
    .update({ status: 'token_expired', updated_at: new Date().toISOString() })
    .eq('id', merchantDbId)
    .select('id, status')
    .single();
  if (error) throw dbErr('markMerchantTokenExpired', error);
  return data;
}

/**
 * Validate + store the STATIC QRIS payload for a merchant.
 * `validate` is injected (emv.validateStaticQRIS) to keep this module
 * dependency-light and testable. `source` mirrors the migration's CHECK:
 * 'paste' (default) or 'image' (decoded server-side from an upload).
 * Returns the updated row.
 */
async function setMerchantStaticQris(db, merchantDbId, payload, validate, source = 'paste') {
  const verdict = validate(payload);
  if (!verdict.ok) {
    const e = new Error(verdict.reason);
    e.code = 'INVALID_QRIS';
    throw e;
  }
  const { data, error } = await db
    .from('qris_merchants')
    .update({
      static_qris: payload,
      static_qris_source: source === 'image' ? 'image' : 'paste',
      static_qris_set_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', merchantDbId)
    .select(MERCHANT_COLUMNS)
    .single();
  if (error) throw dbErr('setMerchantStaticQris', error);
  return data;
}

async function touchMerchantSync(db, merchantDbId) {
  const { error } = await db
    .from('qris_merchants')
    .update({ last_sync: new Date().toISOString() })
    .eq('id', merchantDbId);
  if (error) throw dbErr('touchMerchantSync', error);
}

async function setMerchantStatus(db, merchantDbId, status) {
  const { data, error } = await db
    .from('qris_merchants')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', merchantDbId)
    .select('id, status')
    .single();
  if (error) throw dbErr('setMerchantStatus', error);
  return data;
}

// ---------------------------------------------------------------------------
// Checkout-side lookups (routes/mobile.js)
// ---------------------------------------------------------------------------

/**
 * The devices row for a checkout request, or null. Returns id/role only —
 * the route enforces role === 'Child' (payments belong to child devices).
 */
async function getChildDevice(db, deviceId) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId)) return null;
  const { data, error } = await db
    .from('devices')
    .select('id, role')
    .eq('id', deviceId)
    .maybeSingle();
  if (error) throw dbErr('getChildDevice', error);
  return data;
}

/** The plans row — server-side pricing source. Never trust a client amount. */
async function getPlan(db, planId) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof planId !== 'string' || !UUID_RE.test(planId)) return null;
  const { data, error } = await db
    .from('plans')
    .select('id, name, kind, price, currency, is_active')
    .eq('id', planId)
    .maybeSingle();
  if (error) throw dbErr('getPlan', error);
  return data;
}

/** Active plans for diagnostics (GET /api/plans is NOT exposed publicly). */
async function listActivePlans(db) {
  const { data, error } = await db
    .from('plans')
    .select('id, name, kind, price, currency')
    .eq('is_active', true)
    .order('price', { ascending: true });
  if (error) throw dbErr('listActivePlans', error);
  return data || [];
}

/**
 * Which linked merchant should host this checkout? The first ACTIVE merchant
 * carrying a static QRIS payload (oldest first — the deliberate one-account
 * posture of blueprint §5.1). `null` → checkout is refused with NO_MERCHANT;
 * settling existing orders keeps working via withAccessToken regardless.
 */
async function pickMerchantForCheckout(db) {
  const { data, error } = await db
    .from('qris_merchants')
    .select(MERCHANT_COLUMNS)
    .eq('status', 'active')
    .not('static_qris', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw dbErr('pickMerchantForCheckout', error);
  return data;
}

// ---------------------------------------------------------------------------
// Orders — checkout lifecycle
// ---------------------------------------------------------------------------

/**
 * ATOMIC checkout: one ledger row (pending) + one order row, sharing the
 * freshly generated transaction_ref. Uses an RPC when available
 * (create_qris_order), else the two-insert fallback with ref collision retry.
 *
 * `amount` and `planKind` MUST come from the plans row server-side — this
 * function never accepts money data from a client.
 *
 * Returns the created order row.
 */
async function createOrderWithLedger(db, { childDeviceId, planId, planKind, amount, merchantDbId = null, expiresAt = null }) {
  const ref = newTransactionRef();
  const expires = expiresAt || orderExpiresAt();
  const nowIso = new Date().toISOString();

  // Preferred path: single RPC (all-or-nothing). create_qris_order ships as
  // a companion migration; when it is not installed yet we transparently
  // fall back to the two-insert path below.
  const rpc = await db.rpc('create_qris_order', {
    p_transaction_ref: ref,
    p_child_device_id: childDeviceId,
    p_plan_id: planId,
    p_plan_kind: planKind,
    p_amount: amount,
    p_merchant_db_id: merchantDbId,
    p_expires_at: expires,
  });
  if (!rpc.error) return rpc.data;
  if (rpc.error.code !== '42883' /* undefined_function — RPC not installed */) {
    throw dbErr('createOrderWithLedger(rpc)', rpc.error);
  }

  // Fallback: ledger first (it is the money record), then the order. If the
  // order insert fails the ledger row stays pending and is swept by the
  // worker's expire pass — no money state is ever lost. A ref collision
  // (23505, ~1 in 16M) simply retries with a fresh ref, bounded.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const useRef = attempt === 1 ? ref : newTransactionRef();
    const { error: tErr } = await db.from('transactions').insert({
      transaction_ref: useRef,
      child_device_id: childDeviceId,
      plan_id: planId,
      amount,
      currency: 'IDR',
      status: 'pending',
      payment_gateway: 'qris',
    });
    if (tErr) {
      if (tErr.code === '23505') continue;
      throw dbErr('createOrderWithLedger(ledger)', tErr);
    }

    const { data: order, error: oErr } = await db
      .from('qris_orders')
      .insert({
        transaction_ref: useRef,
        child_device_id: childDeviceId,
        plan_id: planId,
        plan_kind: planKind,
        amount,
        currency: 'IDR',
        merchant_db_id: merchantDbId,
        status: 'pending',
        expires_at: expires,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select(ORDER_COLUMNS)
      .single();
    if (oErr) throw dbErr('createOrderWithLedger(order)', oErr); // ledger exists — settle/expire reconciles it
    return order;
  }
  throw new Error('createOrderWithLedger: transaction_ref collision berulang (coba lagi).');
}

async function getOrderByRef(db, transactionRef) {
  const { data, error } = await db.from('qris_orders').select(ORDER_COLUMNS).eq('transaction_ref', transactionRef).maybeSingle();
  if (error) throw dbErr('getOrderByRef', error);
  return data;
}

async function getOrderById(db, orderId) {
  const { data, error } = await db.from('qris_orders').select(ORDER_COLUMNS).eq('id', orderId).maybeSingle();
  if (error) throw dbErr('getOrderById', error);
  return data;
}

/** FIFO input: pending orders of one merchant, oldest first. */
async function listPendingOrdersForMerchant(db, merchantDbId) {
  const { data, error } = await db
    .from('qris_orders')
    .select(ORDER_COLUMNS)
    .eq('merchant_db_id', merchantDbId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true });
  if (error) throw dbErr('listPendingOrdersForMerchant', error);
  return data || [];
}

/** Worker safety net: ALL unexpired pending orders (any merchant). */
async function listUnexpiredPendingOrders(db) {
  const { data, error } = await db
    .from('qris_orders')
    .select(ORDER_COLUMNS)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true });
  if (error) throw dbErr('listUnexpiredPendingOrders', error);
  return data || [];
}

/**
 * EXPIRY PASS input: pending orders whose TTL has passed — order → 'expired',
 * ledger → 'failed' (via expireOrder). Bounded per sweep (WORKER_EXPIRE_BATCH,
 * default 200) so a backlog can never make one sweep run unbounded.
 */
async function listStalePendingOrders(db, limit = 200) {
  const { data, error } = await db
    .from('qris_orders')
    .select(ORDER_COLUMNS)
    .eq('status', 'pending')
    .lte('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(limit);
  if (error) throw dbErr('listStalePendingOrders', error);
  return data || [];
}

/**
 * Expire one order: qris_orders.status → 'expired' AND the ledger row →
 * 'failed' (ledger policy only knows pending/paid/failed — blueprint §4.4).
 * The conditional .eq('status','pending') makes replays no-ops.
 */
async function expireOrder(db, orderId) {
  const nowIso = new Date().toISOString();
  // Guarded update — replays (already expired/paid) match zero rows and are
  // a no-op returning null, never an error.
  const { data, error } = await db
    .from('qris_orders')
    .update({ status: 'expired', updated_at: nowIso })
    .eq('id', orderId)
    .eq('status', 'pending')
    .select('id, transaction_ref')
    .maybeSingle();
  if (error) throw dbErr('expireOrder', error);
  if (!data) return null;

  await db
    .from('transactions')
    .update({ status: 'failed', updated_at: nowIso })
    .eq('transaction_ref', data.transaction_ref)
    .eq('status', 'pending');
  return data;
}

async function attachQrToOrder(db, orderId, qrString, merchantDbId) {
  const { data, error } = await db
    .from('qris_orders')
    .update({ qr_string: qrString, merchant_db_id: merchantDbId, updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .select('id, qr_string')
    .single();
  if (error) throw dbErr('attachQrToOrder', error);
  return data;
}

/** Simple per-device rate signal for the checkout endpoint. */
async function countRecentOrdersForDevice(db, childDeviceId, sinceMs = 10 * 60 * 1000) {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const { count, error } = await db
    .from('qris_orders')
    .select('id', { count: 'exact', head: true })
    .eq('child_device_id', childDeviceId)
    .gte('created_at', since);
  if (error) throw dbErr('countRecentOrdersForDevice', error);
  return count || 0;
}

// ---------------------------------------------------------------------------
// Settlement — FIFO claim + settle_transaction
// ---------------------------------------------------------------------------

/**
 * Run `fn` with a GoBiz client bound to the merchant's CURRENT access token,
 * implementing the blueprint §3.4 pattern:
 *
 *   try → 401 → refreshToken (SAME persistent device id) → save → retry ONCE
 *
 * `refresh` is injected (default: gobiz.GoBizClient.refreshToken) so tests and
 * callers can reuse it; a null refreshToken or a failed refresh throws
 * MERCHANT_TOKEN_EXPIRED after flagging the merchant token_expired — the
 * worker then skips this merchant until an admin re-links.
 */
async function withAccessToken(db, merchantDbId, fn, { refresh = defaultRefresh } = {}) {
  const merchant = await getMerchantByDbId(db, merchantDbId);
  if (!merchant) {
    const e = new Error(`withAccessToken: merchant ${merchantDbId} tidak ditemukan.`);
    e.code = 'MERCHANT_NOT_FOUND';
    throw e;
  }
  const client = goBizFactory({ deviceId: merchant.device_id, accessToken: merchant.access_token });

  try {
    return await fn(client, 1);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    if (!merchant.refresh_token) {
      await markMerchantTokenExpired(db, merchantDbId);
      const e = new Error(`Merchant ${merchant.merchant_id} kehilangan refresh token — perlu link ulang.`);
      e.code = 'MERCHANT_TOKEN_EXPIRED';
      throw e;
    }
    try {
      const { accessToken, refreshToken } = await refresh(merchant.refresh_token, merchant.device_id);
      await saveMerchantTokens(db, merchantDbId, { accessToken, refreshToken });
      client.setAccessToken(accessToken);
      return await fn(client, 2); // the one and only retry
    } catch (refreshErr) {
      await markMerchantTokenExpired(db, merchantDbId);
      const e = new Error(
        `Refresh token merchant ${merchant.merchant_id} gagal: ${refreshErr.message} — perlu link ulang.`,
      );
      e.code = 'MERCHANT_TOKEN_EXPIRED';
      e.cause = refreshErr;
      throw e;
    }
  }
}
/**
 * Claim a journal reference for one order. ATOMIC under concurrency:
 *   • .is('matched_journal_id', null) — not already settled by another order
 *   • .eq('status', 'pending')        — still payable
 *   • .eq('id', orderId)              — the intended FIFO winner
 * Returns true when THIS call won the journal (count === 1).
 *
 * `amount` is re-checked in the WHERE on purpose: nominal must equal at claim
 * time, not only at candidate-selection time (cheap defence against a stale
 * order being mutated between select and claim). The journal JSON is stored
 * alongside the lock so admin support sees the evidence even if the RPC
 * settlement below fails and must be retried.
 */
async function claimJournal(db, orderId, { journalId, amount, rawJournal = null }) {
  const nowIso = new Date().toISOString();
  // maybeSingle: zero matched rows → data null (the "lost the race" outcome),
  // never an exception.
  const { data, error } = await db
    .from('qris_orders')
    .update({ matched_journal_id: journalId, raw_journal: rawJournal, updated_at: nowIso })
    .eq('id', orderId)
    .eq('status', 'pending')
    .eq('amount', amount)
    .is('matched_journal_id', null)
    .select('id, transaction_ref')
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return false; // defensive; maybeSingle already maps this
    if (error.code === '23505') return false; // UNIQUE(matched_journal_id): another order already owns this journal
    throw dbErr('claimJournal', error);
  }
  return Boolean(data);
}

/**
 * Settle a claimed order through the kind-aware RPC (migration 20260914):
 * ledger pending→paid + apply_plan_purchase OR apply_parent_slot_purchase.
 * Idempotent — replays return false without touching anything.
 * `rawJournal` is stored on the ledger row for admin inspection.
 */
async function settleOrder(db, transactionRef, rawJournal) {
  const { data, error } = await db.rpc('settle_transaction', {
    p_transaction_ref: transactionRef,
    p_raw_payload: rawJournal ?? null,
  });
  if (error) throw dbErr('settleOrder', error);
  return Boolean(data);
}

/**
 * Mirror the ledger's paid state onto qris_orders after a successful
 * settle_transaction: status='paid' + paid_at, guarded on the journal claim
 * so two racers can't both "finish" the order. The guarded .eq('status',
 * 'pending') makes replays no-ops.
 */
async function markOrderPaid(db, orderId, journalId, paidAt = new Date()) {
  const nowIso = paidAt instanceof Date ? paidAt.toISOString() : String(paidAt);
  const { data, error } = await db
    .from('qris_orders')
    .update({ status: 'paid', paid_at: nowIso, updated_at: nowIso })
    .eq('id', orderId)
    .eq('status', 'pending')
    .eq('matched_journal_id', journalId)
    .select('id, transaction_ref, status, paid_at')
    .maybeSingle();
  if (error) throw dbErr('markOrderPaid', error);
  return data;
}

module.exports = {
  createStore,
  // test seams
  _setGoBizFactory: (fn) => {
    goBizFactory = fn;
  },
  _setDefaultRefresh: (fn) => {
    defaultRefresh = fn;
  },
  // exposed for tests / ad-hoc tooling
  newTransactionRef,
  orderExpiresAt,
  QRIS_CHECKOUT_TTL_MINUTES,
};
