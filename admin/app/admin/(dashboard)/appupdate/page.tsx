import AppUpdatePanel from "./AppUpdatePanel";
import { requireOwner } from "@/lib/auth";
import { getAppUpdateStatus } from "@/lib/qrisApi";
import type { AppUpdateConfig } from "@/lib/qrisApi";

export const metadata = {
  title: "App Update — Sensoria Admin",
};

/**
 * /admin/appupdate — publish Android app releases hosted on the payment VPS.
 *
 * Owner-only: publishing a version bumps what every installed app checks at
 * launch (/api/app-update/check). The current config is fetched server-side
 * from the signed /internal/app-update/status endpoint; a load failure
 * degrades to an inline error with the panel still rendered.
 */
export default async function AppUpdatePage() {
  const admin = await requireOwner(); // Support → OwnerRequiredError → error boundary

  let config: AppUpdateConfig | null = null;
  let loadError: string | null = null;
  try {
    const res = await getAppUpdateStatus();
    config = res.config;
  } catch (err) {
    loadError =
      err instanceof Error
        ? `Tidak dapat memuat status rilis: ${err.message}`
        : "Tidak dapat memuat status rilis.";
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">App Update</h1>
        <p className="mt-1 text-sm text-slate-400">
          Rilis aplikasi Android di-host di VPS pembayaran. Aplikasi memeriksa
          version_code saat dibuka; bila lebih lama, tampil dialog update
          dengan unduhan langsung dari VPS. Semua aksi tercatat di Audit Log.
        </p>
        <p className="mt-1 text-xs text-slate-500">Owner: {admin.email}</p>
      </header>

      <AppUpdatePanel initialConfig={config} loadError={loadError} />
    </div>
  );
}
