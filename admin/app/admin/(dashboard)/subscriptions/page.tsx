import { getSubscriptionsOverview } from "@/lib/subscriptions";
import AdminPlansPanel from "./AdminPlansPanel";

export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const { plans, items } = await getSubscriptionsOverview();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Subscriptions & Plans</h1>
        <p className="mt-1 text-sm text-slate-400">
          Pricing control, paywall availability, and the stacking preview — the
          same 30.4375-day month math as the client and the settlement RPC.
        </p>
      </header>
      <AdminPlansPanel plans={plans} items={items} />
    </div>
  );
}
