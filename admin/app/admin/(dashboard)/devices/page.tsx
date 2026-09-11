import { getFleet } from "@/lib/devices";
import AdminDevicesTable from "./AdminDevicesTable";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const { items, stats } = await getFleet();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Devices & Profiles</h1>
        <p className="mt-1 text-sm text-slate-400">
          Every device, its child profile, linked parents, and entitlement state.
          Trial extensions keep raw boundaries as the source of truth.
        </p>
      </header>
      <AdminDevicesTable items={items} stats={stats} />
    </div>
  );
}
