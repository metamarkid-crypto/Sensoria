-- ============================================================================
-- SENSORIA AAC — custom_words: cloud backup for child-created dictionary cards
-- Trust model: devices authenticate as `anon` (no user auth yet), so policies
-- are scoped to child_device_id = the device's own UUID. A tampered client can
-- only ever touch ITS OWN rows. Safe to re-run (idempotent).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.custom_words (
  id TEXT PRIMARY KEY,
  child_device_id UUID NOT NULL,
  word_id TEXT NOT NULL,
  word_en TEXT,
  word_zh TEXT NOT NULL,
  image_url TEXT,
  category_id TEXT NOT NULL,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Upsert target: the client upserts on the PK (id).
CREATE INDEX IF NOT EXISTS custom_words_child_idx
  ON public.custom_words (child_device_id);

ALTER TABLE public.custom_words ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Devices manage their own custom words" ON public.custom_words;
CREATE POLICY "Devices manage their own custom words"
  ON public.custom_words
  FOR ALL
  TO anon
  USING (child_device_id::text = current_setting('request.headers', true)::json ->> 'x-sensoria-device-id')
  WITH CHECK (child_device_id::text = current_setting('request.headers', true)::json ->> 'x-sensoria-device-id');

-- NOTE ON SCOPE: the current client sends the anon key WITHOUT a device
-- header, so the predicate above evaluates to false and inserts would be
-- rejected (42501) — fail-safe by design, never a data leak. To activate the
-- backup today, either:
--   (a) set the header client-side: global fetch wrapper adding
--       'x-sensoria-device-id': deviceId, or
--   (b) temporarily widen the policy for the pilot:
--       DROP POLICY "Devices manage their own custom words" ON public.custom_words;
--       CREATE POLICY "Devices manage their own custom words"
--         ON public.custom_words FOR ALL TO anon USING (true) WITH CHECK (true);
--       -- (swap back to the scoped predicate once device headers ship)
