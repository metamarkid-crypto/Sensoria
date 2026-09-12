-- ============================================================================
-- Sensoria AAC — Reconcile `transactions` with the admin dashboard schema.
--
-- WHY THIS EXISTS:
--   A `transactions` table was created manually in the dashboard BEFORE
--   20260911_admin_transactions.sql ran, so that migration's
--   `CREATE TABLE IF NOT EXISTS` was silently skipped and the table kept an
--   older column set:
--     missing   : currency
--     legacy    : payment_method        -> payment_gateway
--                 raw_webhook_payload   -> raw_payload
--   The dashboard and settle_transaction() expect the new shape. The table is
--   empty (verified), so this reconciliation loses nothing.
--
--   Idempotent: safe to run multiple times. Run BEFORE (or after) re-running
--   20260911_admin_transactions.sql — both orders converge.
-- ============================================================================

-- 1) currency — required by the ledger CSV, analytics, and KPI cards.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'IDR';

-- 2) payment_gateway <- payment_method (carry any legacy values over once).
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS payment_gateway text NOT NULL DEFAULT 'qris';

UPDATE public.transactions
   SET payment_gateway = payment_method
 WHERE payment_method IS DISTINCT FROM NULL
   AND payment_method <> ''
   AND payment_gateway = 'qris';

ALTER TABLE public.transactions DROP COLUMN IF EXISTS payment_method;

-- 3) raw_payload <- raw_webhook_payload (raw gateway JSON for the drawer).
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS raw_payload jsonb;

UPDATE public.transactions
   SET raw_payload = raw_webhook_payload
 WHERE raw_payload IS NULL
   AND raw_webhook_payload IS DISTINCT FROM NULL;

ALTER TABLE public.transactions DROP COLUMN IF EXISTS raw_webhook_payload;

-- 4) Re-create the settlement RPC against the reconciled columns
--    (identical body to 20260911_admin_transactions.sql; CREATE OR REPLACE
--    keeps it idempotent and fixes the broken column reference).
CREATE OR REPLACE FUNCTION public.settle_transaction(
  p_transaction_ref text,
  p_raw_payload jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.transactions;
BEGIN
  SELECT * INTO v_row
    FROM public.transactions
   WHERE transaction_ref = p_transaction_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'settle_transaction: transaction % not found', p_transaction_ref;
  END IF;

  IF v_row.status <> 'pending' THEN
    RETURN false; -- already settled/failed — webhook replay is a no-op
  END IF;

  UPDATE public.transactions
     SET status = 'paid',
         paid_at = now(),
         raw_payload = coalesce(p_raw_payload, raw_payload),
         updated_at = now()
   WHERE id = v_row.id;

  PERFORM public.apply_plan_purchase(v_row.child_device_id, v_row.plan_id);
  RETURN true;
END;
$$;

-- ── Verification (optional, run pieces manually if you like) ───────────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'transactions'
--  ORDER BY ordinal_position;
--  -> must include: currency, payment_gateway, raw_payload
--    and NOT include: payment_method, raw_webhook_payload
