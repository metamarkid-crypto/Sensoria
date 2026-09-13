-- ============================================================================
-- Sensoria AAC — Parent-Slot Enforcement (DB-level)
-- Companion to 20260913_parent_slot_packs.sql (the purchasable packs).
-- Run in the Supabase SQL Editor. Idempotent.
--
-- WHY A TRIGGER: the mobile PairingBottomSheet upserts family_links directly
-- and historically never checked devices.max_parent_slots. Enforcing in the
-- DB means EVERY writer (mobile app, dashboard, future webhooks) is covered
-- by the same rule — no app update is required to close the loophole.
--
-- RULE: a child may hold at most devices.max_parent_slots family_links rows
-- (default 1 from the architecture migration). Existing over-limit links are
-- grandfathered (kept, never auto-deleted) until removed manually.
--
-- NOTE: the dashboard's "+1 slot" grant action updates max_parent_slots with
-- the service role; this trigger only guards family_links, so granting is
-- never blocked by it.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_parent_slots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max integer;
  v_current integer;
BEGIN
  -- Only CHILD rows are capacity-bound (a child link consumes a parent slot).
  SELECT CASE WHEN d.role = 'Child' THEN d.max_parent_slots ELSE NULL END
    INTO v_max
    FROM public.devices d
   WHERE d.id = NEW.child_device_id;

  IF v_max IS NULL THEN
    RETURN NEW; -- parent side of the link, or device gone (FK would fire anyway)
  END IF;

  SELECT count(*) INTO v_current
    FROM public.family_links
   WHERE child_device_id = NEW.child_device_id;

  IF v_current > v_max THEN
    RAISE EXCEPTION
      'parent-slot limit reached: child % allows % linked parent(s) (has %). Purchase a slot pack or increase the limit in the dashboard.',
      NEW.child_device_id, v_max, v_current;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_parent_slots ON public.family_links;
CREATE TRIGGER trg_enforce_parent_slots
  BEFORE INSERT OR UPDATE OF child_device_id ON public.family_links
  FOR EACH ROW EXECUTE FUNCTION public.enforce_parent_slots();

-- ── Verification ────────────────────────────────────────────────────────────
-- Expect an ERROR on a child already at its limit:
--   INSERT INTO public.family_links (parent_device_id, child_device_id)
--   SELECT d1.id, d2.id FROM public.devices d1, public.devices d2
--    WHERE d1.role = 'Parent' AND d2.role = 'Child'
--      AND (SELECT count(*) FROM public.family_links fl WHERE fl.child_device_id = d2.id) >= d2.max_parent_slots
--    LIMIT 1;
-- ============================================================================