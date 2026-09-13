-- ============================================================================
-- Sensoria AAC — Parent-Slot Packages (one-time, permanent add-ons)
-- Run in the Supabase SQL Editor. Idempotent.
--
-- PRODUCT DECISION (locked 2026-09-13):
--   • Extra parent slots are PERMANENT one-time purchases — they never expire
--     and are NOT tied to the combo subscription's status.
--   • Default remains 1 linked parent per child (devices.max_parent_slots
--     already exists from 20260904_subscription_architecture.sql).
--   • Seeded pack: "+1 Parent Slot" @ Rp 25.000 flat (price editable anytime
--     in the dashboard's Plans panel — Owner-only, audited).
--
-- MECHANISM: reuses the proven money pipeline 1:1 — the QRIS backend
-- (service_role) calls apply_parent_slot_purchase() after payment
-- verification, exactly like apply_plan_purchase(). Every purchase lands in
-- `transactions` with the pack's plan_id, so refunds (refund_transaction),
-- the royalty ledger, and the Telegram paid-notification trigger all work
-- for slot packs with ZERO further changes.
-- ============================================================================

-- 1) plans gets a kind + slot payload -----------------------------------------
--    kind='combo'  → subscription plan (existing rows, duration_months used)
--    kind='slots'  → one-time parent-slot pack (slot_count extra slots)
ALTER TABLE public.plans
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'combo'
    CHECK (kind IN ('combo', 'slots')),
  ADD COLUMN IF NOT EXISTS slot_count integer;

COMMENT ON COLUMN public.plans.kind IS
  '''combo'' = subscription plan; ''slots'' = one-time permanent parent-slot pack.';
COMMENT ON COLUMN public.plans.slot_count IS
  'For kind=''slots'': how many EXTRA parent slots this pack grants.';

-- 2) Seed the Rp 25.000 / +1 slot pack (safe to re-run) ----------------------
INSERT INTO public.plans (name, description, duration_months, price, currency, is_active, kind, slot_count)
VALUES (
  'Slot Parent +1',
  'Permanen — tambah 1 slot perangkat parent terhubung untuk anak ini (bayar sekali).',
  1, 25000, 'IDR', true, 'slots', 1
)
ON CONFLICT DO NOTHING;

-- 3) The purchase RPC — service-role only, mirrors apply_plan_purchase() -----
CREATE OR REPLACE FUNCTION public.apply_parent_slot_purchase(
  p_child_device_id uuid,
  p_plan_id uuid
)
RETURNS integer -- the child's new max_parent_slots
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_kind       text;
  v_slot_count integer;
  v_device_role text;
  v_new_max    integer;
  v_now        timestamptz := now();
BEGIN
  -- 1) Resolve the pack: must exist, active, and actually be a slot pack.
  SELECT kind, slot_count INTO v_kind, v_slot_count
    FROM public.plans
   WHERE id = p_plan_id
     AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_parent_slot_purchase: plan % not found or inactive', p_plan_id;
  END IF;
  IF v_kind <> 'slots' OR v_slot_count IS NULL OR v_slot_count < 1 THEN
    RAISE EXCEPTION 'apply_parent_slot_purchase: plan % is not a slot pack', p_plan_id;
  END IF;

  -- 2) Slots belong to CHILD devices only.
  SELECT role INTO v_device_role FROM public.devices WHERE id = p_child_device_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'apply_parent_slot_purchase: device % not found', p_child_device_id;
  END IF;
  IF v_device_role <> 'Child' THEN
    RAISE EXCEPTION 'apply_parent_slot_purchase: device % is not a Child device', p_child_device_id;
  END IF;

  -- 3) Grant: permanent bump of max_parent_slots (atomic read-modify-write).
  UPDATE public.devices
     SET max_parent_slots = max_parent_slots + v_slot_count
   WHERE id = p_child_device_id
  RETURNING max_parent_slots INTO v_new_max;

  RETURN v_new_max;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_parent_slot_purchase(uuid, uuid) FROM anon, authenticated;
