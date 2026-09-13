"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Search, Loader2 } from "lucide-react";
import clsx from "clsx";
import { Card, EmptyState, fmtDate } from "@/components/ui";
import ConfirmDialog from "@/components/ConfirmDialog";
import DeviceDossierPanel from "@/components/DeviceDossierPanel";
import {
  searchDevicesAction,
  getDeviceDossierAction,
  purgeDeviceLocationsAction,
  emergencyLocateAction,
} from "./actions";
import type { LookupResultItem, DeviceDossier } from "@/lib/lookup";

export default function LookupClient({ dashboardOwner }: { dashboardOwner: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dossier, setDossier] = useState<DeviceDossier | null>(null);
  const [loadingDossier, setLoadingDossier] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<DeviceDossier | null>(null);
  const [purgePending, startPurge] = useTransition();
  const [emergencyBusy, setEmergencyBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    searchDevicesAction(trimmed)
      .then(setResults)
      .finally(() => setSearching(false));
  }, []);

  // Debounced live search — 350ms after the last keystroke.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(query), 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  const selectDevice = useCallback((deviceId: string) => {
    setSelectedId(deviceId);
    setDossier(null);
    setLoadingDossier(true);
    getDeviceDossierAction(deviceId)
      .then(setDossier)
      .finally(() => setLoadingDossier(false));
  }, []);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 6000);
  };

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
      {/* Search box */}
      <Card>
        <div className="relative">
          <Search size={16} className="absolute left-3.5 top-3.5 text-slate-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Pairing code, device id, child nickname, or full name…"
            className="glass-input w-full pl-10"
            autoFocus
          />
          {searching ? (
            <Loader2 size={16} className="absolute right-3.5 top-3.5 animate-spin text-teal" />
          ) : null}
        </div>
        {query.trim().length > 0 && query.trim().length < 2 ? (
          <p className="mt-2 text-xs text-slate-500">Type at least 2 characters.</p>
        ) : null}
      </Card>

      {/* Result cards */}
      {results.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {results.map((r) => (
            <button
              key={r.deviceId}
              type="button"
              onClick={() => selectDevice(r.deviceId)}
              className={clsx(
                "glass-card p-4 text-left transition hover:border-teal/40",
                selectedId === r.deviceId && "border-teal/60 bg-teal-soft/30",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold text-slate-100">
                  {r.role === "Parent"
                    ? (r.contact?.name ?? "Parent device")
                    : (r.nickname ?? r.fullName ?? "Unnamed child")}
                </p>
                <span className="rounded-full border border-ink-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {r.role}
                </span>
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-500">
                {r.pairingCode ?? r.deviceId.slice(0, 8)}
              </p>
              <p className="mt-2 truncate text-xs text-slate-400">
                {r.lastAddress ?? "No location recorded"}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                last seen {fmtDate(r.lastSeen)} · matched on {r.matchOn.replaceAll("_", " ")}
              </p>
            </button>
          ))}
        </div>
      ) : null}

      {/* Dossier — THE shared panel (identical to the Devices row-click view). */}
      {selectedId && loadingDossier && !dossier ? (
        <Card>
          <div className="flex items-center gap-3 py-8 text-slate-400">
            <Loader2 size={18} className="animate-spin text-teal" />
            Loading device story…
          </div>
        </Card>
      ) : null}

      {selectedId && dossier ? (
        <DeviceDossierPanel
          dossier={dossier}
          dashboardOwner={dashboardOwner}
          onPurge={(d) => setPurgeTarget(d)}
          onEmergencyLocate={handleEmergencyLocate}
          emergencyBusy={emergencyBusy}
        />
      ) : null}

      {/* Purge confirmation */}
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
              if (res.ok) selectDevice(target.device.id); // refresh dossier
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
