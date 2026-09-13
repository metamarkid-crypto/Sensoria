-- ============================================================================
-- Sensoria AAC — Admin Audit Log (Web Admin Dashboard)
-- Companion to 20260911_admin_transactions.sql. Run in the Supabase SQL
-- Editor (idempotent — safe to re-run).
--
-- WHY: every privileged dashboard action (transaction override, plan
-- revocation, trial extension, plan/settings edits) must leave an immutable
-- WHO / WHAT / WHEN / WHERE record. Rows are written by the dashboard's
-- server actions through the SERVICE ROLE key (see admin/lib/audit.ts) and
-- are NEVER updated or deleted by application code.
--
-- SECURITY MODEL (same as 20260911_admin_transactions.sql):
--   • RLS enabled — admin read-only via is_admin(); INSERTs go through the
--     service role, which bypasses RLS entirely.
--   • No UPDATE/DELETE policies exist at all: even another compromised
--     admin JWT cannot rewrite history. Retention is enforced by pg_cron
--     running as the table owner (see bottom of this file).
-- ============================================================================

-- 1) Table -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- WHO: dashboard actor (from the Supabase Auth session, lowercased email).
  -- 'anonymous' when no session was resolvable (e.g. a blocked login attempt
  -- logged by the rate-limited sign-in action).
  actor_email text NOT NULL DEFAULT 'anonymous',

  -- WHAT: one of login_succeeded | login_failed | login_rate_limited |
  --   settings_update | plan_upsert | plan_toggle | transaction_override |
  --   transaction_settlement_retry | subscription_extend | subscription_revoke
  action text NOT NULL,

  -- WHERE (coarse): 'auth.login' for sign-in attempts, otherwise the
  -- dashboard module, e.g. 'settings', 'subscriptions', 'devices',
  -- 'transactions'.
  scope text NOT NULL DEFAULT 'general',

  -- Human-readable summary shown as the primary line in /admin/audit.
  description text NOT NULL DEFAULT '',

  -- Machine-readable details: before/after snapshots, ids, counts.
  -- NEVER store credentials or raw webhook payloads with PII here.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Best-effort caller context captured server-side by the actions.
  ip_address text,
  user_agent text
);

COMMENT ON TABLE public.admin_audit_log IS
  'Append-only audit trail of privileged Sensoria admin-dashboard actions. Written via the service role; admins read-only; no UPDATE/DELETE policies.';

-- 2) Indexes for the review page ----------------------------------------------
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_desc
  ON public.admin_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_actor_created
  ON public.admin_audit_log (actor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action_created
  ON public.admin_audit_log (action, created_at DESC);

-- 3) RLS — read-only for admins, nothing for everyone else --------------------
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_audit_log_select_admin ON public.admin_audit_log;
CREATE POLICY admin_audit_log_select_admin ON public.admin_audit_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- Deliberately NO INSERT/UPDATE/DELETE policies:
--   • INSERT happens only via the service role (bypasses RLS).
--   • UPDATE/DELETE are impossible for anon/authenticated — the trail is
--     immutable at the policy level.

-- 4) Retention: keep ~12 months, prune the rest nightly ------------------------
-- trim_admin_audit_log() must run as the TABLE OWNER (postgres role in the
-- hosted SQL editor / pg_cron) — a plain SECURITY DEFINER owned by postgres
-- keeps DELETE possible even though RLS blocks every JWT role.
CREATE OR REPLACE FUNCTION public.trim_admin_audit_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.admin_audit_log
   WHERE created_at < now() - interval '365 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'trim-admin-audit-log',
      '43 3 * * *', -- daily 03:43 UTC, off the busy marks
      $$SELECT public.trim_admin_audit_log() WHERE pg_try_advisory_lock(918273646);$$
    );
  ELSE
    RAISE NOTICE 'pg_cron not enabled — schedule trim_admin_audit_log() manually or enable pg_cron (Database > Extensions) and re-run.';
  END IF;
END;
$cron$;

-- ── Verification ────────────────────────────────────────────────────────────
--   INSERT INTO public.admin_audit_log (actor_email, action, scope, description)
--     VALUES ('smoke@aacsensoria.id', 'settings_update', 'settings', 'smoke test');
--   SELECT * FROM public.admin_audit_log ORDER BY created_at DESC LIMIT 5;
--   -- as an admin JWT, the SELECT above must also work through PostgREST;
--   -- as anon it must return zero rows (RLS).
