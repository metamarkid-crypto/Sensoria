import { createServiceClient } from "@/lib/supabase/server";
import type { TransactionRow } from "@/lib/types";

export interface Kpis {
  mrrThisMonth: number;
  arrRunRate: number;
  activePaid: number;
  activeTrials: number;
  pendingTx: number;
  settledTx: number;
  /** Money refunded this calendar month — gross − refunded = net. */
  refundedThisMonth: number;
}

export interface RoyaltyRecord {
  monthKey: string;
  revenue: number;
  refunded: number;
  net: number;
  royalty: number; // 10% of NET realized revenue
  /** Settlement state from royalty_payments — undefined pre-migration. */
  settlementStatus?: "due" | "paid" | null;
  settlementPaidAt?: string | null;
  settlementProofUrl?: string | null;
  settlementNote?: string | null;
}

export interface DailyActivePoint {
  date: string;
  devices: number;
}

export interface RevenuePoint {
  monthKey: string;
  revenue: number;
  refunded: number;
  net: number;
  royalty: number;
}

const MONTHLY_ROYALTY_RATE = 0.1;

const monthKeyOf = (iso: string) => iso.slice(0, 7);

/**
 * All executive numbers in one service-role round-trip set.
 * Royalty is computed from NET realized revenue (paid − refunded) in the
 * calendar month — pending money is never royalty-eligible, refunded money
 * is deducted back out (20260913_manual_refunds.sql).
 */
export async function getExecutiveData(): Promise<{
  kpis: Kpis;
  revenueSeries: RevenuePoint[];
  activeDevices: DailyActivePoint[];
  royaltyHistory: RoyaltyRecord[];
}> {
  const db = createServiceClient();

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [subs, tx, devices, refunds, royalty] = await Promise.all([
    db.from("subscriptions").select("status"),
    db
      .from("transactions")
      .select("status, amount, currency, created_at, paid_at")
      .order("created_at", { ascending: false }),
    db.from("devices").select("id, role, last_seen").eq("role", "Child"),
    db.from("refunds").select("amount, created_at"),
    db.from("royalty_payments").select("period_month, status, paid_at"),
  ]);

  if (subs.error) throw subs.error;
  if (tx.error) throw tx.error;
  if (devices.error) throw devices.error;
  // refunds/royalty_payments may not exist yet (20260913_manual_refunds.sql /
  // 20260913_royalty_payments.sql) — degrade to zero refunds / all-due
  // instead of crashing the Executive page pre-migration.
  const refundRows = (refunds.error ? [] : (refunds.data ?? [])) as Array<{
    amount: number;
    created_at: string;
  }>;
  // royalty_payments may not exist yet (20260913_royalty_payments.sql) —
  // tolerate that and leave settlement state empty instead of failing.
  const royaltyRows = (royalty.data ?? []) as Array<{
    period_month: string;
    status: string;
    paid_at: string | null;
  }>;
  const royaltyByMonth = new Map(royaltyRows.map((r) => [r.period_month, r]));

  const txRows = (tx.data ?? []) as Array<
    Pick<TransactionRow, "status" | "amount" | "currency" | "created_at" | "paid_at">
  >;

  // ── KPIs ────────────────────────────────────────────────────────────────
  const paidTx = txRows.filter((t) => t.status === "paid" || t.status === "refunded");
  const mrrThisMonth = paidTx
    .filter((t) => (t.paid_at ?? "") >= monthStart.toISOString())
    .reduce((sum, t) => sum + Number(t.amount), 0);

  const refundedThisMonth = refundRows
    .filter((r) => r.created_at >= monthStart.toISOString())
    .reduce((sum, r) => sum + Number(r.amount), 0);

  const kpis: Kpis = {
    mrrThisMonth,
    arrRunRate: mrrThisMonth * 12,
    activePaid: (subs.data ?? []).filter((s) => s.status === "active").length,
    activeTrials: (subs.data ?? []).filter((s) => s.status === "trial").length,
    pendingTx: txRows.filter((t) => t.status === "pending").length,
    settledTx: paidTx.length,
    refundedThisMonth,
  };

  // ── Monthly revenue + royalty history (net realized money only) ─────────
  const byMonth = new Map<string, number>();
  for (const t of paidTx) {
    const key = monthKeyOf(t.paid_at ?? t.created_at);
    byMonth.set(key, (byMonth.get(key) ?? 0) + Number(t.amount));
  }
  const refundsByMonth = new Map<string, number>();
  for (const r of refundRows) {
    const key = monthKeyOf(r.created_at);
    refundsByMonth.set(key, (refundsByMonth.get(key) ?? 0) + Number(r.amount));
  }

  const revenueSeries: RevenuePoint[] = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12)
    .map(([monthKey, revenue]) => {
      const refunded = refundsByMonth.get(monthKey) ?? 0;
      const net = Math.max(0, revenue - refunded);
      return {
        monthKey,
        revenue,
        refunded,
        net,
        royalty: net * MONTHLY_ROYALTY_RATE,
      };
    });

  const royaltyHistory: RoyaltyRecord[] = revenueSeries.map((p) => ({
    monthKey: p.monthKey,
    revenue: p.revenue,
    refunded: p.refunded,
    net: p.net,
    royalty: p.royalty,
    settlementStatus: (royaltyByMonth.get(p.monthKey)?.status as
      | "due"
      | "paid"
      | undefined) ?? null,
    settlementPaidAt: royaltyByMonth.get(p.monthKey)?.paid_at ?? null,
  }));

  // ── Daily Active Devices (last 30d, from last_seen heartbeats) ──────────
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const perDay = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    perDay.set(d.toISOString().slice(0, 10), 0);
  }
  for (const dev of (devices.data ?? []) as Array<{
    id: string;
    last_seen: string | null;
  }>) {
    if (!dev.last_seen) continue;
    const ts = new Date(dev.last_seen).getTime();
    if (ts < since) continue;
    const key = new Date(ts).toISOString().slice(0, 10);
    if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const activeDevices: DailyActivePoint[] = [...perDay.entries()].map(
    ([date, devices]) => ({ date, devices }),
  );

  return { kpis, revenueSeries, activeDevices, royaltyHistory };
}
