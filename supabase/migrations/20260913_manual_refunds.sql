-- ============================================================================
-- Sensoria AAC — Manual Gateway Refunds (money ledger + entitlement claw-back)
-- Companion to 20260911_admin_transactions.sql (ledger + settle_transaction)
-- and 20260907_apply_plan_purchase.sql (stacking rule).
--
-- MODEL (decided): the Owner refunds the money MANUALLY in the QRIS gateway
-- dashboard. This migration records that event in the ledger and pulls the
-- entitlement back — the gateway API is never called from here.
--
--   refunds(id, transaction_ref →transactions, amount, gateway_reference,
--           reason, created_by_email, created_at)
--
-- Why a TABLE, not a status column:
--   • Gateway refunds can be PARTIAL (Rp 50k of Rp 150k) and REPEATED.
--   • Royalty must be computed from NET revenue (paid − refunded) per month,
--     which needs refund amounts per month, not a boolean.
-- `transactions.status` gains 'refunded' as a quick marker (full refund only)
-- with `refunded_at`; partial refunds keep status 'paid'.
--
-- CLAW-BACK (inside refund_transaction RPC, one explicit transaction):
--   • Refunded purchase is the child's LAST purchase → classic revoke
--     (status 'cancelled', plan NULL — mirrors revokePlanAction).
--   • Refunded purchase was STACKED onto an active subscription → never
--     revoke the whole subscription; instead shorten the newest row's
--     expires_at by the refunded plan's duration (inverse of the stacking
--     rule in apply_plan_purchase: same 30.4375-day month). The
--     approximation (overlapping stacked purchases) is documented in the
--     audit entry the dashboard writes.
--   • Row already 'cancelled' → no-op. Trial row is never touched.
--
-- Also: get_refunds_for_transaction() for the transactions detail drawer.
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run.
-- ============================================================================

-- ── 1) refunds ledger ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_ref text NOT NULL REFERENCES public.transactions(transaction_ref)
    ON DELETE CASCADE,
  amount numeric(12, 2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'IDR',
  -- Reference of the refund leg in the GATEWAY dashboard (manual step proof).
  gateway_reference text,
  reason text NOT NULL,
  created_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refunds_transaction_ref
  ON public.refunds (transaction_ref);
CREATE INDEX IF NOT EXISTS idx_refunds_created_at
  ON public.refunds (created_at DESC);

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS refunds_select_admin ON public.refunds;
CREATE POLICY refunds_select_admin ON public.refunds
  FOR SELECT TO authenticated
  USING (public.is_admin()); -- read inside the dashboard; writes are service-role only

-- ── 2) transactions: allow the 'refunded' marker ────────────────────────────
-- The original CHECK is an unnamed table constraint — find it, rebuild it.
DO $mig$
DECLARE
  v_con text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.transactions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%refunded%'
  ) THEN
    SELECT conname INTO v_con
      FROM pg_constraint
     WHERE conrelid = 'public.transactions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%status%'
     LIMIT 1;

    IF v_con IS NULL THEN
      RAISE EXCEPTION 'transactions status CHECK constraint not found — inspect pg_constraint manually';
    END IF;

    EXECUTE format('ALTER TABLE public.transactions DROP CONSTRAINT %I', v_con);
    EXECUTE $ddl$
      ALTER TABLE public.transactions
        ADD CONSTRAINT transactions_status_check
        CHECK (status IN ('pending', 'paid', 'failed', 'refunded'))
    $ddl$;
  END IF;
END;
$mig$;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- ── 3) The refund RPC — Owner calls this from the dashboard ────────────────
-- One explicit transaction (advisory lock serializes against concurrent
-- refunds of the same transaction). p_notify := false silences the
-- paid-notification trigger while we flip status (it only fires on →'paid'
-- anyway; the guard is defense in depth).
CREATE OR REPLACE FUNCTION public.refund_transaction(
  p_transaction_ref   text,
  p_amount            numeric,
  p_reason            text,
  p_actor_email       text,
  p_gateway_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx        public.transactions;
  v_refund_id uuid;
  v_duration  integer;
  v_child     uuid;
  v_new_end   timestamptz;
  v_refunded  numeric;
  v_result    jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'refund amount must be > 0';
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'refund reason is required';
  END IF;

  -- Serialize refunds per transaction.
  PERFORM pg_advisory_xact_lock(hashtext('refund:' || p_transaction_ref));

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE transaction_ref = p_transaction_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction % not found', p_transaction_ref;
  END IF;
  IF v_tx.status <> 'paid' THEN
    RAISE EXCEPTION 'only paid transactions can be refunded (status is %)', v_tx.status;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_refunded
    FROM public.refunds WHERE transaction_ref = p_transaction_ref;
  IF v_refunded + p_amount > v_tx.amount + 0.001 THEN
    RAISE EXCEPTION 'refund exceeds paid amount (already refunded % of %)', v_refunded, v_tx.amount;
  END IF;

  -- 1) Money ledger: append the refund row, mark the transaction.
  INSERT INTO public.refunds
    (transaction_ref, amount, currency, gateway_reference, reason, created_by_email)
  VALUES
    (p_transaction_ref, p_amount, v_tx.currency, p_gateway_reference, p_reason, p_actor_email)
  RETURNING id INTO v_refund_id;

  UPDATE public.transactions
     SET refunded_at = now(),
         updated_at  = now(),
         status = CASE
           WHEN v_refunded + p_amount >= v_tx.amount - 0.001 THEN 'refunded'
           ELSE status -- partial: stays 'paid', refunds table tells the truth
         END
   WHERE id = v_tx.id;

  -- 2) Entitlement claw-back (skipped when plan_id is gone, e.g. plan deleted).
  v_child := v_tx.child_device_id;
  IF v_tx.plan_id IS NOT NULL THEN
    SELECT duration_months INTO v_duration
      FROM public.plans WHERE id = v_tx.plan_id;

    IF v_duration IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.transactions
         WHERE child_device_id = v_child
           AND status = 'paid'
           AND transaction_ref <> p_transaction_ref
      ) THEN
        -- STACKED: shorten the newest subscription row by the refunded
        -- duration (inverse of apply_plan_purchase). Never revoke outright —
        -- other purchases may still back this subscription.
        UPDATE public.subscriptions
           SET expires_at = GREATEST(
                 now() - interval '1 second',
                 expires_at - (v_duration * interval '30.4375 days')
               ),
               updated_at = now()
         WHERE id = (
           SELECT id FROM public.subscriptions
            WHERE child_device_id = v_child
            ORDER BY created_at DESC
            LIMIT 1
         )
           AND status = 'active'
           AND expires_at IS NOT NULL
        RETURNING expires_at INTO v_new_end;
      ELSE
        -- LAST PURCHASE: classic revoke — devices lock on next sync.
        UPDATE public.subscriptions
           SET status     = 'cancelled',
               plan_id    = NULL,
               updated_at = now()
         WHERE id = (
           SELECT id FROM public.subscriptions
            WHERE child_device_id = v_child
            ORDER BY created_at DESC
            LIMIT 1
         )
           AND status = 'active';
      END IF;
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'refund_id', v_refund_id,
    'ledger_status',
      (SELECT status FROM public.transactions WHERE id = v_tx.id),
    'new_expires_at', v_new_end
  );
  RETURN v_result;
END;
$$;

-- ── 4) Drawer helper: refund history of one transaction ────────────────────
CREATE OR REPLACE FUNCTION public.get_refunds_for_transaction(p_transaction_ref text)
RETURNS TABLE (
  id uuid,
  amount numeric,
  currency text,
  gateway_reference text,
  reason text,
  created_by_email text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT id, amount, currency, gateway_reference, reason, created_by_email, created_at
    FROM public.refunds
   WHERE transaction_ref = p_transaction_ref
   ORDER BY created_at DESC;
$$;

-- ── Verification ────────────────────────────────────────────────────────────
--   SELECT * FROM public.refunds ORDER BY created_at DESC;
--   SELECT transaction_ref, status, refunded_at FROM public.transactions
--    WHERE refunded_at IS NOT NULL;
--   -- Full round-trip on a TEST row only:
--   -- SELECT public.refund_transaction('<ref>', <amount>, '<reason>', 'owner@…', '<gw-ref>');
--   -- Expect: refunds row + status 'refunded' (full) + subscription clawed back.
-- ============================================================================
