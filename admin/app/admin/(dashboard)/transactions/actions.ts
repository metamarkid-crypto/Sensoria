"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull } from "@/lib/auth";

async function guard() {
  const admin = await getAdminOrNull();
  if (!admin) throw new Error("Unauthorized");
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
  return error
    ? { ok: false, message: error.message }
    : { ok: true, message: `Status set to ${status}.` };
}
