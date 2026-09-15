-- ============================================================================
-- QRIS API — merchant registry + payment intents + kind-aware settlement
-- Companion to /qris-api (Express service deployed at app.aacsensoria.id).
--
-- RUN ORDER: after 20260913_parent_slot_packs.sql (references its RPC) and
-- after 20260911_admin_transactions.sql (replaces its settle_transaction).
-- Idempotent: safe to run again.
--
-- SECURITY MODEL (same doctrine as 20260911):
--   • Only the qris-api service touches these tables, via the SERVICE ROLE
--     key (bypasses RLS entirely). The mobile app NEVER reads them directly —
--     it talks to /api/qris-checkout and re-reads `subscriptions`.
--   • RLS is enabled anyway (defence in depth): admin dashboard sessions may
--     SELECT rows via is_admin(); anon/authenticated writes are denied.
--   • GoBiz tokens and the static QRIS payload live ONLY in qris_merchants —
--     never surfaced to clients by any policy.
--
-- WHY settle_transaction v2 (kind-aware): v1 always called
-- apply_plan_purchase — correct for combo plans, WRONG for slot packs
-- (kind='slots', one-time +1 parent slot): it would add subscription months
-- instead of capacity. v2 routes by plans.kind:
--     kind = 'slots' → public.apply_parent_slot_purchase(child, plan)
--     otherwise      → public.apply_plan_purchase(child, plan)
-- The RPC stays atomic on purpose: if entitlement application throws (e.g.
-- plan deactivated mid-flight), the whole settlement rolls back and the
-- worker retries on its next cycle — money is never "settled" silently
-- without the user receiving what they paid for.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) qris_merchants — one row per linked GoBiz merchant account (web session)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qris_merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- merchant_id returned by GET /v1/users/me — the real GoBiz identity.
  merchant_id   text NOT NULL UNIQUE,
  merchant_name text NOT NULL,
  phone         text,
  -- Persistent device uniqueid used for BOTH login and token refresh.
  -- go-merchant lesson: refresh with a different device_id gets rejected —
  -- never rotate this after linking.
  device_id     text NOT NULL,
  access_token  text,
  refresh_token text,
  token_updated_at timestamptz,
  -- Static QRIS payload (EMVCo string). Filled from the admin dashboard by
  -- pasting the string or uploading the official QR image (decoded
  -- server-side). MUST be a static payload (tag 01 = '11') — enforced in the
  -- API layer before write.
  static_qris   text,
  static_qris_source text CHECK (static_qris_source IN ('paste', 'image')),
  static_qris_set_at timestamptz,
  -- active = healthy; token_expired = refresh failed, needs re-link;
  -- disabled = manually turned off by an admin.
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'token_expired', 'disabled')),
  last_sync     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qris_merchants_status
  ON public.qris_merchants (status);

-- ---------------------------------------------------------------------------
-- 2) qris_orders — payment intents created by /api/qris-checkout.
--    Money ledger remains public.transactions (created in the same request);
--    this table carries the QR + matching state the ledger must not hold.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qris_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Our reference (AAC-<yyyymmdd>-<hex>) — THE key into public.transactions
  -- (transactions.transaction_ref UNIQUE).
  transaction_ref text NOT NULL UNIQUE,
  child_device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  plan_id  uuid NOT NULL REFERENCES public.plans(id),
  -- Snapshot of plans.kind at checkout time (diagnostic; routing uses the
  -- live plans row at settle time).
  plan_kind text NOT NULL,
  -- Amount copied from plans.price at checkout. NEVER accepted from the
  -- client — the FIFO matcher compares journals against THIS value.
  amount   numeric(12, 2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'IDR',
  -- Merchant account the dynamic QR was generated from (null until the
  -- first merchant is linked).
  merchant_db_id uuid REFERENCES public.qris_merchants(id) ON DELETE SET NULL,
  qr_string text,
  status    text NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'paid', 'expired', 'failed')),
  -- FIFO lock: one GoBiz journal entry settles exactly one order.
  matched_journal_id text UNIQUE,
  raw_journal jsonb,
  expires_at  timestamptz NOT NULL,
  paid_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Worker hot path: "all pending orders not yet expired".
CREATE INDEX IF NOT EXISTS idx_qris_orders_pending
  ON public.qris_orders (status, expires_at);
-- Smart selection: "merchants having pending orders".
CREATE INDEX IF NOT EXISTS idx_qris_orders_merchant_status
  ON public.qris_orders (merchant_db_id, status);

-- ---------------------------------------------------------------------------
-- 3) RLS — service role bypasses these; they exist to keep any other client
--    out, and to let authenticated admin sessions read state for support.
-- ---------------------------------------------------------------------------
ALTER TABLE public.qris_merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qris_orders   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS qris_merchants_select_admin ON public.qris_merchants;
CREATE POLICY qris_merchants_select_admin ON public.qris_merchants
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS qris_orders_select_admin ON public.qris_orders;
CREATE POLICY qris_orders_select_admin ON public.qris_orders
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ---------------------------------------------------------------------------
-- 4) settle_transaction v2 — kind-aware entitlement application.
--    Signature and boolean contract unchanged (webhook replays stay no-ops).
-- ---------------------------------------------------------------------------
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
  v_row  public.transactions;
  v_kind public.plans.kind%TYPE;
BEGIN
  SELECT * INTO v_row
    FROM public.transactions
   WHERE transaction_ref = p_transaction_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'settle_transaction: transaction % not found', p_transaction_ref;
  END IF;

  IF v_row.status <> 'pending' THEN
    RETURN false; -- already settled/failed — replay is a no-op
  END IF;

  UPDATE public.transactions
     SET status = 'paid',
         paid_at = now(),
         raw_payload = coalesce(p_raw_payload, raw_payload),
         updated_at = now()
   WHERE id = v_row.id;

  -- KIND-AWARE ROUTING (the reason for this v2):
  --   slots  → one-time parent-slot capacity (+N), never touches dates
  --   combo  → subscription stacking (original behaviour, byte-identical)
  SELECT kind INTO v_kind
    FROM public.plans
   WHERE id = v_row.plan_id;

  IF v_kind = 'slots' THEN
    PERFORM public.apply_parent_slot_purchase(v_row.child_device_id, v_row.plan_id);
  ELSE
    PERFORM public.apply_plan_purchase(v_row.child_device_id, v_row.plan_id);
  END IF;

  RETURN true;
END;
$$;
