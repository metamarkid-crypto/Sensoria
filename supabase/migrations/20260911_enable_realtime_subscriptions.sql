-- ============================================================================
-- Sensoria AAC — Enable Realtime for Entitlement Tables
-- Run in the Supabase SQL Editor (or `supabase db push`). Fully idempotent.
--
-- WHY: the client (subscribeEntitlementRealtime) listens for postgres_changes
-- on `public.subscriptions` so a remote RENEWAL (apply_plan_purchase from a
-- different device) or CANCELLATION applies to a LIVE parent session in under
-- a second — instead of waiting for the next foreground resume, which is the
-- only trigger that exists today.
--
-- Realtime only delivers events for tables in the `supabase_realtime`
-- publication. Other app tables (messages, family_links, child_profiles,
-- app_settings, locations) already work in the running project, which implies
-- they were added to the publication manually in the dashboard — this
-- migration makes the two missing entitlement tables declarative + idempotent.
--
-- ROW-LEVEL FILTERS: Realtime respects RLS. This project runs the anon key
-- WITHOUT RLS on these tables, so postgres_changes payloads arrive in full.
-- If RLS is ever enabled, `subscriptions` MUST get a SELECT policy
-- (e.g. `true` for anon, matching the current implicit exposure) or the
-- realtime payloads — and the REST reads this feature depends on — will be
-- silently filtered.
--
-- REPLICA IDENTITY: DELETE events carry only the old row's PRIMARY KEY.
-- That is sufficient here: the handler re-fetches authoritative state via
-- refreshEntitlement(), so the deleted row's identity alone is enough.
-- ============================================================================

DO $$
DECLARE
  v_pub_exists boolean;
  v_added      integer := 0;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
    INTO v_pub_exists;

  IF NOT v_pub_exists THEN
    RAISE NOTICE 'supabase_realtime publication missing — create it in the Supabase dashboard (Database → Replication) and re-run.';
  ELSE
    -- subscriptions: renewals/cancellations/expiry flips (UPDATE) and new
    -- trial rows created on another device (INSERT).
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'subscriptions'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.subscriptions;
      v_added := v_added + 1;
    END IF;

    -- family_links: pairing/unpairing a child changes WHICH child's
    -- subscription row the Combo rule evaluates — the client must re-read
    -- its entitlement when a link appears/disappears mid-session.
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'family_links'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.family_links;
      v_added := v_added + 1;
    END IF;

    RAISE NOTICE 'Realtime publication check complete (% table(s) added).', v_added;
  END IF;
END $$;
