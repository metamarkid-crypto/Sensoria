-- ============================================================================
-- Sensoria AAC — Expire Stale Subscriptions (DB reflects reality)
-- Companion to the client gate in src/services/db/entitlement.ts.
--
-- WHY: expiry is judged client-side against raw boundaries; the subscriptions
-- rows themselves kept status 'trial'/'active' after their end date passed.
-- This job flips them to 'expired' so admin queries, analytics, and any
-- future server-side enforcement read truthful rows.
--
-- CLIENT CONTRACT (critical — must stay in sync):
-- The client persists the raw boundaries of the newest row per child
-- (fetchPremiumEntitlement → latestRow → useAACStore.refreshEntitlement).
-- A flip here must therefore NEVER touch trial_ends_at / expires_at: the
-- client's evaluateAccess() needs the PAST boundary to judge the grace /
-- locked phase after it re-reads the flipped row. Wiping dates would move
-- an expired device back to phase 'unknown', which never locks.
--
-- Also complements apply_plan_purchase(): a purchase on an 'expired' row
-- still works — stacking restarts from NOW() when the end date is past.
--
-- Safe to run manually / repeatedly: re-running is a no-op.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.expire_stale_subscriptions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trials  integer := 0;
  v_actives integer := 0;
BEGIN
  -- 1) Free trials whose trial_ends_at has passed → 'expired'.
  --    (expires_at mirrors trial_ends_at on injected trial rows, so judging
  --    on trial_ends_at matches the client's entitlement rule exactly.)
  UPDATE public.subscriptions
     SET status     = 'expired',
         updated_at = now()
   WHERE status = 'trial'
     AND trial_ends_at IS NOT NULL
     AND trial_ends_at <= now();

  GET DIAGNOSTICS v_trials = ROW_COUNT;

  -- 2) Paid periods whose expires_at has passed → 'expired'.
  --    (Renewal target for apply_plan_purchase is the newest row per child;
  --    flipping the stale one keeps that resolution intact.)
  UPDATE public.subscriptions
     SET status     = 'expired',
         updated_at = now()
   WHERE status = 'active'
     AND expires_at IS NOT NULL
     AND expires_at <= now();

  GET DIAGNOSTICS v_actives = ROW_COUNT;

  RETURN v_trials + v_actives;
END;
$$;

-- ── pg_cron schedule (hourly) ───────────────────────────────────────────────
-- Requires the pg_cron extension (available on Supabase projects). The
-- advisory lock guarantees singleton execution even if a run overruns.
-- cron.schedule() with a fixed jobname is idempotent — re-running this block
-- replaces the schedule instead of duplicating it.
-- NAMED dollar-quote ($cron$): the inner command string itself uses $$, and
-- an untagged DO $$ ... $$ block would be CLOSED by that first inner $$ —
-- orphaning the rest as raw SQL ("syntax error at or near \"SELECT\"").
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'expire-stale-subscriptions',
      '17 * * * *', -- hourly at :17, off the busy :00 mark
      $$SELECT public.expire_stale_subscriptions() WHERE pg_try_advisory_lock(918273645);$$
    );
  ELSE
    RAISE NOTICE 'pg_cron not enabled on this project — run expire_stale_subscriptions() manually, or enable pg_cron (Database > Extensions) and re-run this migration.';
  END IF;
END;
$cron$;

-- ── Verification ────────────────────────────────────────────────────────────
--   SELECT public.expire_stale_subscriptions();            -- manual run → count flipped
--   SELECT * FROM public.subscriptions ORDER BY updated_at DESC;
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname = 'expire-stale-subscriptions';
--   SELECT * FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'expire-stale-subscriptions')
--    ORDER BY start_time DESC LIMIT 5;
--
-- NOTE: status 'cancelled' is out of scope — nothing in the app writes it
-- yet. When a cancellation path lands, decide its expiry semantics here and
-- mirror them in evaluateAccess() (a 'cancelled' row with a NULL expires_at
-- currently evaluates to phase 'unknown' on the client, i.e. unlocked).
