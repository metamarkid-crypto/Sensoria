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
  created_at: string;
}

export interface TxStats {
  pending: number;
  paid: number;
  failed: number;
  volumePaid: number;
}

/**
 * Newest-first ledger (capped at 500 rows for the browser table).
 * Joins plan names + child pairing codes through the FK relationships.
 */
export async function getTransactions(): Promise<{
  rows: TxListRow[];
  stats: TxStats;
}> {
  const db = createServiceClient();

  const { data, error } = await db
    .from("transactions")
    .select(
      "id, transaction_ref, child_device_id, amount, currency, status, payment_gateway, raw_payload, paid_at, created_at, plans(name)",
    )
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  const rows: TxListRow[] = ((data ?? []) as Array<Record<string, unknown>>).map(
    (r) => ({
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
      created_at: r.created_at as string,
    }),
  );

  const stats: TxStats = {
    pending: rows.filter((r) => r.status === "pending").length,
    paid: rows.filter((r) => r.status === "paid").length,
    failed: rows.filter((r) => r.status === "failed").length,
    volumePaid: rows
      .filter((r) => r.status === "paid")
      .reduce((s, r) => s + r.amount, 0),
  };

  return { rows, stats };
}
