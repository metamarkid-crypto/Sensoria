import type { Metadata } from "next";
import Sidebar from "@/components/Sidebar";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Sensoria Admin",
};

/**
 * Admin shell — every /admin route renders inside this gate:
 * requireAdmin() redirects to /admin/login unless the caller holds a valid
 * Supabase Auth session AND an admin_users allowlist entry.
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
      <main className="flex-1 px-4 py-6 lg:px-8">{children}</main>
    </div>
  );
}
