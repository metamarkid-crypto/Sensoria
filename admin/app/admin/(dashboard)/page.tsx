import { TrendingUp, Users, CreditCard, ReceiptText } from "lucide-react";
import { getExecutiveData } from "@/lib/analytics";
import { Card, StatCard, EmptyState, fmtIDR } from "@/components/ui";
import { ActiveDevicesChart, RevenueChart } from "@/components/ExecutiveCharts";

export const dynamic = "force-dynamic";

export default async function ExecutivePage() {
  const { kpis, revenueSeries, activeDevices, royaltyHistory } =
    await getExecutiveData();

  const currentRoyalty =
    royaltyHistory.length > 0
      ? royaltyHistory[royaltyHistory.length - 1]
      : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Executive Analytics</h1>
        <p className="mt-1 text-sm text-slate-400">
          Revenue, fleet health, and the monthly developer royalty.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          accent
          label="MRR (this month)"
          value={fmtIDR(kpis.mrrThisMonth)}
          sub={`ARR run rate ≈ ${fmtIDR(kpis.arrRunRate)}`}
        />
        <StatCard
          label="Active paid subscriptions"
          value={kpis.activePaid}
          sub={`${kpis.activeTrials} devices on trial`}
        />
        <StatCard
          label="Pending transactions"
          value={kpis.pendingTx}
          sub={`${kpis.settledTx} settled all-time`}
        />
        <StatCard
          label={`Royalty ${new Date().toISOString().slice(0, 7)}`}
          value={fmtIDR(currentRoyalty?.royalty ?? 0)}
          sub="10% of realized monthly revenue"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card title="Monthly revenue growth" action={<TrendingUp size={16} className="text-teal" />}>
          {revenueSeries.length > 0 ? (
            <RevenueChart data={revenueSeries} />
          ) : (
            <EmptyState>No settled transactions yet — revenue appears here after the first QRIS payment.</EmptyState>
          )}
        </Card>
        <Card title="Daily active devices (30d)" action={<Users size={16} className="text-teal" />}>
          <ActiveDevicesChart data={activeDevices} />
        </Card>
      </div>

      <Card title="Developer royalty history (10% of realized revenue)" action={<ReceiptText size={16} className="text-teal" />}>
        {royaltyHistory.length === 0 ? (
          <EmptyState>No revenue recorded yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-ink-line">
              <thead>
                <tr>
                  <th className="table-head">Month</th>
                  <th className="table-head">Realized revenue</th>
                  <th className="table-head">Royalty (10%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {royaltyHistory.map((r) => (
                  <tr key={r.monthKey} className="hover:bg-white/5">
                    <td className="table-cell font-medium">{r.monthKey}</td>
                    <td className="table-cell">{fmtIDR(r.revenue)}</td>
                    <td className="table-cell text-teal">{fmtIDR(r.royalty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="flex items-center gap-2 text-xs text-slate-500">
        <CreditCard size={13} />
        Royalty counts only <strong>paid</strong> transactions — pending or
        failed money is never royalty-eligible.
      </p>
    </div>
  );
}
