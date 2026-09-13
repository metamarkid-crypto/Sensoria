-- ============================================================================
-- Sensoria AAC — Telegram Alerts: Stale Pending + Weekly Digest
-- Extends 20260913_telegram_paid_notifications.sql (same bot + chat settings:
-- ALTER DATABASE postgres SET app.telegram_bot_token / app.telegram_chat_id).
--
-- 1) STALE-PENDING ALERT — a silent webhook means a paid QRIS never reaches
--    the ledger and nobody notices. Every 15 minutes: any transaction still
--    'pending' after 1 hour pings once (dedup via the EXISTING
--    transactions.raw_payload — no extra table: we stamp
--    raw_payload->'alerts'->'stale_pending_notified_at').
--
-- 2) WEEKLY DIGEST — Monday 01:00 UTC (08:00 WIB): MTD revenue, net after
--    refunds (needs 20260913_manual_refunds.sql), settled count, pending
--    count, fleet sizes. Pure read + one http_post.
--
-- Run in the Supabase SQL Editor. Idempotent: safe to re-run.
-- ============================================================================

-- ── 1) Stale-pending sweep ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.alert_stale_pending_transactions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := public.get_setting_text('app.telegram_bot_token');
  v_chat  text := public.get_setting_text('app.telegram_chat_id');
  v_row   public.transactions;
  v_count integer := 0;
  v_text  text;
  v_now   text := to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
BEGIN
  IF v_token IS NULL OR v_chat IS NULL THEN
    RAISE WARNING 'telegram_not_configured — set app.telegram_bot_token / app.telegram_chat_id';
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT * FROM public.transactions
     WHERE status = 'pending'
       AND created_at < now() - interval '1 hour'
       AND coalesce(raw_payload->'alerts'->>'stale_pending_notified_at', '') = ''
     ORDER BY created_at
     LIMIT 20
  LOOP
    v_text := format(
      E'⏰ <b>Pending &gt; 1 hour</b>\n\nRef: <code>%s</code>\nAmount: <b>%s</b> %s\nCreated: %s WIB\n\nIf the customer already paid, replay settlement in the admin dashboard.',
      v_row.transaction_ref,
      to_char(v_row.amount, 'FM999,999,999'),
      v_row.currency,
      to_char(v_row.created_at AT TIME ZONE 'Asia/Jakarta', 'Dy DD Mon HH24:MI')
    );

    PERFORM net.http_post(
      url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := jsonb_build_object(
                   'chat_id', v_chat,
                   'text', v_text,
                   'parse_mode', 'HTML',
                   'disable_web_page_preview', true
                 )
    );

    -- Stamp the dedup marker (jsonb has no timestamp type — ISO string).
    UPDATE public.transactions
       SET raw_payload = jsonb_set(
             coalesce(raw_payload, '{}'::jsonb),
             '{alerts,stale_pending_notified_at}',
             to_jsonb(v_now)
           ),
           updated_at = now()
     WHERE id = v_row.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ── 2) Weekly digest (Monday morning) ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.send_weekly_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := public.get_setting_text('app.telegram_bot_token');
  v_chat  text := public.get_setting_text('app.telegram_chat_id');
  v_mtd          numeric;
  v_refunded_mtd numeric;
  v_settled      integer;
  v_pending      integer;
  v_active       integer;
  v_trials       integer;
  v_devices      integer;
  v_text         text;
BEGIN
  IF v_token IS NULL OR v_chat IS NULL THEN
    RAISE WARNING 'telegram_not_configured — set app.telegram_bot_token / app.telegram_chat_id';
    RETURN;
  END IF;

  SELECT
    coalesce(sum(t.amount) FILTER (WHERE t.status = 'paid'), 0),
    coalesce(sum(r.total) FILTER (WHERE t.status = 'paid'), 0),
    count(*) FILTER (WHERE t.status = 'paid'),
    count(*) FILTER (WHERE t.status = 'pending')
  INTO v_mtd, v_refunded_mtd, v_settled, v_pending
  FROM public.transactions t
  LEFT JOIN (
    SELECT transaction_ref, sum(amount) AS total
      FROM public.refunds
     GROUP BY transaction_ref
  ) r ON r.transaction_ref = t.transaction_ref
  WHERE date_trunc('month', coalesce(t.paid_at, t.created_at))
        = date_trunc('month', now());

  SELECT
    count(*) FILTER (WHERE status = 'active'),
    count(*) FILTER (WHERE status = 'trial')
  INTO v_active, v_trials
  FROM public.subscriptions;

  SELECT count(*) INTO v_devices FROM public.devices WHERE role = 'Child';

  v_text := format(
    E'📊 <b>Sensoria weekly digest</b>\n%s WIB\n\n<b>This month (MTD)</b>\nGross: <b>%s</b>\nRefunded: −%s\nNet: <b>%s</b>\nSettled: %s · Pending: %s\n\n<b>Fleet</b>\nActive subs: %s · Trials: %s · Child devices: %s',
    to_char(now() AT TIME ZONE 'Asia/Jakarta', 'Dy DD Mon YYYY'),
    to_char(v_mtd, 'FM999,999,999'),
    to_char(v_refunded_mtd, 'FM999,999,999'),
    to_char(v_mtd - v_refunded_mtd, 'FM999,999,999'),
    v_settled, v_pending,
    v_active, v_trials, v_devices
  );

  PERFORM net.http_post(
    url     := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
                 'chat_id', v_chat,
                 'text', v_text,
                 'parse_mode', 'HTML',
                 'disable_web_page_preview', true
               )
  );
END;
$$;

-- ── 3) Schedules (same advisory-lock pattern as the other jobs) ────────────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'alert-stale-pending-transactions',
      '*/15 * * * *',
      $$SELECT public.alert_stale_pending_transactions() WHERE pg_try_advisory_lock(918273647);$$
    );
    PERFORM cron.schedule(
      'weekly-digest',
      '0 1 * * 1', -- Monday 01:00 UTC = 08:00 WIB
      $$SELECT public.send_weekly_digest() WHERE pg_try_advisory_lock(918273648);$$
    );
  ELSE
    RAISE NOTICE 'pg_cron not enabled — enable it (Database > Extensions) and re-run.';
  END IF;
END;
$cron$;

-- ── Verification ────────────────────────────────────────────────────────────
--   SELECT public.alert_stale_pending_transactions();  -- manual sweep
--   SELECT public.send_weekly_digest();                -- manual digest
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname IN ('alert-stale-pending-transactions', 'weekly-digest');
-- ============================================================================
