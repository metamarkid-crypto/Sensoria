-- 20261024_child_profiles_realtime.sql
--
-- WHY
--   Parent ⇄ Child settings live in `child_profiles.settings` (appearance,
--   Balasan Visual, voice, accessibility). Both apps open a
--   `postgres_changes` subscription filtered on
--   `device_id=eq.<child>` — but the table was never added to the
--   `supabase_realtime` publication, so those UPDATE events never arrived and
--   remote settings only applied after an app restart.
--
--   The app no longer depends on this migration: it now mirrors settings over
--   a Realtime BROADCAST channel plus a REST catch-up on foreground resume
--   (src/services/settings/settingsSync.ts). This migration is the server-side
--   layer that makes the existing `postgres_changes` listeners work too, so a
--   change written by the offline outbox replay (no live client on that
--   device) still reaches the peer over the socket.
--
-- SAFETY
--   • Idempotent — safe to re-run.
--   • Realtime respects RLS: subscribers only receive rows the anon key can
--     already SELECT today (see 20260916_enable_core_rls.sql), so this adds
--     no new data exposure.
--   • Read-only change: no schema/column/data mutation.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'Publication supabase_realtime is missing — create it in the Supabase dashboard (Database → Replication) and re-run this migration.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'child_profiles'
  ) THEN
    RAISE NOTICE 'child_profiles is already in supabase_realtime — nothing to do.';
    RETURN;
  END IF;

  ALTER PUBLICATION supabase_realtime ADD TABLE public.child_profiles;
  RAISE NOTICE 'child_profiles added to supabase_realtime (settings mirror fallback enabled).';
END $$;
