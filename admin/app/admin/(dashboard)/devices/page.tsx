import { getFleet } from "@/lib/devices";
import { getDeviceDossier, type DeviceDossier } from "@/lib/lookup";
import { getAdminOrNull } from "@/lib/auth";
import AdminDevicesTable from "./AdminDevicesTable";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const [admin, { items, stats }] = await Promise.all([
    getAdminOrNull(),
    getFleet(),
  ]);
  const dashboardOwner = admin?.role === "owner";

  // Pre-fetch dossiers for the 50 newest CHILD devices so a row click renders
  // its detail instantly. Older rows (beyond 50) fall back to the server
  // action inside the table client — same data shape either way.
  const childIds = items
    .filter((i) => i.device.role === "Child")
    .slice(0, 50)
    .map((i) => i.device.id);
  const dossierList = await Promise.all(childIds.map((id) => getDeviceDossier(id)));
  const dossiers = dossierList.filter((d): d is DeviceDossier => d !== null);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Devices & Profiles</h1>
        <p className="mt-1 text-sm text-slate-400">
          Every device, its child profile, linked parents, and entitlement state.
          Click any row for the full dossier — subscriptions, payments, timeline,
          and the Owner&apos;s audited emergency locate.
        </p>
      </header>
      <AdminDevicesTable
        items={items}
        stats={stats}
        dossiers={dossiers}
        dashboardOwner={dashboardOwner}
      />
    </div>
  );
}
