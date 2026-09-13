-- ============================================================================
-- Sensoria AAC — Realtime Paid-Transaction Notifications (Telegram)
-- Companion to supabase/migrations/20260911_admin_transactions.sql.
--
-- WHY: money landing used to be silent — the Owner found out only by opening
-- the dashboard. This migration fires ONE Telegram message the moment a
-- transaction transitions pending → paid, no app redeploy needed.
--
-- HOW: an AFTER UPDATE trigger on public.transactions calls pg_net's
-- net.http_post straight from SQL (async, fire-and-forget, non-blocking).
-- 'refunded' status transitions intentionally do NOT notify (the Owner
-- performs refunds manually in the gateway dashboard).
--
-- SETUP (once, in the Supabase SQL Editor):
--   1. Create the bot with @BotFather → copy the token.
--   2. Send any message to your bot, then open
--        https://api.telegram.org/bot<TOKEN>/getUpdates
--      and copy the chat id from result[0].message.chat.id
--   3. Run:  ALTER DATABASE postgres SET app.telegram_bot_token = '<TOKEN>';
--            ALTER DATABASE postgres SET app.telegram_chat_id  = '<CHAT_ID>';
--      (stored in the server settings file — NEVER in a table, never logged)
--   4. Re-run this file so the trigger function picks the settings up? Not
--      needed — current_setting reads them live on every fire.
--
-- IDEMPOTENCE: uses the session GUC app.notify_tx_status so the settlement
-- RPC and dashboard overrides can opt OUT when they notify themselves —
-- optional dedupe for future code paths. Safe to re-run (CREATE OR REPLACE).
-- ============================================================================

-- 0) pg_net — async HTTP out of SQL (usually preinstalled on Supabase).
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1) Guarded token/chat readers — current_setting errors on unset GUCs
--    unless the missing_ok argument is used; these wrap that and fail soft.
CREATE OR REPLACE FUNCTION public.get_setting_text(name text)
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v text;
BEGIN
  BEGIN
    SELECT current_setting(name, true) INTO v;
  EXCEPTION WHEN OTHERS THEN
    v := NULL;
  END;
  RETURN NULLIF(v, '');
END;
$$;

-- 2) The notifier. SECURITY DEFINER so it can read the server settings
--    (ALTER DATABASE ... SET) regardless of the triggering session's role.
CREATE OR REPLACE FUNCTION public.notify_transaction_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token text := get_setting_text('app.telegram_bot_token');
  v_chat  text := get_setting_text('app.telegram_chat_id');
  v_text  text;
  v_url   text;
  v_plan  text;
BEGIN
  IF coalesce(current_setting('app.notify_tx_status', true), '') = NEW.status THEN
    RETURN NULL; -- caller handles this transition's notification itself
  END IF;

  IF v_token IS NULL OR v_chat IS NULL THEN
    RAISE WARNING 'telegram_not_configured: set app.telegram_bot_token / app.telegram_chat_id via ALTER DATABASE ... SET';
    RETURN NULL;
  END IF;

  SELECT p.name INTO v_plan
    FROM public.plans p
   WHERE p.id = NEW.plan_id;

  v_text := format(
    E'💸 <b>Payment received</b>\n\n%s\nAmount: <b>%s</b>\nPlan: %s\nDevice: %s\nRef: <code>%s</code>\n%s',
    to_char(coalesce(NEW.paid_at, NEW.created_at) AT TIME ZONE 'Asia/Jakarta',
            'Dy DD Mon YYYY, HH24:MI') || ' WIB',
    to_char(NEW.amount, 'FM999,999,999') || ' ' || NEW.currency,
    coalesce(v_plan, '—'),
    NEW.child_device_id,
    NEW.transaction_ref,
    'Sensoria Admin'
  );

  v_url := 'https://api.telegram.org/bot' || v_token || '/sendMessage';

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := jsonb_build_object(
                 'chat_id', v_chat,
                 'text', v_text,
                 'parse_mode', 'HTML',
                 'disable_web_page_preview', true
               )
  );

  RETURN NULL; -- AFTER trigger
END;
$$;

-- 3) Wire the trigger — only the failed→paid-style transitions notify.
DROP TRIGGER IF EXISTS trg_transactions_notify_paid ON public.transactions;
CREATE TRIGGER trg_transactions_notify_paid
  AFTER UPDATE OF status ON public.transactions
  FOR EACH ROW
  WHEN (NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid')
  EXECUTE FUNCTION public.notify_transaction_paid();

-- ── Verification ────────────────────────────────────────────────────────────
--   -- Config present? (prints booleans, never the secrets)
--   SELECT
--     get_setting_text('app.telegram_bot_token') IS NOT NULL AS token_set,
--     get_setting_text('app.telegram_chat_id')  IS NOT NULL AS chat_set;
--
--   -- Live end-to-end test (uses YOUR token — expect one Telegram message):
--   UPDATE public.transactions SET status = 'failed' WHERE status = 'pending';
--   UPDATE public.transactions SET status = 'paid'   WHERE status = 'failed' AND transaction_ref = '<a-real-ref>';
--
--   -- Trigger armed?
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.transactions'::regclass AND NOT tgisinternal;
--
--   -- pg_net actually sent?
--   SELECT id, status_code, content FROM net._http_response ORDER BY id DESC LIMIT 5;
-- ============================================================================
