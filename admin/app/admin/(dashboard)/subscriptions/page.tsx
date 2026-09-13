import { requireAdmin } from "@/lib/auth";
import { getSubscriptionsOverview } from "@/lib/subscriptions";
import { getRoyaltyLedger } from "@/lib/royalty";
import AdminPlansPanel from "./AdminPlansPanel";

export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const admin = await requireAdmin();
  const [{ plans, items }, royalty] = await Promise.all([
    getSubscriptionsOverview(),
    getRoyaltyLedger(),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Subscriptions & Plans</h1>
        <p className="mt-1 text-sm text-slate-400">
          Pricing control, paywall availability, the stacking preview, and the
          monthly developer royalty ledger.
        </p>
      </header>
      <AdminPlansPanel
        plans={plans}
        items={items}
        royaltyHistory={royalty.records}
        dashboardOwner={admin.role === "owner"}
      />
    </div>
  );
}
