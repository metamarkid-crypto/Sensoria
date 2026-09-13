import { requireAdmin } from "@/lib/auth";
import LookupClient from "./LookupClient";

export const metadata = {
  title: "Support Lookup — Sensoria Admin",
};

/**
 * /admin/lookup — one search box, the whole story of a child device:
 * subscription history, payments, and recent location pings (addresses
 * only — raw coordinates never leave the server, see lib/lookup.ts).
 */
export default async function LookupPage() {
  const admin = await requireAdmin();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Support Lookup</h1>
        <p className="mt-1 text-sm text-slate-400">
          Find one device and see its full story — subscriptions, payments, and
          recent locations — without opening three tabs.
        </p>
      </header>
      <LookupClient dashboardOwner={admin.role === "owner"} />
    </div>
  );
}
