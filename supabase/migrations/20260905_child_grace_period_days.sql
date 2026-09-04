-- ============================================================================
-- Sensoria AAC — Child Grace Period (Compassionate Child, Strict Parent)
-- Follow-up to 20260904_subscription_architecture.sql. Run in the Supabase
-- SQL Editor (or `supabase db push`) AFTER the base migration.
--
-- child_grace_period_days: how many extra days of FULL offline AAC access a
-- Child node keeps after its trial/plan end date passes. Read dynamically at
-- entitlement refresh and cached locally so the Child stays usable offline.
-- Parents get ZERO grace — the Parent node is strictly gated.
-- ============================================================================

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS child_grace_period_days integer NOT NULL DEFAULT 3;

-- Sanity guard: negative grace is meaningless (0 = disable grace entirely).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_settings_child_grace_period_days_nonneg'
      AND conrelid = 'public.app_settings'::regclass
  ) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_child_grace_period_days_nonneg
      CHECK (child_grace_period_days >= 0);
  END IF;
END $$;

-- Keep the seeded row consistent with the new column default.
UPDATE public.app_settings
   SET child_grace_period_days = 3
 WHERE id = true AND child_grace_period_days IS NULL;
