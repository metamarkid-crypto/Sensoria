import PaymentGatewayPanel from "./PaymentGatewayPanel";
import { requireOwner } from "@/lib/auth";
import { getMerchantStatus } from "@/lib/qrisApi";
import type { MerchantView } from "@/lib/qrisApi";

export const metadata = {
  title: "Payment Gateway — Sensoria Admin",
};

/**
 * /admin/payment — QRIS merchant provisioning (blueprint §6 step 5).
 *
 * Owner-only: linking a GoBiz account, replacing the static QRIS and forcing
 * token refreshes are money-pipeline operations; Support admins are directed
 * to the audit log instead. The merchant list is fetched server-side from
 * the qris-api /internal/merchant/status endpoint (signed); a load failure
 * degrades to an inline error with the panel still rendered.
 */
export default async function PaymentPage() {
  const admin = await requireOwner(); // Support → OwnerRequiredError → dashboard error boundary

  let merchants: MerchantView[] = [];
  let loadError: string | null = null;
  try {
    const status = await getMerchantStatus();
    merchants = status.merchants;
  } catch (err) {
    loadError =
      err instanceof Error
        ? `Tidak dapat memuat status merchant: ${err.message}`
        : "Tidak dapat memuat status merchant.";
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Payment Gateway</h1>
        <p className="mt-1 text-sm text-slate-400">
          Tautkan akun GoBiz, pasang QRIS statis, dan pantau kesehatan sesi —
          jalur QRIS yang dipakai aplikasi (blueprint §4.3). Semua aksi tercatat di Audit Log.
        </p>
        <p className="mt-1 text-xs text-slate-500">Owner: {admin.email}</p>
      </header>

      <PaymentGatewayPanel initialMerchants={merchants} loadError={loadError} />
    </div>
  );
}
