-- ============================================================================
-- Sensoria AAC — Admin Roles (Owner vs Support)
-- Companion to admin/lib/auth.ts (requireOwner) and /admin/team.
--
-- WHY: until now admin_users was a boolean allowlist — every allowlisted
-- email could change prices, override the money ledger, and edit app
-- settings. This migration introduces two roles:
--
--   owner   — full control: plans & pricing, money ledger overrides,
--             app settings, and the admin team itself.
--   support — day-to-day ops: device lookup, extend/revoke, read money.
--             CANNOT touch pricing, settlements/overrides, settings, team.
--
-- Enforcement lives in the DASHBOARD (server actions call requireOwner /
-- OwnerRequiredError). The DB keeps one hard invariant: EXACTLY ONE Owner —
-- the trigger below refuses any change that would leave zero Owners, so the
-- dashboard can never lock itself out of pricing controls.
--
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run.
-- ============================================================================

-- 1) role column — legacy rows fall back to 'support' (least privilege).
ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'support'
    CHECK (role IN ('owner', 'support'));

-- 2) is_owner() — mirrors is_admin(), SECURITY DEFINER so RLS/queries can
--    test the caller's role without granting table-wide access.
CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE lower(email) = lower(coalesce(current_setting('request.jwt.claim.email', true), ''))
      AND role = 'owner'
  );
$$;

-- 3) Single-Owner invariant. The dashboard refuses self-demotion of the last
--    Owner too, but the DB is the final backstop against lockout.
CREATE OR REPLACE FUNCTION public.enforce_single_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_owners integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role = 'owner' THEN
      SELECT count(*) INTO v_owners FROM public.admin_users WHERE role = 'owner';
      IF v_owners <= 1 THEN
        RAISE EXCEPTION 'Cannot remove the only Owner — promote another admin to Owner first.';
      END IF;
    END IF;
    RETURN OLD;
  ELSE
    -- INSERT of an Owner, or UPDATE that grants Owner to a non-Owner row.
    IF NEW.role = 'owner' AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM 'owner') THEN
      SELECT count(*) INTO v_owners FROM public.admin_users WHERE role = 'owner';
      IF v_owners >= 1 THEN
        RAISE EXCEPTION 'An Owner already exists — demote them to Support before promoting another.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS trg_admin_users_single_owner ON public.admin_users;
CREATE TRIGGER trg_admin_users_single_owner
  BEFORE INSERT OR UPDATE OF role OR DELETE ON public.admin_users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_single_owner();

-- 4) Seed: promote the existing allowlisted admin(s) to Owner — exactly once.
--    After the first Owner exists this is a no-op, so later-added Supports
--    are never silently promoted.
UPDATE public.admin_users
   SET role = 'owner'
 WHERE NOT EXISTS (SELECT 1 FROM public.admin_users WHERE role = 'owner');

-- ── Verification ────────────────────────────────────────────────────────────
--   SELECT email, role, created_at FROM public.admin_users ORDER BY created_at;
--   SELECT public.is_admin(), public.is_owner();  -- as an Owner session
--   UPDATE public.admin_users SET role='owner' WHERE role='support';  -- must ERROR
-- ============================================================================
