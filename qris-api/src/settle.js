'use strict';

/**
 * settle.js — journal → order matching and settlement.
 *
 * Port of go-merchant's worker FIFO matching + transaction.controller's
 * on-demand "instant verify" (checkTransactionStatus), unified into one
 * primitive used by BOTH:
 *   • POST /api/qris-status  → instant verify when the user taps "Saya Sudah Membayar"
 *   • src/worker.js (next build step) → the 60 s cron sweep
 *
 * Matching rules (blueprint §3.2 — ported verbatim):
 *   1. journal amounts are SEN → gobiz.getJournals already normalized to IDR
 *   2. FIFO: the OLDEST pending order wins
 *   3. exact nominal equality against qris_orders.amount (server-side, never
 *      a client value)
 *   4. time window: payment_time ∈ [order.created_at − 1 min, order.expires_at]
 *      (go-merchant used created−1 … created+5 min; we bind the upper edge to
 *      the order's own expiry so a late manual bank transfer under the same
 *      amount can never settle an order that already expired)
 *   5. one journal reference settles EXACTLY one order — enforced by the
 *      atomic guarded claimJournal UPDATE (unique matched_journal_id)
 *
 * Settlement itself is delegated to the kind-aware settle_transaction RPC
 * (migration 20260914): ledger pending→paid + apply_plan_purchase OR
 * apply_parent_slot_purchase, atomic, idempotent.
 */

const GOBIZ_JOURNAL_TIME_TOLERANCE_MS = 60 * 1000; // −1 minute on the lower edge

/** True when journal payment_time falls inside the order's payable window. */
function paymentTimeInWindow(paymentTime, order) {
  if (!paymentTime) return true; // journal carries no time — don't over-reject; the amount+claim guard still holds
  const t = new Date(paymentTime);
  if (Number.isNaN(t.getTime())) return true;
  const lower = new Date(order.created_at).getTime() - GOBIZ_JOURNAL_TIME_TOLERANCE_MS;
  const upper = new Date(order.expires_at).getTime();
  return t.getTime() >= lower && t.getTime() <= upper;
}

/**
 * Poll GoBiz journals for `merchant` and settle any of its pending orders
 * that match. Returns the number of orders settled by THIS call.
 *
 * Uses store.withAccessToken so a 401 triggers the refresh-retry with the
 * merchant's persistent device id, and a hard refresh failure flags the
 * merchant token_expired (orders keep waiting; instant-verify surfaces
 * "still pending" to the user instead of an error).
 */
async function pollAndSettle(store, merchant) {
  let mutations;
  try {
    mutations = await store.withAccessToken(store.db, merchant.id, (client) =>
      client.getJournals(merchant.merchant_id),
    );
    mutations = mutations.mutations || [];
  } catch (err) {
    // Hard token failure: the merchant needs a re-link. Polling other
    // merchants must continue — this is a per-merchant condition, not fatal.
    console.error('[settle] journals gagal untuk merchant', merchant.merchant_id, err.code || err.message);
    return 0;
  }
  return settleFromMutations(store, merchant, mutations);
}

/**
 * Match `mutations` (already normalized to IDR) against the merchant's
 * pending orders and settle the winners. Exported for tests.
 */
async function settleFromMutations(store, merchant, mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) return 0;

  const pending = await store.listPendingOrdersForMerchant(store.db, merchant.id);
  if (pending.length === 0) return 0;

  // Dedup: a journal reference can only ever settle once — claimJournal's
  // guarded UPDATE + UNIQUE(matched_journal_id) is the hard lock; this skip
  // is just to avoid re-processing journals already parked on an order.
  const claimedRefs = new Set(pending.map((o) => o.matched_journal_id).filter(Boolean));

  let settled = 0;
  for (const mutation of mutations) {
    if (!mutation || !mutation.referenceId || claimedRefs.has(mutation.referenceId)) continue;

    // FIFO: oldest pending order with the EXACT nominal first.
    const winner = pending.find(
      (o) =>
        Number(o.amount) === Number(mutation.amountIdr) &&
        paymentTimeInWindow(mutation.paymentTime, o),
    );
    if (!winner) continue;

    // ATOMIC claim — the loser of a race gets false and moves on.
    const won = await store.claimJournal(store.db, winner.id, {
      journalId: mutation.referenceId,
      amount: winner.amount,
      rawJournal: mutation.raw ?? null,
    });
    if (!won) continue;

    // Money path: ledger pending→paid + entitlement application (kind-aware,
    // idempotent RPC). If the RPC throws, the claim stands (evidence saved)
    // and the worker retries settlement on its next sweep — order stays
    // 'pending' with matched_journal_id set, so it is never double-settled.
    try {
      await store.settleOrder(store.db, winner.transaction_ref, mutation.raw ?? null);
      await store.markOrderPaid(store.db, winner.id, mutation.referenceId, mutation.paymentTime);
      settled += 1;
      console.log('[settle] PAID', winner.transaction_ref, 'amount', winner.amount);
    } catch (err) {
      console.error('[settle] settle_transaction gagal untuk', winner.transaction_ref, err.message);
    }
  }
  return settled;
}

/**
 * Instant verify for POST /api/qris-status: poll THIS order's merchant (if
 * any) and return the fresh order row. Cheap no-op when the order already
 * has a journal claim (someone settled it) — settlement itself is idempotent.
 */
async function instantVerify(store, order) {
  if (!order || order.status !== 'pending') return order;
  if (!order.merchant_db_id) return order; // no merchant linked yet — cron will attach later

  try {
    const merchant = await store.getMerchantByDbId(store.db, order.merchant_db_id);
    if (!merchant || merchant.status === 'disabled') return order;
    await pollAndSettle(store, merchant);
  } catch (err) {
    // Verification must NEVER 500 the status endpoint — a GoBiz hiccup just
    // means "we couldn't check right now", the row says what we know.
    console.error('[settle] instantVerify gagal:', err.code || err.message);
  }
  // Re-read: pollAndSettle may have settled it.
  return store.getOrderById(store.db, order.id);
}

module.exports = {
  pollAndSettle,
  settleFromMutations,
  instantVerify,
  paymentTimeInWindow,
  GOBIZ_JOURNAL_TIME_TOLERANCE_MS,
};
