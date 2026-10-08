'use strict';

/**
 * providers.js — multi-provider payment gateway layer (Indonesia + Malaysia).
 *
 * One fulfilment contract, many providers:
 *
 *   qris-gobiz   region ID + MY  currency IDR  → dynamic QRIS rendered IN
 *                 the browser page; settlement via GoBiz journal polling
 *                 (existing settle.js machinery — worker + instantVerify).
 *                 MALAYSIA PAYES THROUGH THE SAME QRIS RAIL: QRIS is now
 *                 interoperable cross-border (QRIS Global), so a Malaysian
 *                 bank/e-wallet app (DuitNow) scans the same dynamic QR and
 *                 converts IDR→MYR on the payer's side. The merchant ledger
 *                 stays IDR — no MYR plans, no second gateway.
 *   toyyibpay    DORMANT — kept for rollback only. It was the MY gateway
 *                 (FPX / card / DuitNow QR via toyyibPay) before QRIS went
 *                 global. Not listed as any region's default anymore; it
 *                 still works when a request explicitly passes
 *                 provider=toyyibpay, and its webhook stays registered.
 *
 * Invariants carried over from the QRIS-only build (blueprint §4.5):
 *   • The AMOUNT never comes from the client — resolved from plans.price.
 *   • The device must exist and be a Child device; the plan must be active.
 *   • Ledger rows are created pending and only settle_transaction() (kind-aware,
 *     idempotent RPC) flips them to paid — identical fulfilment for both
 *     providers, so entitlements behave the same in both countries.
 *
 * Currency discipline: BOTH regions list IDR plans (QRIS global converts on
 * the payer's side). A plan's currency selects the provider — a plan row can
 * never be paid through a provider whose currency mismatches the plan (web.js
 * guards this), so an MYR plan can never produce a mislabeled IDR QR.
 */

const { staticToDynamic } = require('./emv');
const toyyibpay = require('./toyyibpay');

/** Human-readable provider + region labels for the checkout page. */
const PROVIDERS = {
  'qris-gobiz': { id: 'qris-gobiz', region: 'ID', currency: 'IDR', label: 'QRIS' },
  // DORMANT: rollback path only — no region defaults to this anymore.
  toyyibpay: { id: 'toyyibpay', region: 'MY', currency: 'MYR', label: 'DuitNow QR / FPX / Card' },
};

const DEFAULT_ID_PROVIDER = 'qris-gobiz';
const DEFAULT_MY_PROVIDER = 'qris-gobiz'; // QRIS global — same rail as ID.

/** Resolve which provider a (region, providerHint) pair maps to. */
function resolveProvider(region, providerHint) {
  if (providerHint && PROVIDERS[providerHint]) return PROVIDERS[providerHint];
  if (region === 'MY') return PROVIDERS[DEFAULT_MY_PROVIDER];
  return PROVIDERS[DEFAULT_ID_PROVIDER];
}

/** ISO 4217 numeric codes (EMV tag 53 for the dynamic QRIS). */
const CURRENCY_NUMERIC = { IDR: '360', MYR: '458' };

/**
 * Find the active plan for a (duration, currency) pair. Fallback for IDR
 * only — the legacy currency-agnostic read (all IDR rows).
 */
async function findPlanForCurrency(db, durationMonths, currency) {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const { data, error } = await db
    .from('plans')
    .select('id, name, kind, price, currency, is_active, duration_months')
    .eq('is_active', true)
    .eq('duration_months', durationMonths)
    .eq('currency', currency)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`providers.findPlanForCurrency: ${error.message}`);
  if (data) return data;
  if (currency === 'IDR') {
    // Legacy DBs seed combo plans without an explicit currency column value —
    // those rows read back as currency='IDR' anyway (column default), so this
    // second query is only a safety net for NULL-edged data.
    const legacy = await db
      .from('plans')
      .select('id, name, kind, price, currency, is_active, duration_months')
      .eq('is_active', true)
      .eq('duration_months', durationMonths)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (legacy.error) throw new Error(`providers.findPlanForCurrency(legacy): ${legacy.error.message}`);
    return legacy.data || null;
  }
  return null;
}

/** All active plans for a currency, cheapest first (checkout page list). */
async function listPlansForCurrency(db, currency) {
  const { data, error } = await db
    .from('plans')
    .select('id, name, description, kind, price, currency, duration_months')
    .eq('is_active', true)
    .eq('kind', 'combo')
    .eq('currency', currency)
    .order('price', { ascending: true });
  if (error) throw new Error(`providers.listPlansForCurrency: ${error.message}`);
  if (data && data.length > 0) return data;
  if (currency === 'IDR') {
    const legacy = await db
      .from('plans')
      .select('id, name, description, kind, price, currency, duration_months')
      .eq('is_active', true)
      .eq('kind', 'combo')
      .order('price', { ascending: true });
    if (legacy.error) throw new Error(`providers.listPlansForCurrency(legacy): ${legacy.error.message}`);
    return legacy.data || [];
  }
  return [];
}

/**
 * Create a payment intent for the given provider.
 *
 * Common path: device + plan resolved SERVER-SIDE, ledger + qris_orders row
 * created pending via store.createOrderWithLedger (shared table, currency
 * carried on both rows).
 *
 * Provider-specific:
 *   • qris-gobiz → dynamic QR string attached to the order (store.attachQrToOrder).
 *   • toyyibpay (dormant) → bill created at the gateway; billCode stored in
 *                  matched_journal_id is NOT used (that is the QRIS FIFO lock);
 *                  instead the provider ref rides raw_journal alongside the
 *                  pay URL — no schema change needed.
 */
async function createOrderForProvider(store, db, { provider, device, plan, expiresAt }) {
  const amount = Number(plan.price);
  if (!Number.isFinite(amount) || amount <= 0) {
    const e = new Error('PLAN_PRICE_INVALID');
    e.status = 500;
    throw e;
  }

  if (provider.id === 'qris-gobiz') {
    const merchant = await store.pickMerchantForCheckout(db);
    if (!merchant || !merchant.static_qris) {
      const e = new Error('NO_MERCHANT');
      e.status = 503;
      e.message = 'Sistem pembayaran sedang tidak tersedia. Coba lagi nanti.';
      throw e;
    }
    let qrString;
    try {
      qrString = staticToDynamic(merchant.static_qris, Math.round(amount));
    } catch (err) {
      const e = new Error('MERCHANT_QRIS_INVALID');
      e.status = 503;
      e.message = 'Sistem pembayaran sedang tidak tersedia. Coba lagi nanti.';
      throw e;
    }
    const order = await store.createOrderWithLedger(db, {
      childDeviceId: device.id,
      planId: plan.id,
      planKind: plan.kind || 'combo',
      amount,
      merchantDbId: merchant.id,
      expiresAt,
      currency: plan.currency || 'IDR',
    });
    await store.attachQrToOrder(db, order.id, qrString, merchant.id);
    return { order, qrString, payUrl: null };
  }

  if (provider.id === 'toyyibpay') {
    const secretKey = process.env.TOYYIBPAY_SECRET_KEY;
    const categoryCode = process.env.TOYYIBPAY_CATEGORY_CODE;
    if (!secretKey || !categoryCode) {
      const e = new Error('TOYYIBPAY_NOT_CONFIGURED');
      e.status = 503;
      e.message = 'Sistem pembayaran sedang tidak tersedia. Coba lagi nanti.';
      throw e;
    }
    const order = await store.createOrderWithLedger(db, {
      childDeviceId: device.id,
      planId: plan.id,
      planKind: plan.kind || 'combo',
      amount,
      merchantDbId: null,
      expiresAt,
      currency: plan.currency || 'IDR',
    });
    const callbackBase = process.env.PAY_WEBHOOK_BASE_URL || '';
    const pageBase = process.env.PAY_PAGE_BASE_URL || '';
    const amountCents = Math.round(amount * 100); // RM → sen
    const bill = await toyyibpay.createBill({
      secretKey,
      categoryCode,
      amountCents,
      externalRef: order.transaction_ref,
      billName: `Sensoria ${plan.name}`.slice(0, 30),
      description: `Sensoria AAC ${plan.duration_months} month plan`,
      payerName: 'Sensoria Parent',
      payerEmail: 'parent@aacsensoria.id',
      payerPhone: '0123456789',
      returnUrl: pageBase ? `${pageBase}/pay/${order.transaction_ref}` : undefined,
      callbackUrl: callbackBase ? `${callbackBase}/api/webhook/toyyibpay` : undefined,
      expiresAt: new Date(expiresAt),
      duitNow: process.env.TOYYIBPAY_DUITNOW !== '0',
    });
    // Bill lifecycle must not outlive the order TTL (worker expires the order
    // at expires_at; the bill goes inactive 1 minute earlier).
    const providerRef = {
      provider: 'toyyibpay',
      billCode: bill.billCode,
      payUrl: bill.payUrl,
    };
    await store.attachProviderRefToOrder(db, order.id, providerRef);
    // Mirror the ref onto the in-memory row — callers read order.raw_journal
    // right after this to hand off to the gateway.
    return { order: { ...order, raw_journal: providerRef }, qrString: null, payUrl: bill.payUrl };
  }

  const e = new Error('UNKNOWN_PROVIDER');
  e.status = 400;
  throw e;
}

/**
 * MY settlement: a toyyibPay callback (or poll) proved a bill PAID.
 * Mirrors settle.js's claim-then-settle discipline WITHOUT a journal id:
 *   1. guarded claim — .eq(status,'pending'), .is(matched_journal_id,null)
 *      sets matched_journal_id = 'toyyibpay:<billCode>' (UNIQUE column doubles
 *      as a one-time lock so a double callback can never settle twice).
 *   2. settle_transaction RPC (idempotent, kind-aware).
 *   3. markOrderPaid mirror.
 * Returns 'settled' | 'already' | 'race' | 'not-found'.
 */
async function settleToyyibPayOrder(store, db, { transactionRef, billCode, rawPayload }) {
  const nowIso = new Date().toISOString();
  const journalId = `toyyibpay:${billCode || transactionRef}`;

  const existing = await store.getOrderByRef(db, transactionRef);
  if (!existing) return 'not-found';
  if (existing.status !== 'pending') return 'already';

  // Merge the payment evidence INTO the stored provider ref so the billCode
  // (needed for reconciliation/polling) is never lost when the claim lands.
  const mergedRef = {
    ...(existing.raw_journal && typeof existing.raw_journal === 'object' ? existing.raw_journal : {}),
    ...(rawPayload && typeof rawPayload === 'object' ? rawPayload : {}),
    provider: 'toyyibpay',
  };

  // Guarded claim (same shape as store.claimJournal but by ref + journal id).
  const { data: claimed, error: claimErr } = await db
    .from('qris_orders')
    .update({ matched_journal_id: journalId, raw_journal: mergedRef, updated_at: nowIso })
    .eq('transaction_ref', transactionRef)
    .eq('status', 'pending')
    .is('matched_journal_id', null)
    .select('id')
    .maybeSingle();
  if (claimErr) {
    if (claimErr.code === '23505') return 'race'; // another callback owns the bill
    throw new Error(`settleToyyibPayOrder(claim): ${claimErr.message}`);
  }
  if (!claimed) return 'race';

  try {
    await store.settleOrder(db, transactionRef, rawPayload ?? null);
  } catch (err) {
    // Claim stands (evidence saved); the worker's reconcile pass retries the
    // idempotent RPC — identical to the QRIS path's failure posture.
    console.error('[providers] settle_transaction gagal untuk', transactionRef, err.message);
    return 'pending-retry';
  }
  await store.markOrderPaid(db, existing.id, journalId, new Date());
  console.log('[providers] PAID(toyyibpay)', transactionRef, 'bill', billCode);
  return 'settled';
}

/**
 * Poll one toyyibPay bill and settle when paid. Used by (a) the worker for
 * unexpired pending MY orders and (b) an on-demand status check.
 * Never throws for gateway hiccups — returns 'error' and logs.
 */
async function pollToyyibPayOrder(store, db, order, { log = console } = {}) {
  const ref = order.raw_journal && order.raw_journal.provider === 'toyyibpay' ? order.raw_journal : null;
  if (!ref || !ref.billCode) return 'no-ref';
  const secretKey = process.env.TOYYIBPAY_SECRET_KEY;
  if (!secretKey) return 'no-config';
  try {
    const txs = await toyyibpay.getBillTransactions({ secretKey, billCode: ref.billCode });
    const paid = toyyibpay.findPaidTransaction(txs);
    if (!paid) return 'unpaid';
    const outcome = await settleToyyibPayOrder(store, db, {
      transactionRef: order.transaction_ref,
      billCode: ref.billCode,
      rawPayload: { provider: 'toyyibpay', poll: paid },
    });
    return outcome === 'pending-retry' ? 'pending-retry' : outcome;
  } catch (err) {
    log.error('[providers] pollToyyibPayOrder gagal untuk', order.transaction_ref, err.message);
    return 'error';
  }
}

module.exports = {
  PROVIDERS,
  CURRENCY_NUMERIC,
  resolveProvider,
  findPlanForCurrency,
  listPlansForCurrency,
  createOrderForProvider,
  settleToyyibPayOrder,
  pollToyyibPayOrder,
};
