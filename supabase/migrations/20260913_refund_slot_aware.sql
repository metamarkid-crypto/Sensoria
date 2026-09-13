-- ============================================================================
-- Sensoria AAC — refund_transaction v2: slot-pack-aware claw-back
-- Upgrades 20260913_manual_refunds.sql (CREATE OR REPLACE, idempotent).
-- Run AFTER 20260913_parent_slot_packs.sql.
--
-- CHANGE vs v1: when the refunded transaction bought a SLOT PACK
-- (plans.kind = 'slots'), the entitlement claw-back must DECREMENT the
-- child's max_parent_slots by the pack's slot_count (floor 1 — the free
-- default slot is never taken away), NOT shorten the subscription duration.
-- v1 blindly treated any plan as a duration purchase and would have chopped
-- combo months for a slot refund. Everything else (money ledger, partial
-- refunds, advisory lock, combo stacking claw-back) is unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refund_transaction(
  p_transaction_ref   text,
  p_amount            numeric,
  p_reason            text,
  p_actor_email       text,
  p_gateway_reference text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx         public.transactions;
  v_refund_id  uuid;
  v_kind       public.plans.kind%TYPE;
  v_slot_count integer;
  v_duration   integer;
  v_child      uuid;
  v_new_end    timestamptz;
  v_refunded   numeric;
  v_result     jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'refund amount must be > 0';
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'refund reason is required';
  END IF;

  -- Serialize refunds per transaction.
  PERFORM pg_advisory_xact_lock(hashtext('refund:' || p_transaction_ref));

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE transaction_ref = p_transaction_ref
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction % not found', p_transaction_ref;
  END IF;
  IF v_tx.status <> 'paid' THEN
    RAISE EXCEPTION 'only paid transactions can be refunded (status is %)', v_tx.status;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_refunded
    FROM public.refunds WHERE transaction_ref = p_transaction_ref;
  IF v_refunded + p_amount > v_tx.amount + 0.001 THEN
    RAISE EXCEPTION 'refund exceeds paid amount (already refunded % of %)', v_refunded, v_tx.amount;
  END IF;

  -- 1) Money ledger: append the refund row, mark the transaction.
  INSERT INTO public.refunds
    (transaction_ref, amount, currency, gateway_reference, reason, created_by_email)
  VALUES
    (p_transaction_ref, p_amount, v_tx.currency, p_gateway_reference, p_reason, p_actor_email)
  RETURNING id INTO v_refund_id;

  UPDATE public.transactions
     SET refunded_at = now(),
         updated_at  = now(),
         status = CASE
           WHEN v_refunded + p_amount >= v_tx.amount - 0.001 THEN 'refunded'
           ELSE status -- partial: stays 'paid', refunds table tells the truth
         END
   WHERE id = v_tx.id;

  -- 2) Entitlement claw-back (skipped when plan_id is gone, e.g. plan deleted).
  v_child := v_tx.child_device_id;
  IF v_tx.plan_id IS NOT NULL THEN
    SELECT kind, slot_count, duration_months
      INTO v_kind, v_slot_count, v_duration
      FROM public.plans WHERE id = v_tx.plan_id;

    IF v_kind = 'slots' THEN
      -- SLOT PACK refund: permanently reduce the granted slots — floor 1,
      -- the free default slot is never taken away.
      UPDATE public.devices
         SET max_parent_slots = GREATEST(1, max_parent_slots - coalesce(v_slot_count, 1))
       WHERE id = v_child;
    ELSIF v_duration IS NOT NULL THEN
      IF EXISTS (
        SELECT 1 FROM public.transactions
         WHERE child_device_id = v_child
           AND status = 'paid'
           AND transaction_ref <> p_transaction_ref
      ) THEN
        -- STACKED combo: shorten the newest subscription row by the refunded
        -- duration (inverse of apply_plan_purchase). Never revoke outright —
        -- other purchases may still back this subscription.
        UPDATE public.subscriptions
           SET expires_at = GREATEST(
                 now() - interval '1 second',
                 expires_at - (v_duration * interval '30.4375 days')
               ),
               updated_at = now()
         WHERE id = (
           SELECT id FROM public.subscriptions
            WHERE child_device_id = v_child
            ORDER BY created_at DESC
            LIMIT 1
         )
           AND status = 'active'
           AND expires_at IS NOT NULL
        RETURNING expires_at INTO v_new_end;
      ELSE
        -- LAST PURCHASE: classic revoke — devices lock on next sync.
        UPDATE public.subscriptions
           SET status     = 'cancelled',
               plan_id    = NULL,
               updated_at = now()
         WHERE id = (
           SELECT id FROM public.subscriptions
            WHERE child_device_id = v_child
            ORDER BY created_at DESC
            LIMIT 1
         )
           AND status = 'active';
      END IF;
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'refund_id', v_refund_id,
    'ledger_status',
      (SELECT status FROM public.transactions WHERE id = v_tx.id),
    'new_expires_at', v_new_end
  );
  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.refund_transaction(text, numeric, text, text, text) IS
  'v2 — slot-pack-aware: refunds of plans.kind=''slots'' decrement max_parent_slots (floor 1) instead of shortening subscription duration.';
