"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, ScrollText, X } from "lucide-react";
import clsx from "clsx";
import type { AuditEntry } from "@/lib/audit";
import { Card, EmptyState, fmtDate } from "@/components/ui";

const ACTION_GROUPS = {
  "Logins & security": [
    "login_succeeded",
    "login_failed",
    "login_rate_limited",
  ],
  Entitlement: [
    "subscription_extend",
    "subscription_revoke",
    "plan_upsert",
    "plan_toggle",
  ],
  Money: [
    "transaction_override",
    "transaction_settlement_retry",
    "transaction_refund",
    "royalty_mark_paid",
  ],
  Configuration: [
    "settings_update",
  ],
  "Admin team": [
    "team_invite",
    "team_role_change",
    "team_remove",
  ],
  Privacy: [
    "privacy_purge_locations",
    "emergency_locate",
  ],
  Family: [
    "parent_contact_update",
    "parent_slot_grant",
  ],
} as const;

const ACTION_STYLES: Record<string, string> = {
  login_succeeded: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  login_failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  login_rate_limited: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  settings_update: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  plan_upsert: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  plan_toggle: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  transaction_override: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  transaction_settlement_retry: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  transaction_refund: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  royalty_mark_paid: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  subscription_extend: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  subscription_revoke: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  team_invite: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  team_role_change: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  team_remove: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  support_lookup: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  privacy_purge_locations: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  emergency_locate: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  parent_contact_update: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  parent_slot_grant: "bg-amber-500/15 text-amber-300 border-amber-500/30",
};

function ActionBadge({ action }: { action: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold",
        ACTION_STYLES[action] ?? "bg-slate-500/15 text-slate-400 border-slate-500/30",
      )}
    >
      {action}
    </span>
  );
}

export default function AdminAuditTable({
  entries,
  total,
}: {
  entries: AuditEntry[];
  total: number;
}) {
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [actorSearch, setActorSearch] = useState("");
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  const allActions = useMemo(
    () => Array.from(new Set(entries.map((e) => e.action))).sort(),
    [entries],
  );

  const filtered = useMemo(
    () =>
      entries.filter((e) => {
        if (actionFilter !== "all" && e.action !== actionFilter) return false;
        if (actorSearch && !e.actor_email.toLowerCase().includes(actorSearch.toLowerCase()))
          return false;
        return true;
      }),
    [entries, actionFilter, actorSearch],
  );

  return (
    <div className="space-y-6">
      <Card
        title="Activity trail"
        action={
          <span className="flex items-center gap-2 text-xs text-slate-500">
            <ScrollText size={14} className="text-teal" />
            {total.toLocaleString("id-ID")} total events
          </span>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1 rounded-xl border border-ink-line p-1">
            {(["all", ...allActions] as string[]).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => setActionFilter(a)}
                className={clsx(
                  "rounded-lg px-2.5 py-1.5 font-mono text-[11px] font-semibold transition",
                  actionFilter === a
                    ? "bg-teal-soft text-teal"
                    : "text-slate-400 hover:text-slate-200",
                )}
              >
                {a === "all" ? "all" : a.replace(/_/g, " ")}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
            <input
              placeholder="Filter by actor email"
              value={actorSearch}
              onChange={(e) => setActorSearch(e.target.value)}
              className="glass-input w-64 pl-8"
            />
          </div>
          <span className="ml-auto text-xs text-slate-500">
            {filtered.length} of {entries.length} shown
          </span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState>
            No audit entries yet — actions taken in the dashboard will appear
            here. (If you just ran the migration, this is expected.)
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-ink-line">
              <thead>
                <tr>
                  <th className="table-head">When</th>
                  <th className="table-head">Actor</th>
                  <th className="table-head">Action</th>
                  <th className="table-head">Scope</th>
                  <th className="table-head">Description</th>
                  <th className="table-head">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {filtered.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setSelected(e)}
                    className="cursor-pointer hover:bg-white/5"
                  >
                    <td className="table-cell whitespace-nowrap text-xs text-slate-400">
                      {fmtDate(e.created_at)}
                    </td>
                    <td className="table-cell text-xs font-medium">{e.actor_email}</td>
                    <td className="table-cell">
                      <ActionBadge action={e.action} />
                    </td>
                    <td className="table-cell font-mono text-xs text-slate-400">
                      {e.scope}
                    </td>
                    <td className="table-cell max-w-md truncate text-sm text-slate-300">
                      {e.description}
                    </td>
                    <td className="table-cell font-mono text-xs text-slate-500">
                      {e.ip_address ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected ? (
        <div
          className="fixed inset-0 z-40 flex justify-end bg-black/50"
          onClick={() => setSelected(null)}
        >
          <aside
            className="h-full w-full max-w-lg overflow-y-auto border-l border-ink-line bg-ink-soft p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-6 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-50">Audit entry</h3>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
              >
                <X size={18} />
              </button>
            </div>

            <dl className="space-y-3 text-sm">
              {(
                [
                  ["When", fmtDate(selected.created_at)],
                  ["Actor", selected.actor_email],
                  ["Action", selected.action],
                  ["Scope", selected.scope],
                  ["IP address", selected.ip_address ?? "—"],
                  ["User agent", selected.user_agent ?? "—"],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="text-right font-medium text-slate-200">{v}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-6 rounded-xl border border-ink-line bg-ink/80 p-4 text-sm text-slate-300">
              {selected.description}
            </p>

            <h4 className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Metadata
            </h4>
            <pre className="max-h-96 overflow-auto rounded-xl border border-ink-line bg-ink/80 p-4 font-mono text-xs text-slate-300">
              {selected.metadata && Object.keys(selected.metadata).length > 0
                ? JSON.stringify(selected.metadata, null, 2)
                : "No metadata recorded for this entry."}
            </pre>
          </aside>
        </div>
      ) : null}

      <p className="text-xs text-slate-600">
        Need the raw table? Query{" "}
        <code className="font-mono text-slate-400">public.admin_audit_log</code>{" "}
        in the Supabase SQL editor —{" "}
        <Link
          href="https://supabase.com/docs/guides/database/overview"
          className="text-teal hover:underline"
        >
          docs
        </Link>
        . Retention: 365 days (nightly pg_cron prune).
      </p>
    </div>
  );
}
