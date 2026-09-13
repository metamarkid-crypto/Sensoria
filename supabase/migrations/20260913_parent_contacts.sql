-- ============================================================================
-- Sensoria AAC — Parent Contact Registry (child_devices)
-- Companion to the Parent-Slot packages (20260913_parent_slot_packs.sql).
-- Run in the Supabase SQL Editor. Idempotent (IF NOT EXISTS everywhere).
--
-- WHY: family_links only stores a LABEL ("Ibu", "Ayah") — there is no phone
-- number, so the dashboard cannot answer "WHICH parent is this?" or "how do
-- I reach them?" This table keys contact info by parent_device_id (ONE row
-- per parent device, covering all of their linked children) and is kept in
-- sync with family_links by two triggers:
--   • whenever a link appears for a parent device → row appears here;
--   • when their LAST link is removed → the row is removed too.
--
-- Trust model: rows are written by the SERVICE ROLE only (trigger runs as
-- definer). The mobile app can upsert its OWN row's phone via the anon key
-- (RLS note below); the dashboard reads/writes via service role.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.child_devices (
  parent_device_id uuid PRIMARY KEY
    REFERENCES public.devices(id) ON DELETE CASCADE,
  parent_name  text,
  parent_phone text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.child_devices IS
  'Contact registry per Parent device (phone reachability), synced from family_links by trigger.';

-- ── Trigger A: ensure a row exists whenever a parent gains/keeps a link ────
CREATE OR REPLACE FUNCTION public.sync_child_device_on_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.child_devices (parent_device_id)
  VALUES (NEW.parent_device_id)
  ON CONFLICT (parent_device_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_child_device_on_link ON public.family_links;
CREATE TRIGGER trg_child_device_on_link
  AFTER INSERT ON public.family_links
  FOR EACH ROW EXECUTE FUNCTION public.sync_child_device_on_link();

-- ── Trigger B: drop the row when a parent loses their LAST link ────────────
CREATE OR REPLACE FUNCTION public.sync_child_device_on_unlink()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
    FROM public.family_links
   WHERE parent_device_id = OLD.parent_device_id;

  IF v_remaining = 0 THEN
    DELETE FROM public.child_devices
     WHERE parent_device_id = OLD.parent_device_id;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_child_device_on_unlink ON public.family_links;
CREATE TRIGGER trg_child_device_on_unlink
  AFTER DELETE ON public.family_links
  FOR EACH ROW EXECUTE FUNCTION public.sync_child_device_on_unlink();

-- ── Backfill: one row per parent device that currently holds any link ──────
INSERT INTO public.child_devices (parent_device_id)
SELECT DISTINCT parent_device_id
  FROM public.family_links
ON CONFLICT (parent_device_id) DO NOTHING;

-- ── RLS: mobile app may manage ITS OWN row; everyone else transparent ──────
-- The app currently runs on the anon key WITHOUT RLS (see the header of
-- 20260904_subscription_architecture.sql). If RLS is ever enabled, these are
-- the intended policies — enabling RLS on an untracked table in a live
-- deployment would silently break the app, so the policies ship DISABLED.
-- ALTER TABLE public.child_devices ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY child_devices_self_write ON public.child_devices
--   FOR ALL TO anon USING (true) WITH CHECK (true);
