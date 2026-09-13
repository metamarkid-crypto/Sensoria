import { createServiceClient } from "@/lib/supabase/server";
import { getExecutiveData, type RoyaltyRecord } from "@/lib/analytics";

/**
 * Royalty settlement ledger for the Subscriptions page
 * (supabase/migrations/20260913_royalty_payments.sql).
 *
 * The money math (gross / refunded / net / 10%) is DERIVED from the
 * transactions + refunds ledger exactly like the Executive page; this module
 * only joins the human settlement state: was the month marked paid, when,
 * with which proof. Before the migration exists, settlement fields stay
 * undefined and the UI shows every month as 'due'.
 */
export async function getRoyaltyLedger(): Promise<{
  records: RoyaltyRecord[];
  migrationApplied: boolean;
}> {
  const [exec, db] = await Promise.all([
    getExecutiveData(),
    Promise.resolve(createServiceClient()),
  ]);

  const { data, error } = await db
    .from("royalty_payments")
    .select("period_month, status, paid_at, proof_url, note")
    .order("period_month", { ascending: false });

  if (error) {
    // Table missing (migration not applied yet) — derive without settlement.
    return { records: exec.royaltyHistory, migrationApplied: false };
  }

  const byMonth = new Map(
    ((data ?? []) as Array<Record<string, unknown>>).map((r) => [
      String(r.period_month),
      r,
    ]),
  );

  const records: RoyaltyRecord[] = exec.royaltyHistory.map((r) => {
    const row = byMonth.get(r.monthKey);
    return {
      ...r,
      settlementStatus: (row?.status as "due" | "paid" | undefined) ?? "due",
      settlementPaidAt: (row?.paid_at as string | undefined) ?? null,
      settlementProofUrl: (row?.proof_url as string | undefined) ?? null,
      settlementNote: (row?.note as string | undefined) ?? null,
    };
  });

  return { records, migrationApplied: true };
}
