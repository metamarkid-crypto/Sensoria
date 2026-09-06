-- ============================================================================
-- Sensoria AAC — apply_plan_purchase (Subscription Upgrade CTA — Stacking)
-- Companion to computeStackedExpiry() in src/services/db/entitlement.ts.
--
-- Called by the QRIS backend (service_role — bypasses RLS) AFTER payment is
-- verified. NOT called by the mobile client.
--
-- THE STACKING RULE (must stay identical to the client preview):
--   • current end date in the FUTURE (active → expires_at, trial →
--     trial_ends_at) → the purchased duration is APPENDED to it,
--   • expired / missing end date → the new period starts from NOW().
--   • one month = 30.4375 days (365.25 / 12), exactly like the client's
--     AVG_DAYS_PER_MONTH, so six 1-month renewals land within hours of one
--     6-month purchase and both sides compute the same timestamp.
--
-- Safe to re-run (CREATE OR REPLACE).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_plan_purchase(
  p_child_device_id uuid,
  p_plan_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duration_months integer;
  v_current_end     timestamptz;
  v_base            timestamptz;
  v_now             timestamptz := now();
  v_one_month       interval    := interval '30.4375 days'; -- 365.25 / 12
BEGIN
  -- 1) Resolve the plan (must exist and be active).
  SELECT duration_months
    INTO v_duration_months
    FROM public.plans
   WHERE id = p_plan_id
     AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_plan_purchase: plan % not found or inactive', p_plan_id;
  END IF;

  -- 2) Find the newest subscription row for this child (renewal target).
  SELECT
    CASE
      WHEN status = 'active' THEN expires_at
      WHEN status = 'trial'  THEN trial_ends_at
      ELSE NULL
    END
    INTO v_current_end
    FROM public.subscriptions
   WHERE child_device_id = p_child_device_id
   ORDER BY created_at DESC
   LIMIT 1;

  -- 3) THE STACKING RULE: append to a future end, restart from NOW otherwise.
  IF v_current_end IS NOT NULL AND v_current_end > v_now THEN
    v_base := v_current_end;
  ELSE
    v_base := v_now;
  END IF;

  -- 4) Flip the row to a paid 'active' subscription with the stacked expiry.
  UPDATE public.subscriptions
     SET status      = 'active',
         plan_id     = p_plan_id,
         expires_at  = v_base + (v_duration_months * v_one_month),
         updated_at  = v_now
   WHERE id = (
     SELECT id
       FROM public.subscriptions
      WHERE child_device_id = p_child_device_id
      ORDER BY created_at DESC
      LIMIT 1
   );
END;
$$;
