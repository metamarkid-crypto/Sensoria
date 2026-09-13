import type { Metadata } from "next";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { requireAdmin, ADMIN_ENFORCE_MFA } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Sensoria Admin",
};

/**
 * Admin shell — every /admin route renders inside this gate:
 * requireAdmin() redirects to /admin/login unless the caller holds a valid
 * Supabase Auth session AND an admin_users allowlist entry. When the MFA
 * policy is on but the session is still aal1, the request never gets here
 * (redirected to /admin/login?mfa=1). While the policy is off, a banner
 * nags every admin who has not enrolled a second factor yet.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdmin();

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <Sidebar email={admin.email} />
      <div className="min-w-0 flex-1">
        {!ADMIN_ENFORCE_MFA && !admin.mfaVerified ? (
          <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 lg:mx-8">
            <span>
              Your account has no second factor yet. Enable MFA in the Supabase
              dashboard (Authentication → Multi-Factor Auth), then enroll a TOTP
              app — see <code className="font-mono">admin/lib/SECURITY.md</code>.
            </span>
            <Link
              href="https://supabase.com/dashboard/project/_/auth/mfa"
              target="_blank"
              className="btn-ghost shrink-0"
            >
              Open MFA settings
            </Link>
          </div>
        ) : null}
        <main className="flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
