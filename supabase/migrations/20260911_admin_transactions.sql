-- ============================================================================
-- Sensoria AAC — Transactions Ledger + Admin Access (Web Admin Dashboard)
-- Companion to the Next.js admin dashboard under /admin.
--
-- SECURITY MODEL (deliberate, read this before "fixing"):
--   • The MOBILE app runs on the anon key with NO RLS on the existing tables
--     (documented in 20260904_subscription_architecture.sql). Enabling RLS on
--     those tables now would break the app in production. This migration
--     therefore leaves them untouched.
--   • The ADMIN dashboard NEVER touches existing tables with the anon key:
--     it reads/writes them through the SERVICE ROLE key, used strictly inside
--     server-side Next.js routes behind Supabase Auth + an admin allowlist.
--   • The NEW tables below get real RLS, guarded by is_admin() — membership
--     is managed by inserting emails into admin_users (service role only).
--
-- TRANSACTION LIFECYCLE: the QRIS gateway creates a row with status 'pending'
-- (transaction_ref = the gateway reference). On the webhook callback:
--   1) mark the row 'paid' (or 'failed'),
--   2) call public.apply_plan_purchase(child_device_id, plan_id) — the same
--      stacking rule the client previews — exactly once, only on the
--      pending → paid transition.
-- ============================================================================

-- 1) transactions — immutable money ledger (append + status transitions)
CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Gateway reference (QRIS invoice id) — idempotency key for webhooks.
  transaction_ref text NOT NULL UNIQUE,
  child_device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES public.plans(id) ON DELETE SET NULL,
  amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL DEFAULT 'IDR',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed')),
  -- e.g. 'qris' — which gateway produced the reference.
  payment_gateway text NOT NULL DEFAULT 'qris',
  -- Raw webhook JSON — inspectable in the admin detail drawer.
  raw_payload jsonb,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_child_device_id
  ON public.transactions (child_device_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status_created
  ON public.transactions (status, created_at DESC);

-- 2) admin_users — email allowlist for the dashboard (service-role managed)
CREATE TABLE IF NOT EXISTS public.admin_users (
  email text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3) is_admin() — SECURITY DEFINER so RLS policies can read the allowlist
--    without granting admins table-wide SELECT on it.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE lower(email) = lower(coalesce(current_setting('request.jwt.claim.email', true), ''))
  );
$$;

-- 4) RLS on the NEW tables only.
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Idempotent policy creation (DROP guards keep this migration re-runnable).
DROP POLICY IF EXISTS transactions_insert_anon ON public.transactions;
CREATE POLICY transactions_insert_anon ON public.transactions
  FOR INSERT TO anon
  WITH CHECK (status = 'pending'); -- gateway checkout creation only

DROP POLICY IF EXISTS transactions_select_admin ON public.transactions;
CREATE POLICY transactions_select_admin ON public.transactions
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS transactions_update_admin ON public.transactions;
CREATE POLICY transactions_update_admin ON public.transactions
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS admin_users_read_self ON public.admin_users;
CREATE POLICY admin_users_read_self ON public.admin_users
  FOR SELECT TO authenticated
  USING (lower(email) = lower(coalesce(current_setting('request.jwt.claim.email', true), '')));

-- 4b) App-config columns for the admin Settings module (nullable/backfilled
--     defaults — the mobile client is unaffected; it simply ignores them).
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS announcement_text text;
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS announcement_active boolean NOT NULL DEFAULT false;
ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS maintenance_mode boolean NOT NULL DEFAULT false;

-- 5) Settlement helper for the webhook: flip pending → paid exactly once and
--    apply the plan. Returns true when THIS call performed the settlement.
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

-- NOTE: seed your admin with:  INSERT INTO public.admin_users (email)
--                             VALUES ('you@aacsensoria.id');
-- (Runs with the service role / SQL editor — no policy needed for that.)
