import { createServiceClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { getTransactions } from "@/lib/transactions";
import AdminTransactionsTable from "./AdminTransactionsTable";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const admin = await requireAdmin();
  const { rows, stats } = await getTransactions();

  // Refunds require the refund_transaction RPC
  // (supabase/migrations/20260913_manual_refunds.sql). Probe with the read
  // helper — missing migration → error → buttons hidden instead of crashing.
  const db = createServiceClient();
  const probe = await db.rpc("get_refunds_for_transaction", {
    p_transaction_ref: "__probe__",
  });
  const canRefund = !probe.error;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Transactions</h1>
        <p className="mt-1 text-sm text-slate-400">
          QRIS ledger — overrides route through the same settlement RPC as the
          gateway webhook, so plan application can never be skipped.
          {canRefund
            ? " Refunds are recorded Owner-only and claw the entitlement back automatically."
            : " (Refund flow pending migration 20260913_manual_refunds.sql.)"}
        </p>
      </header>
      <AdminTransactionsTable
        rows={rows}
        stats={stats}
        dashboardOwner={admin.role === "owner"}
        canRefund={canRefund}
      />
    </div>
  );
}
