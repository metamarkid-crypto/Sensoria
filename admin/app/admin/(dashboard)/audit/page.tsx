import { getAuditLog } from "@/lib/audit";
import AdminAuditTable from "./AdminAuditTable";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; actor?: string }>;
}) {
  const params = await searchParams;
  const { entries, total } = await getAuditLog({
    action: params.action,
    actor: params.actor,
    limit: 300,
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Audit Log</h1>
        <p className="mt-1 text-sm text-slate-400">
          Append-only trail of every privileged action — overrides, revocations,
          extensions, plan/settings edits, and sign-in attempts. Rows are
          written by the server actions and cannot be edited or deleted from
          the dashboard (pruned automatically after 365 days).
        </p>
      </header>
      <AdminAuditTable entries={entries} total={total} />
    </div>
  );
}
