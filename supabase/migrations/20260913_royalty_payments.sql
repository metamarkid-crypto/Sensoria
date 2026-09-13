-- ============================================================================
-- Sensoria AAC — Royalty Payments (close the loop with the developer)
-- Companion to the royalty derivation in admin/lib/analytics.ts.
--
-- WHY: the 10% developer royalty existed only as a DERIVED number on the
-- Executive page. Nothing recorded whether a month was actually SETTLED to
-- the developer. This adds the settlement state:
--
--   royalty_payments(period_month 'YYYY-MM' UNIQUE, amount, status due|paid,
--                    paid_at, proof_url, note, created_by_email)
--
-- amount is RECORDED at mark-paid time (money math stays derivable from the
-- ledger; this row is the human agreement — "yes, Rp X was sent for YYYY-MM").
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.royalty_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_month text NOT NULL
    CHECK (period_month ~ '^[0-9]{4}-[0-9]{2}$'), -- 'YYYY-MM'
  amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid')),
  paid_at timestamptz,
  -- Proof of the transfer (drive/DM link — no files stored in the DB).
  proof_url text,
  note text,
  created_by_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one settlement row per month.
CREATE UNIQUE INDEX IF NOT EXISTS uq_royalty_payments_month
  ON public.royalty_payments (period_month);

ALTER TABLE public.royalty_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS royalty_select_admin ON public.royalty_payments;
CREATE POLICY royalty_select_admin ON public.royalty_payments
  FOR SELECT TO authenticated
  USING (public.is_admin()); -- writes are service-role only (dashboard server actions)

-- ── Verification ────────────────────────────────────────────────────────────
--   SELECT * FROM public.royalty_payments ORDER BY period_month DESC;
-- ============================================================================
