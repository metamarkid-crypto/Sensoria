-- ============================================================================
-- Sensoria AAC — True Background Location (Roadmap Item #3)
-- Run in the Supabase SQL Editor (or `supabase db push`) after the previous
-- migrations. Mirrors the TS type LocationRow in src/services/db/types.ts.
--
-- The Child node's background task appends ONE row here per accepted write
-- (throttled to ~3 minutes) AND updates the live `devices` presence columns
-- (latitude/longitude/last_address/last_seen) so the existing presence
-- realtime channel keeps working. The Parent map subscribes to INSERTs on
-- this table filtered by child_device_id for instant marker updates.
--
-- NOTE ON RLS: like every other table in this app, reads/writes currently
-- run under the anon key without RLS. If RLS is enabled later, add a
-- permissive INSERT/SELECT policy for the anon role mirroring devices.
-- ============================================================================

-- 1) locations — append-only GPS history per Child node
CREATE TABLE IF NOT EXISTS public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  accuracy double precision,              -- meters, when the OS reports it
  address text,                           -- reverse-geocoded "street, city"
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- Realtime + history reads are always per-child, newest-first.
CREATE INDEX IF NOT EXISTS idx_locations_child_recorded
  ON public.locations (child_device_id, recorded_at DESC);

-- Keep the table from growing forever: prune rows older than 30 days.
-- (Run on any cadence — Supabase cron is optional; harmless to skip.)
-- DELETE FROM public.locations WHERE recorded_at < now() - interval '30 days';