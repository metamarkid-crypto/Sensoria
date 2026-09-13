import { createServiceClient } from "@/lib/supabase/server";
import type { TransactionRow } from "@/lib/types";

export interface TxListRow {
  id: string;
  transaction_ref: string;
  child_device_id: string;
  plan_name: string | null;
  amount: number;
  currency: string;
  status: TransactionRow["status"];
  payment_gateway: string;
  raw_payload: Record<string, unknown> | null;
  paid_at: string | null;
  refunded_at: string | null;
  created_at: string;
  /** Sum of refund rows for this transaction (0 when never refunded). */
  refundedTotal: number;
}

export interface TxStats {
  pending: number;
  paid: number;
  failed: number;
  volumePaid: number;
  /** Total money refunded across the listed transactions. */
  refunded: number;
  /** volumePaid − refunded — the money that actually stayed. */
  netSettledVolume: number;
}

/**
 * Newest-first ledger (capped at 500 rows for the browser table).
 * Joins plan names + child pairing codes through the FK relationships,
 * plus the refund totals from the refunds ledger
 * (supabase/migrations/20260913_manual_refunds.sql).
 */
export async function getTransactions(): Promise<{
  rows: TxListRow[];
  stats: TxStats;
}> {
  const db = createServiceClient();

  // Prefer the refunds-aware shape (20260913_manual_refunds.sql). If that
  // migration has not been applied yet the refunded_at column is missing
  // (PG 42703) — fall back to the legacy select so the page keeps working
  // with refundedTotal = 0 until the migration runs.
  let raw: Array<Record<string, unknown>>;
  let refundsColumnMissing = false;
  const withRefunds = await db
    .from("transactions")
    .select(
      "id, transaction_ref, child_device_id, amount, currency, status, payment_gateway, raw_payload, paid_at, refunded_at, created_at, plans(name)",
    )
    .order("created_at", { ascending: false })
    .limit(500);
  if (!withRefunds.error) {
    raw = (withRefunds.data ?? []) as Array<Record<string, unknown>>;
  } else {
    const legacy = await db
      .from("transactions")
      .select(
        "id, transaction_ref, child_device_id, amount, currency, status, payment_gateway, raw_payload, paid_at, created_at, plans(name)",
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (legacy.error) throw legacy.error;
    raw = (legacy.data ?? []) as Array<Record<string, unknown>>;
    refundsColumnMissing = true;
  }

  // One round-trip for every refund belonging to the listed transactions
  // (tolerates the refunds table not existing yet).
  const refs = raw.map((r) => r.transaction_ref as string);
  const refundedByRef = new Map<string, number>();
  if (!refundsColumnMissing && refs.length > 0) {
    const { data: refundRows } = await db
      .from("refunds")
      .select("transaction_ref, amount")
      .in("transaction_ref", refs);
    for (const r of (refundRows ?? []) as Array<{
      transaction_ref: string;
      amount: number;
    }>) {
      refundedByRef.set(
        r.transaction_ref,
        (refundedByRef.get(r.transaction_ref) ?? 0) + Number(r.amount),
      );
    }
  }

  const rows: TxListRow[] = raw.map((r) => ({
    id: r.id as string,
    transaction_ref: r.transaction_ref as string,
    child_device_id: r.child_device_id as string,
    plan_name: ((r.plans as { name?: string } | null) ?? null)?.name ?? null,
    amount: Number(r.amount),
    currency: r.currency as string,
    status: r.status as TransactionRow["status"],
    payment_gateway: r.payment_gateway as string,
    raw_payload: (r.raw_payload as Record<string, unknown> | null) ?? null,
    paid_at: (r.paid_at as string | null) ?? null,
    refunded_at: (r.refunded_at as string | null) ?? null,
    created_at: r.created_at as string,
    refundedTotal: refundedByRef.get(r.transaction_ref as string) ?? 0,
  }));

  const volumePaid = rows
    .filter((r) => r.status === "paid" || r.status === "refunded")
    .reduce((s, r) => s + r.amount, 0);
  const refundedTotal = rows.reduce((s, r) => s + r.refundedTotal, 0);

  const stats: TxStats = {
    pending: rows.filter((r) => r.status === "pending").length,
    paid: rows.filter((r) => r.status === "paid").length,
    failed: rows.filter((r) => r.status === "failed").length,
    volumePaid,
    refunded: refundedTotal,
    netSettledVolume: volumePaid - refundedTotal,
  };

  return { rows, stats };
}
