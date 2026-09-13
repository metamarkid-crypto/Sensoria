-- ============================================================================
-- Sensoria AAC — Location Data Retention (Families-policy hygiene)
-- Companion to supabase/migrations/20260906_background_location.sql.
--
-- WHY: the locations table stores a child's precise coordinates. The original
-- migration left its 30-day purge as a manual comment — never implemented —
-- so GPS history grows forever. This is (a) a storage cost and (b) a real
-- liability under Google Play Families / data-safety rules: a child's
-- movement history must not accumulate indefinitely.
--
-- POLICY: coordinates are operational data, not business records.
--   • locations            — 30 days, then gone.
--   • devices presence     — last fix only, updated in place. Untouched.
--   • transactions/ledger  — NOT touched (money records, indefinite).
--
-- Depends on: pg_cron (see 20260911_expire_stale_subscriptions.sql for the
-- same scheduling pattern). Idempotent: safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.prune_old_locations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  DELETE FROM public.locations
   WHERE recorded_at < now() - interval '30 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- ── pg_cron schedule (daily 03:40 WIB-ish, off the busy marks) ─────────────
-- Same advisory-lock + fixed-jobname pattern as the other cron jobs.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'prune-old-locations',
      '40 20 * * *', -- 20:40 UTC = 03:40 WIB, once daily
      $$SELECT public.prune_old_locations() WHERE pg_try_advisory_lock(918273646);$$
    );
  ELSE
    RAISE NOTICE 'pg_cron not enabled — run prune_old_locations() manually or enable pg_cron (Database > Extensions) and re-run.';
  END IF;
END;
$cron$;

-- ── Verification ────────────────────────────────────────────────────────────
--   SELECT public.prune_old_locations();                  -- manual run → rows purged
--   SELECT min(recorded_at) AS oldest FROM public.locations;  -- should be ≤ 30 days old
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'prune-old-locations';
-- ============================================================================
