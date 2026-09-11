"use client";

import { useMemo, useState, useTransition } from "react";
import { Search, CalendarClock, Ban, Tablets } from "lucide-react";
import clsx from "clsx";
import type { DeviceListItem, FleetStats } from "@/lib/devices";
import {
  Card,
  EmptyState,
  StatCard,
  SubscriptionBadge,
  fmtDate,
} from "@/components/ui";
import { extendTrialAction, revokePlanAction } from "./actions";

export default function AdminDevicesTable({
  items,
  stats,
}: {
  items: DeviceListItem[];
  stats: FleetStats;
}) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "Child" | "Parent">("all");
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(
    () =>
      items.filter((i) => {
        if (roleFilter !== "all" && i.device.role !== roleFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          const hay = `${i.device.id} ${i.profile?.full_name ?? ""} ${i.profile?.nickname ?? ""} ${i.parentLabels.join(" ")}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [items, search, roleFilter],
  );

  const runAction = (fn: () => Promise<{ ok: boolean; message: string }>) => {
    startTransition(async () => {
      const res = await fn();
      setToast(res.message);
      setTimeout(() => setToast(null), 5000);
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Total devices" value={stats.totalDevices} />
        <StatCard label="Children" value={stats.children} />
        <StatCard label="Parents" value={stats.parents} />
        <StatCard accent label="Online (24h)" value={stats.online24h} />
      </div>

      <Card
        title="Device fleet"
        action={<Tablets size={16} className="text-teal" />}
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-xl border border-ink-line p-1">
            {(["all", "Child", "Parent"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRoleFilter(r)}
                className={clsx(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                  roleFilter === r
                    ? "bg-teal-soft text-teal"
                    : "text-slate-400 hover:text-slate-200",
                )}
              >
                {r}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
            <input
              placeholder="Search id / child name / parent"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="glass-input w-72 pl-8"
            />
          </div>
          <span className="ml-auto text-xs text-slate-500">
            {filtered.length} of {items.length}
          </span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState>No devices match.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-ink-line">
              <thead>
                <tr>
                  <th className="table-head">Child</th>
                  <th className="table-head">Role</th>
                  <th className="table-head">Linked parents</th>
                  <th className="table-head">Subscription</th>
                  <th className="table-head">Ends</th>
                  <th className="table-head">Custom words</th>
                  <th className="table-head">Last seen</th>
                  <th className="table-head">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {filtered.map((i) => (
                  <tr key={i.device.id} className="hover:bg-white/5">
                    <td className="table-cell">
                      <p className="font-medium">{i.profile?.nickname ?? "—"}</p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {i.device.id.slice(0, 8)}…
                      </p>
                    </td>
                    <td className="table-cell text-xs uppercase tracking-wide text-slate-400">
                      {i.device.role}
                    </td>
                    <td className="table-cell text-xs text-slate-300">
                      {i.parentLabels.length > 0 ? i.parentLabels.join(", ") : "—"}
                    </td>
                    <td className="table-cell">
                      {i.subscription ? (
                        <SubscriptionBadge status={i.subscription.status} />
                      ) : (
                        <span className="text-xs text-slate-500">none</span>
                      )}
                    </td>
                    <td className="table-cell text-xs text-slate-400">
                      {fmtDate(
                        i.subscription?.status === "trial"
                          ? i.subscription.trialEndsAt
                          : i.subscription?.expiresAt ?? null,
                      )}
                    </td>
                    <td className="table-cell text-xs">{i.customWordCount}</td>
                    <td className="table-cell text-xs text-slate-400">
                      {fmtDate(i.device.last_seen)}
                    </td>
                    <td className="table-cell">
                      {i.device.role === "Child" && i.subscription ? (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              runAction(() => extendTrialAction(i.device.id, 7))
                            }
                            className="btn-ghost"
                            title="Grant a 7-day manual extension"
                          >
                            <CalendarClock size={13} /> +7d
                          </button>
                          {i.subscription.status !== "cancelled" ? (
                            <button
                              type="button"
                              disabled={pending}
                              onClick={() => {
                                if (
                                  confirm(
                                    `Revoke the plan for ${i.profile?.nickname ?? i.device.id}? Devices will lock on next sync.`,
                                  )
                                ) {
                                  runAction(() => revokePlanAction(i.device.id));
                                }
                              }}
                              className="btn-ghost text-rose-300 hover:border-rose-400/50 hover:text-rose-300"
                            >
                              <Ban size={13} /> Revoke
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {toast ? (
        <div className="fixed bottom-6 right-6 z-50 rounded-xl border border-teal/40 bg-ink-card px-4 py-3 text-sm text-slate-100 shadow-glass">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
