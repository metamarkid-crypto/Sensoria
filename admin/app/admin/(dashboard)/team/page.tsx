import TeamPanel from "./TeamPanel";
import { getTeam } from "./actions";
import { requireAdmin } from "@/lib/auth";

export const metadata = {
  title: "Admin Team — Sensoria Admin",
};

/**
 * /admin/team — roster of every allowlisted admin with role and last sign-in.
 * Mutations (invite / role change / remove) are Owner-only server actions;
 * the panel hides them from Support.
 */
export default async function TeamPage() {
  const admin = await requireAdmin();
  const { members, error } = await getTeam();

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Admin Team</h1>
        <p className="mt-1 text-sm text-slate-400">
          Who can open this dashboard, and what they are allowed to touch.
        </p>
      </header>
      <TeamPanel
        initialMembers={members}
        loadError={error ?? null}
        dashboardOwner={admin.role === "owner"}
      />
    </div>
  );
}
