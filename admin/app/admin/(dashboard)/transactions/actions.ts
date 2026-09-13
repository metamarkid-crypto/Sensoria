"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull, requireOwner, OwnerRequiredError } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

async function guard() {
  const admin = await getAdminOrNull();
  if (!admin) throw new Error("Unauthorized");
  // Settlement replays and status overrides rewrite the money ledger — Owner only.
  if (admin.role !== "owner") throw new OwnerRequiredError();
  return admin;
}

/**
 * Replay the payment-gateway settlement for one transaction.
 * Runs the SAME settle_transaction RPC the webhook uses — idempotent by
 * design: pending → paid (+ apply_plan_purchase), anything else is a no-op.
 */
export async function retrySettlementAction(
  transactionRef: string,
): Promise<{ ok: boolean; settled: boolean; message: string }> {
  await guard();

  const db = createServiceClient();
  const { data, error } = await db.rpc("settle_transaction", {
    p_transaction_ref: transactionRef,
  });

  if (error) {
    return { ok: false, settled: false, message: error.message };
  }

  revalidatePath("/admin/transactions");
  const settled = Boolean(data);
  await writeAudit({
    action: "transaction_settlement_retry",
    scope: "transactions",
    description: settled
      ? `Settlement replayed for ${transactionRef} — plan applied`
      : `Settlement replay for ${transactionRef} was a no-op (not pending)`,
    metadata: { transaction_ref: transactionRef, settled },
  });
  return {
    ok: true,
    settled,
    message: settled
      ? "Settled — plan applied to the subscription."
      : "No-op: transaction was not in 'pending' (already settled or failed).",
  };
}

/**
 * Manual status override. Marking 'paid' routes through the settlement RPC so
 * the plan application can never be skipped by a manual edit; 'failed' and
 * back to 'pending' are plain updates (audit trail stays in updated_at).
 */
export async function overrideStatusAction(
  transactionRef: string,
  status: "pending" | "paid" | "failed",
): Promise<{ ok: boolean; message: string }> {
  await guard();

  const db = createServiceClient();

  if (status === "paid") {
    const { data, error } = await db.rpc("settle_transaction", {
      p_transaction_ref: transactionRef,
    });
    if (error) return { ok: false, message: error.message };
    const settled = Boolean(data);
    revalidatePath("/admin/transactions");
    await writeAudit({
      action: "transaction_override",
      scope: "transactions",
      description: settled
        ? `Transaction ${transactionRef} overridden to 'paid' — plan applied`
        : `Override to 'paid' for ${transactionRef} was a no-op (row not pending)`,
      metadata: { transaction_ref: transactionRef, to_status: "paid", applied: settled },
    });
    return {
      ok: settled,
      message: settled
        ? "Marked paid — plan applied."
        : "Row was not pending anymore — no change made.",
    };
  }

  const { error } = await db
    .from("transactions")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("transaction_ref", transactionRef);

  revalidatePath("/admin/transactions");
  if (!error) {
    await writeAudit({
      action: "transaction_override",
      scope: "transactions",
      description: `Transaction ${transactionRef} status overridden to '${status}'`,
      metadata: { transaction_ref: transactionRef, to_status: status },
    });
  }
  return error
    ? { ok: false, message: error.message }
    : { ok: true, message: `Status set to ${status}.` };
}

export interface RefundRow {
  id: string;
  amount: number;
  currency: string;
  gateway_reference: string | null;
  reason: string;
  created_by_email: string;
  created_at: string;
}

/**
 * Manual gateway refund — Owner-only.
 *
 * The MONEY is refunded manually in the QRIS gateway dashboard; this action
 * records the refund leg in the ledger and pulls the entitlement back via
 * the refund_transaction RPC (atomic — see
 * supabase/migrations/20260913_manual_refunds.sql):
 *   • refunded purchase was the child's last purchase → plan revoked;
 *   • it was stacked onto an active subscription → expiry shortened by the
 *     refunded plan's duration instead (never revokes the whole sub).
 * Partial refunds are allowed; status flips to 'refunded' on full refund.
 */
export async function refundTransactionAction(
  transactionRef: string,
  amount: number,
  reason: string,
  gatewayReference?: string,
): Promise<{ ok: boolean; message: string; newExpiresAt?: string | null }> {
  try {
    const actor = await requireOwner();

    const trimmedReason = reason.trim();
    if (!trimmedReason) return { ok: false, message: "Refund reason is required." };
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, message: "Refund amount must be greater than 0." };
    }

    const db = createServiceClient();
    const { data, error } = await db.rpc("refund_transaction", {
      p_transaction_ref: transactionRef,
      p_amount: amount,
      p_reason: trimmedReason,
      p_actor_email: actor.email,
      p_gateway_reference: gatewayReference?.trim() || null,
    });
    if (error) return { ok: false, message: error.message };

    const result = (data ?? {}) as {
      ledger_status?: string;
      new_expires_at?: string | null;
    };
    revalidatePath("/admin/transactions");
    revalidatePath("/admin"); // KPIs and royalty now include refunds
    revalidatePath("/admin/subscriptions"); // stacked claw-back shortens expiry

    const shortenedExpiry = result.new_expires_at != null;
    await writeAudit({
      action: "transaction_refund",
      scope: "transactions",
      description: shortenedExpiry
        ? `Refund of ${amount} recorded for ${transactionRef} (${trimmedReason}) — stacked purchase, subscription expiry shortened`
        : `Refund of ${amount} recorded for ${transactionRef} (${trimmedReason}) — last purchase, plan revoked`,
      actorEmail: actor.email,
      metadata: {
        transaction_ref: transactionRef,
        refund_amount: amount,
        reason: trimmedReason,
        gateway_reference: gatewayReference?.trim() || null,
        ledger_status: result.ledger_status ?? null,
        new_expires_at: result.new_expires_at ?? null,
      },
    });

    return {
      ok: true,
      message: shortenedExpiry
        ? "Refund recorded — stacked purchase, subscription expiry shortened."
        : "Refund recorded — plan revoked, devices lock on next sync.",
      newExpiresAt: result.new_expires_at ?? null,
    };
  } catch (err) {
    if (err instanceof OwnerRequiredError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: "Refund failed unexpectedly — check the server logs." };
  }
}

/** Refund history for the transactions detail drawer. */
export async function getRefundsForTransaction(
  transactionRef: string,
): Promise<RefundRow[]> {
  const admin = await getAdminOrNull();
  if (!admin) return [];

  const db = createServiceClient();
  const { data, error } = await db
    .from("refunds")
    .select(
      "id, amount, currency, gateway_reference, reason, created_by_email, created_at",
    )
    .eq("transaction_ref", transactionRef)
    .order("created_at", { ascending: false });
  if (error) return [];
  return (data ?? []) as unknown as RefundRow[];
}
