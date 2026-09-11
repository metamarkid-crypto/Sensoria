import { getTransactions } from "@/lib/transactions";
import AdminTransactionsTable from "./AdminTransactionsTable";

export const dynamic = "force-dynamic";

export default async function TransactionsPage() {
  const { rows, stats } = await getTransactions();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Transactions</h1>
        <p className="mt-1 text-sm text-slate-400">
          QRIS ledger — overrides route through the same settlement RPC as the
          gateway webhook, so plan application can never be skipped.
        </p>
      </header>
      <AdminTransactionsTable rows={rows} stats={stats} />
    </div>
  );
}
