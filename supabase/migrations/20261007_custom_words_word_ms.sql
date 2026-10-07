-- ============================================================================
-- SENSORIA AAC — custom_words.word_ms: Bahasa Melayu label for custom cards.
-- Part of the Malaysia expansion (quad-lingual id/en/zh/ms).
-- Nullable TEXT like word_en: legacy rows stay valid; the app backfills the
-- label via AI background translation. Idempotent — safe to re-run.
-- APPLY TO: Supabase Production (SQL Editor or `supabase db push`).
-- ============================================================================

ALTER TABLE public.custom_words ADD COLUMN IF NOT EXISTS word_ms TEXT;
