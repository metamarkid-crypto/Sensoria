"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, CalendarClock, Ban, Tablets, X, Loader2, Phone } from "lucide-react";
import clsx from "clsx";
import type { DeviceListItem, FleetStats } from "@/lib/devices";
import type { DeviceDossier } from "@/lib/lookup";
import {
  Card,
  EmptyState,
  StatCard,
  SubscriptionBadge,
  fmtDate,
} from "@/components/ui";
import ConfirmDialog from "@/components/ConfirmDialog";
import DeviceDossierPanel from "@/components/DeviceDossierPanel";
import { extendTrialAction, revokePlanAction } from "./actions";
import {
  getDeviceDossierAction,
  emergencyLocateAction,
  purgeDeviceLocationsAction,
} from "../lookup/actions";

export default function AdminDevicesTable({
  items,
  stats,
  dossiers,
  dashboardOwner,
}: {
  items: DeviceListItem[];
  stats: FleetStats;
  /** Pre-fetched dossiers (50 newest children) — row clicks render instantly. */
  dossiers: DeviceDossier[];
  dashboardOwner: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "Child" | "Parent">("all");
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [revokeTarget, setRevokeTarget] = useState<DeviceListItem | null>(null);

  // Row-click dossier.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fallbackDossier, setFallbackDossier] = useState<DeviceDossier | null>(null);
  const [loadingDossier, setLoadingDossier] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);

  // Emergency locate + purge (both Owner-only, both audited).
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<DeviceDossier | null>(null);
  const [purgePending, startPurge] = useTransition();

  const dossierById = useMemo(
    () => new Map(dossiers.map((d) => [d.device.id, d])),
    [dossiers],
  );

  const filtered = useMemo(
    () =>
      items.filter((i) => {
        if (roleFilter !== "all" && i.device.role !== roleFilter) return false;
        if (search) {
          const q = search.toLowerCase();
          const hay = `${i.device.id} ${i.profile?.full_name ?? ""} ${i.profile?.nickname ?? ""} ${i.parentLabels.join(" ")} ${i.parentContact?.name ?? ""} ${i.parentContact?.phone ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [items, search, roleFilter],
  );

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 5000);
  };

  const runAction = (fn: () => Promise<{ ok: boolean; message: string }>) => {
    startTransition(async () => {
      const res = await fn();
      showToast(res.message);
      router.refresh(); // re-sync server data (list + pre-fetched dossiers)
    });
  };

  const openDossier = (deviceId: string) => {
    setSelectedId(deviceId);
    setFallbackDossier(dossierById.get(deviceId) ?? null);
    // Beyond the pre-fetched 50 → fetch via the server action once.
    if (!dossierById.has(deviceId)) {
      setLoadingDossier(true);
      getDeviceDossierAction(deviceId)
        .then(setFallbackDossier)
        .finally(() => setLoadingDossier(false));
    }
    requestAnimationFrame(() =>
      drawerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  // Prefer the LIVE pre-fetched dossier (refreshed by router.refresh after
  // actions) and fall back to the action-fetched copy for older rows.
  const selectedDossier = selectedId
    ? dossierById.get(selectedId) ?? fallbackDossier
    : null;
  const selectedItem = selectedId ? items.find((i) => i.device.id === selectedId) ?? null : null;

  const handleEmergencyLocate = async (deviceId: string, reason: string) => {
    setEmergencyBusy(true);
    try {
      return await emergencyLocateAction(deviceId, reason);
    } finally {
      setEmergencyBusy(false);
    }
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
            {filtered.length} of {items.length} · click a row for the full dossier
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
                  <th className="table-head">Parents / children</th>
                  <th className="table-head">Subscription</th>
                  <th className="table-head">Ends</th>
                  <th className="table-head">Custom words</th>
                  <th className="table-head">Last seen</th>
                  <th className="table-head">Quick actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {filtered.map((i) => (
                  <tr
                    key={i.device.id}
                    onClick={() => openDossier(i.device.id)}
                    className={clsx(
                      "cursor-pointer transition hover:bg-white/5",
                      selectedId === i.device.id && "bg-teal-soft/20",
                    )}
                    title="Open device dossier"
                  >
                    <td className="table-cell">
                      <p className="font-medium">{i.profile?.nickname ?? "—"}</p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {i.device.id.slice(0, 8)}…
                      </p>
                    </td>
                    <td className="table-cell text-xs uppercase tracking-wide text-slate-400">
                      {i.device.role}
                    </td>
                    <td className="table-cell">
                      {i.device.role === "Parent" ? (
                        i.children.length > 0 ? (
                          <div className="text-xs text-slate-300">
                            <p>
                              {i.children
                                .map((c) => c.nickname ?? c.fullName ?? "—")
                                .join(", ")}
                            </p>
                            <p className="text-[10px] text-slate-500">
                              monitors {i.children.length} child
                              {i.children.length > 1 ? "ren" : ""}
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )
                      ) : (
                        <div className="text-xs">
                          <span
                            className={clsx(
                              "rounded-full border px-2 py-0.5 font-semibold",
                              i.slotsUsed >= i.maxParentSlots
                                ? "border-amber-400/40 text-amber-300"
                                : "border-ink-line text-slate-300",
                            )}
                            title={
                              i.slotsUsed >= i.maxParentSlots
                                ? "At capacity — additional parents require a Slot Parent pack"
                                : undefined
                            }
                          >
                            {i.slotsUsed}/{i.maxParentSlots}
                          </span>
                          {i.parentLabels.length > 0 ? (
                            <p className="mt-0.5 text-[10px] text-slate-500">
                              {i.parentLabels.join(", ")}
                            </p>
                          ) : null}
                          {i.parentContact?.phone ? (
                            <p className="mt-0.5 flex items-center gap-1 text-[10px] text-teal">
                              <Phone size={9} /> {i.parentContact.phone}
                            </p>
                          ) : null}
                        </div>
                      )}
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
                        <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
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
                              onClick={() => setRevokeTarget(i)}
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

      {/* ── Row-click dossier — same shared panel as /admin/lookup ─────────── */}
      {selectedId ? (
        <div ref={drawerRef} className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-100">Device dossier</h2>
            <button
              type="button"
              onClick={() => {
                setSelectedId(null);
                setFallbackDossier(null);
              }}
              className="btn-ghost"
            >
              <X size={14} /> Close
            </button>
          </div>

          {loadingDossier && !selectedDossier ? (
            <Card>
              <div className="flex items-center gap-3 py-8 text-slate-400">
                <Loader2 size={18} className="animate-spin text-teal" />
                Loading device story…
              </div>
            </Card>
          ) : selectedDossier ? (
            <>
              {/* Entitlement actions for the selected child (same actions as the row). */}
              {selectedItem?.device.role === "Child" && selectedItem.subscription ? (
                <Card>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Entitlement actions
                    </span>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        runAction(() => extendTrialAction(selectedItem.device.id, 7))
                      }
                      className="btn-ghost"
                    >
                      <CalendarClock size={13} /> Extend +7 days
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        runAction(() => extendTrialAction(selectedItem.device.id, 30))
                      }
                      className="btn-ghost"
                    >
                      <CalendarClock size={13} /> Extend +30 days
                    </button>
                    {selectedItem.subscription.status !== "cancelled" ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => setRevokeTarget(selectedItem)}
                        className="btn-ghost text-rose-300 hover:border-rose-400/50 hover:text-rose-300"
                      >
                        <Ban size={13} /> Revoke plan
                      </button>
                    ) : null}
                  </div>
                </Card>
              ) : null}

              <DeviceDossierPanel
                dossier={selectedDossier}
                dashboardOwner={dashboardOwner}
                onPurge={(d) => setPurgeTarget(d)}
                onEmergencyLocate={handleEmergencyLocate}
                emergencyBusy={emergencyBusy}
              />
            </>
          ) : (
            <Card>
              <EmptyState>Device not found.</EmptyState>
            </Card>
          )}
        </div>
      ) : null}

      {/* Revoke is irreversible from the dashboard — confirm explicitly. */}
      {revokeTarget ? (
        <ConfirmDialog
          open
          tone="danger"
          busy={pending}
          title="Revoke this plan?"
          body={
            <span>
              The plan for{' '}
              <strong>
                {revokeTarget.profile?.nickname ?? revokeTarget.device.id}
              </strong>{' '}
              will be cancelled and the child&apos;s devices will lock on their
              next sync. This cannot be undone from the dashboard — a new
              purchase is required to restore access.
            </span>
          }
          confirmLabel="Revoke plan"
          onCancel={() => setRevokeTarget(null)}
          onConfirm={() => {
            const target = revokeTarget;
            setRevokeTarget(null);
            runAction(() => revokePlanAction(target.device.id));
          }}
        />
      ) : null}

      {/* Purge (Owner-only, audited) — same semantics as on /admin/lookup. */}
      {purgeTarget ? (
        <ConfirmDialog
          open
          tone="danger"
          busy={purgePending}
          title="Purge all location data?"
          body={
            <span>
              Every GPS history row and the live coordinates of{" "}
              <strong>
                {purgeTarget.profile?.nickname ?? purgeTarget.device.id}
              </strong>{" "}
              will be permanently deleted (privacy / data-deletion request).
              The child&apos;s map simply shows “no location yet” afterwards.
              This action is logged in the audit trail.
            </span>
          }
          confirmLabel="Purge location data"
          onCancel={() => setPurgeTarget(null)}
          onConfirm={() => {
            const target = purgeTarget;
            setPurgeTarget(null);
            startPurge(async () => {
              const res = await purgeDeviceLocationsAction(target.device.id);
              showToast(res.message);
              router.refresh();
            });
          }}
        />
      ) : null}

      {toast ? (
        <div className="fixed bottom-6 right-6 z-50 max-w-md rounded-xl border border-teal/40 bg-ink-card px-4 py-3 text-sm text-slate-100 shadow-glass">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
