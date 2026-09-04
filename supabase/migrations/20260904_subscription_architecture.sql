-- ============================================================================
-- Sensoria AAC — Subscription Architecture Foundation (Master Blueprint)
-- Run in the Supabase SQL Editor (or `supabase db push`).
-- Mirrors the TS types in src/services/db/types.ts.
--
-- NOTE ON RLS: this app currently uses the anon key for all reads/writes.
-- If RLS is (or becomes) enabled on these tables, add permissive policies for
-- the anon role mirroring how devices/child_profiles are already exposed,
-- otherwise inserts from the mobile client will be silently blocked.
-- ============================================================================

-- 1) devices — Slot-Based Parent Expansion (default: 1 linked Parent per Child)
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS max_parent_slots integer NOT NULL DEFAULT 1;

-- 2) app_settings — single-row global dynamic config
--    web_payment_active: Stealth Mode kill-switch for external payment links
--      (false during App Review → paywall hidden; true post-approval).
--    trial_duration_days: free-trial length read dynamically at trial injection.
CREATE TABLE IF NOT EXISTS public.app_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true), -- single-row guard
  web_payment_active boolean NOT NULL DEFAULT false,
  trial_duration_days integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.app_settings (id, web_payment_active, trial_duration_days)
VALUES (true, false, 1)
ON CONFLICT (id) DO NOTHING;

-- 3) plans — paid Combo subscription packages (1 / 6 / 12 months)
CREATE TABLE IF NOT EXISTS public.plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,                 -- e.g. 'Combo 1 Bulan'
  description text,
  duration_months integer NOT NULL CHECK (duration_months IN (1, 6, 12)),
  price numeric(12, 2) NOT NULL,      -- displayed price (IDR)
  currency text NOT NULL DEFAULT 'IDR',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4) subscriptions — ONE row per Child node (Combo rule: linked Parents inherit)
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  child_device_id uuid NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES public.plans(id) ON DELETE SET NULL, -- NULL during trial
  status text NOT NULL DEFAULT 'trial'
    CHECK (status IN ('trial', 'active', 'expired', 'cancelled')),
  starts_at timestamptz NOT NULL DEFAULT now(),
  trial_ends_at timestamptz,   -- set while status = 'trial'
  expires_at timestamptz,      -- end of current paid period (status = 'active')
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_child_device_id
  ON public.subscriptions (child_device_id);
