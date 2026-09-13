"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Smartphone,
  Users,
  MapPin,
  CreditCard,
  RefreshCw,
  Eraser,
  Crosshair,
  Loader2,
  Phone,
  Plus,
  Pencil,
} from "lucide-react";
import clsx from "clsx";
import {
  Card,
  EmptyState,
  SubscriptionBadge,
  fmtDate,
  fmtIDR,
} from "@/components/ui";
import DeviceMap from "@/components/DeviceMap";
import ConfirmDialog from "@/components/ConfirmDialog";
import type {
  DeviceDossier,
  TimelineTone,
  EmergencyLocation,
} from "@/lib/lookup";
import {
  updateParentContactAction,
  grantParentSlotAction,
} from "@/app/admin/(dashboard)/lookup/actions";

/**
 * DeviceDossierPanel — THE shared device-detail view.
 *
 * Rendered by TWO pages against the exact same component and data shape:
 *   • /admin/lookup  — search result → dossier
 *   • /admin/devices — table row click → dossier (no re-search needed)
 *
 * PRIVACY: the dossier data carries addresses only — raw GPS coordinates
 * are structurally absent (see lib/lookup.ts). Coordinates appear solely in
 * the Owner-initiated emergency map dialog, which the host page wires in
 * through the `onEmergencyLocate` prop (audited, reason mandatory).
 */

const TONE_DOT: Record<TimelineTone, string> = {
  good: "bg-emerald-400",
  warn: "bg-amber-400",
  bad: "bg-rose-400",
  neutral: "bg-slate-500",
  teal: "bg-teal",
  violet: "bg-violet-400",
};

const KIND_ICON = {
  subscription: RefreshCw,
  transaction: CreditCard,
  location: MapPin,
  family: Users,
} as const;

/** Manual "+1 slot" grant cap — beyond this, point admins at slot packs. */
const MAX_GRANTABLE_SLOTS = 3;

export default function DeviceDossierPanel({
  dossier,
  dashboardOwner,
  onPurge,
  onEmergencyLocate,
  emergencyBusy = false,
}: {
  dossier: DeviceDossier;
  dashboardOwner: boolean;
  /** Wire the host page's purge confirm dialog (Lookup) or omit it (Devices — purge lives in Lookup). */
  onPurge?: (dossier: DeviceDossier) => void;
  /** When provided, the Owner gets the audited EMERGENCY locate button.
   *  Returns the fix — or null when there is no fix / access was denied. */
  onEmergencyLocate?: (
    deviceId: string,
    reason: string,
  ) => Promise<EmergencyLocation | null>;
  emergencyBusy?: boolean;
}) {
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [emergencyError, setEmergencyError] = useState<string | null>(null);
  /** The last successful emergency fix — rendered as a map card until this
   *  panel unmounts (device switch, navigation away, …). */
  const [emergencyFix, setEmergencyFix] = useState<EmergencyLocation | null>(null);

  const router = useRouter();
  const [busy, startBusy] = useTransition();
  /** Per-parent contact drafts, keyed by parent device id (presence = edit mode). */
  const [contactDrafts, setContactDrafts] = useState<
    Record<string, { name: string; phone: string }>
  >({});
  const [contactBusyFor, setContactBusyFor] = useState<string | null>(null);
  const [contactMsg, setContactMsg] = useState<string | null>(null);
  /** +1 slot confirm (Owner-only). */
  const [grantSlotOpen, setGrantSlotOpen] = useState(false);

  const saveContact = (parentDeviceId: string) => {
    const draft = contactDrafts[parentDeviceId];
    if (!draft) return;
    setContactBusyFor(parentDeviceId);
    startBusy(async () => {
      const res = await updateParentContactAction(parentDeviceId, {
        name: draft.name,
        phone: draft.phone,
      });
      setContactBusyFor(null);
      setContactMsg(res.ok ? "Contact saved." : res.message);
      if (res.ok) {
        setContactDrafts((d) => {
          const next = { ...d };
          delete next[parentDeviceId];
          return next;
        });
        router.refresh();
      }
    });
  };

  const grantSlot = () => {
    setGrantSlotOpen(false);
    startBusy(async () => {
      const res = await grantParentSlotAction(dossier.device.id, 1);
      setContactMsg(res.message);
      if (res.ok) router.refresh();
    });
  };

  const submitEmergency = async () => {
    if (!onEmergencyLocate) return;
    const trimmed = reason.trim();
    if (!trimmed) {
      setEmergencyError("A reason is required — this access is audited.");
      return;
    }
    const fix = await onEmergencyLocate(dossier.device.id, trimmed);
    if (fix) {
      setEmergencyFix(fix);
      setEmergencyOpen(false);
      setEmergencyError(null);
    } else {
      setEmergencyError("No fix available for this device — or access was denied.");
    }
  };

  return (
    <div className="space-y-6">
      {/* Device header */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-50">
              <Smartphone size={18} className="text-teal" />
              {dossier.profile?.nickname ??
              dossier.profile?.fullName ??
              (dossier.device.role === "Parent" ? "Parent device" : "Unnamed child")}
              {dossier.device.role === "Child" ? (
                <SubscriptionBadge
                  status={dossier.currentSubscription?.status ?? "expired"}
                />
              ) : (
                <span className="rounded-full border border-ink-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  parent device
                </span>
              )}
            </h2>
            <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="text-slate-500">Device</dt>
                <dd className="font-mono text-xs text-slate-300">{dossier.device.id}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">Pairing</dt>
                <dd className="font-mono text-xs text-slate-300">
                  {dossier.device.pairingCode ?? "—"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-slate-500">
                  {dossier.device.role === "Child" ? "Parent slots" : "Children"}
                </dt>
                <dd className="flex items-center gap-1 text-xs text-slate-300">
                  <Users size={12} className="text-slate-500" />
                  {dossier.device.role === "Child"
                    ? `${dossier.parentDetails.length}/${dossier.device.maxParentSlots}`
                    : dossier.linkedChildren.length > 0
                      ? `${dossier.linkedChildren.length} linked`
                      : "—"}
                </dd>
              </div>
              {dossier.ownContact?.phone ? (
                <div className="flex gap-2">
                  <dt className="text-slate-500">Contact</dt>
                  <dd className="flex items-center gap-1 text-xs text-slate-300">
                    <Phone size={12} className="text-slate-500" />{" "}
                    {dossier.ownContact.phone}
                  </dd>
                </div>
              ) : null}
              <div className="flex gap-2">
                <dt className="text-slate-500">Last seen</dt>
                <dd className="text-xs text-slate-300">{fmtDate(dossier.device.lastSeen)}</dd>
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <dt className="text-slate-500">Last address</dt>
                <dd className="text-xs text-slate-300">
                  {dossier.device.lastAddress ?? "—"}
                </dd>
              </div>
            </dl>
          </div>
          {dashboardOwner ? (
            <div className="flex shrink-0 flex-col gap-2">
              {dossier.device.role === "Child" ? (
                <button
                  type="button"
                  onClick={() => setGrantSlotOpen(true)}
                  disabled={dossier.device.maxParentSlots >= MAX_GRANTABLE_SLOTS || busy}
                  className="btn-ghost"
                  title={
                    dossier.device.maxParentSlots >= MAX_GRANTABLE_SLOTS
                      ? "Slot packs are the supported way past 3 slots"
                      : "Manually grant one extra parent slot (audited)"
                  }
                >
                  <Plus size={14} /> Grant +1 slot
                </button>
              ) : null}
              {dossier.device.role === "Parent" ? (
                <button
                  type="button"
                  onClick={() =>
                    setContactDrafts((d) => ({
                      ...d,
                      [dossier.device.id]: {
                        name:
                          d[dossier.device.id]?.name ?? dossier.ownContact?.name ?? "",
                        phone:
                          d[dossier.device.id]?.phone ?? dossier.ownContact?.phone ?? "",
                      },
                    }))
                  }
                  className="btn-ghost"
                >
                  <Pencil size={14} /> Contact
                </button>
              ) : null}
              {onEmergencyLocate ? (
                <button
                  type="button"
                  onClick={() => {
                    setEmergencyOpen(true);
                    setEmergencyError(null);
                  }}
                  className="btn-ghost text-teal hover:border-teal/50"
                  title="Open an emergency, audited location check (missing child, safety)"
                >
                  <Crosshair size={14} /> Emergency locate
                </button>
              ) : null}
              {onPurge ? (
                <button
                  type="button"
                  onClick={() => onPurge(dossier)}
                  className="btn-ghost text-rose-300 hover:border-rose-400/50"
                  title="Erase all location data of this child (privacy request)"
                >
                  <Eraser size={14} /> Purge locations
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {dossier.currentSubscription ? (
          <p className="mt-4 rounded-xl border border-ink-line bg-ink-soft/60 px-3 py-2 text-xs text-slate-400">
            Current plan:{" "}
            <strong className="text-slate-200">
              {dossier.currentSubscription.planName ?? "trial"}
            </strong>{" "}
            · started {fmtDate(dossier.currentSubscription.startsAt)} · ends{" "}
            {fmtDate(dossier.currentSubscription.endsAt)}
          </p>
        ) : null}
      </Card>

      {/* ── Family: THE answer to "who is linked, and how do I reach them?" ── */}
      <Card
        title={
          dossier.device.role === "Child"
            ? `Linked parents — ${dossier.parentDetails.length}/${dossier.device.maxParentSlots} slots used`
            : "Linked children"
        }
      >
        {dossier.device.role === "Child" ? (
          <>
            {!dossier.contactsAvailable ? (
              <p className="mb-3 rounded-xl border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/80">
                Contact registry not migrated yet — parent device identity is
                shown below, phone numbers appear after running
                20260913_parent_contacts.sql.
              </p>
            ) : null}
            {dossier.parentDetails.length === 0 ? (
              <EmptyState>No parent devices linked to this child.</EmptyState>
            ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {dossier.parentDetails.map((p) => {
                const draft = contactDrafts[p.parentDeviceId];
                const editing = draft !== undefined;
                return (
                  <div
                    key={p.parentDeviceId}
                    className="rounded-2xl border border-ink-line bg-ink-soft/50 p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                          <Users size={13} className="text-teal" />
                          {p.contactName ?? p.label ?? "Parent"}
                          {p.label ? (
                            <span className="rounded-full border border-ink-line px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                              {p.label}
                            </span>
                          ) : null}
                        </p>
                        <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-slate-500">
                          <Smartphone size={11} />
                          parent device {p.parentPairingCode ?? p.parentDeviceId.slice(0, 8)}
                        </p>
                      </div>
                      {dashboardOwner && !editing ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() =>
                            setContactDrafts((d) => ({
                              ...d,
                              [p.parentDeviceId]: {
                                name: d[p.parentDeviceId]?.name ?? p.contactName ?? "",
                                phone: d[p.parentDeviceId]?.phone ?? p.contactPhone ?? "",
                              },
                            }))
                          }
                        >
                          <Pencil size={13} /> Edit
                        </button>
                      ) : null}
                    </div>
                    <p className="mt-2 flex items-center gap-1.5 text-xs">
                      <Phone size={12} className="text-slate-500" />
                      {p.contactPhone ? (
                        <a
                          href={`tel:${p.contactPhone.replace(/[^+\\d]/g, "")}`}
                          className="font-semibold text-teal hover:underline"
                        >
                          {p.contactPhone}
                        </a>
                      ) : (
                        <span className="text-slate-500">
                          No phone on file — ask the family, or add it here.
                        </span>
                      )}
                    </p>
                    {editing ? (
                      <div className="mt-3 space-y-2">
                        <input
                          value={draft.name}
                          onChange={(e) =>
                            setContactDrafts((d) => ({
                              ...d,
                              [p.parentDeviceId]: { ...draft, name: e.target.value },
                            }))
                          }
                          placeholder="Parent name (e.g. Ibu Ratna)"
                          className="glass-input w-full"
                        />
                        <input
                          value={draft.phone}
                          onChange={(e) =>
                            setContactDrafts((d) => ({
                              ...d,
                              [p.parentDeviceId]: { ...draft, phone: e.target.value },
                            }))
                          }
                          placeholder="Phone / WhatsApp (e.g. +62…)"
                          inputMode="tel"
                          className="glass-input w-full"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={contactBusyFor === p.parentDeviceId}
                            onClick={() => saveContact(p.parentDeviceId)}
                          >
                            {contactBusyFor === p.parentDeviceId ? (
                              <Loader2 size={13} className="animate-spin" />
                            ) : null}
                            Save contact
                          </button>
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={() =>
                              setContactDrafts((d) => {
                                const next = { ...d };
                                delete next[p.parentDeviceId];
                                return next;
                              })
                            }
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            )}
          </>
        ) : (
          <div className="space-y-4">
            {dashboardOwner && contactDrafts[dossier.device.id] ? (
              <div className="rounded-2xl border border-teal/30 bg-ink-soft/50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  This parent&apos;s contact card
                </p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    value={contactDrafts[dossier.device.id].name}
                    onChange={(e) =>
                      setContactDrafts((d) => ({
                        ...d,
                        [dossier.device.id]: {
                          ...d[dossier.device.id],
                          name: e.target.value,
                        },
                      }))
                    }
                    placeholder="Parent name (e.g. Ibu Ratna)"
                    className="glass-input w-full"
                  />
                  <input
                    value={contactDrafts[dossier.device.id].phone}
                    onChange={(e) =>
                      setContactDrafts((d) => ({
                        ...d,
                        [dossier.device.id]: {
                          ...d[dossier.device.id],
                          phone: e.target.value,
                        },
                      }))
                    }
                    placeholder="Phone / WhatsApp (e.g. +62…)"
                    inputMode="tel"
                    className="glass-input w-full"
                  />
                </div>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={contactBusyFor === dossier.device.id}
                    onClick={() => saveContact(dossier.device.id)}
                  >
                    {contactBusyFor === dossier.device.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : null}
                    Save contact
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() =>
                      setContactDrafts((d) => {
                        const next = { ...d };
                        delete next[dossier.device.id];
                        return next;
                      })
                    }
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {dossier.linkedChildren.length === 0 ? (
              <EmptyState>This parent device is not linked to any child.</EmptyState>
            ) : (
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {dossier.linkedChildren.map((c) => (
                  <div
                    key={c.deviceId}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-ink-line bg-ink-soft/50 p-4"
                  >
                    <div>
                      <p className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                        <MapPin size={13} className="text-teal" />
                        {c.nickname ?? c.fullName ?? "Unnamed child"}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-slate-500">
                        pairing {c.pairingCode ?? "—"} · seen {fmtDate(c.lastSeen)}
                      </p>
                    </div>
                    {c.subscriptionStatus ? (
                      <SubscriptionBadge status={c.subscriptionStatus} />
                    ) : (
                      <span className="text-xs text-slate-500">no sub</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {contactMsg ? (
          <p className="mt-3 rounded-xl border border-ink-line bg-ink-soft/60 px-3 py-2 text-xs text-slate-300">
            {contactMsg}
          </p>
        ) : null}
      </Card>

      {/* Emergency fix — disappears when this panel unmounts (device switch / navigation). */}
      {emergencyFix ? (
        <Card title="Emergency fix — live map (audited Owner access)">
          <DeviceMap lat={emergencyFix.lat} lng={emergencyFix.lng} height={320} />
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-400">
            <span>
              <strong className="text-slate-200">
                {emergencyFix.lat.toFixed(6)}, {emergencyFix.lng.toFixed(6)}
              </strong>{" "}
              (±{emergencyFix.accuracy ? `${Math.round(emergencyFix.accuracy)} m` : "unknown"} accuracy)
            </span>
            {emergencyFix.address ? <span>{emergencyFix.address}</span> : null}
            <span>
              {emergencyFix.source === "live" ? "live presence" : "last history ping"} ·{" "}
              {fmtDate(emergencyFix.recordedAt)}
            </span>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Timeline */}
        <Card title="Unified timeline" className="xl:col-span-2">
          {dossier.timeline.length === 0 ? (
            <EmptyState>Nothing recorded for this device yet.</EmptyState>
          ) : (
            <ol className="relative space-y-4 border-l border-ink-line pl-5">
              {dossier.timeline.map((t, i) => {
                const Icon = KIND_ICON[t.kind];
                return (
                  <li key={`${t.kind}-${t.at}-${i}`} className="relative">
                    <span
                      className={clsx(
                        "absolute -left-[27px] top-1 flex h-4 w-4 items-center justify-center rounded-full",
                        TONE_DOT[t.tone],
                      )}
                    >
                      <Icon size={9} className="text-ink" />
                    </span>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-200">{t.title}</p>
                      <p className="text-[11px] text-slate-500">{fmtDate(t.at)}</p>
                    </div>
                    {t.detail ? (
                      <p className="mt-0.5 text-xs text-slate-400">{t.detail}</p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        {/* Side column: recent addresses + quick payment list */}
        <div className="space-y-6">
          <Card title="Recent locations (privacy-safe)">
            {!dossier.locationsAvailable ? (
              <EmptyState>
                locations table not present on this deployment.
              </EmptyState>
            ) : dossier.recentAddresses.length === 0 ? (
              <EmptyState>No location pings recorded (or already purged).</EmptyState>
            ) : (
              <ul className="space-y-2 text-xs">
                {dossier.recentAddresses.map((l, i) => (
                  <li
                    key={`${l.recordedAt}-${i}`}
                    className="flex items-start gap-2 rounded-xl border border-ink-line bg-ink-soft/50 p-2.5"
                  >
                    <MapPin size={12} className="mt-0.5 shrink-0 text-slate-500" />
                    <div>
                      <p className="text-slate-300">{l.address ?? "(no address resolved)"}</p>
                      <p className="text-[10px] text-slate-500">{fmtDate(l.recordedAt)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-[10px] leading-relaxed text-slate-500">
              Addresses only — raw GPS coordinates are never shown in the
              dashboard and are purged automatically after 30 days. Owners can
              run a single audited emergency check when a child&apos;s safety
              requires it.
            </p>
          </Card>

          <Card title="Payments">
            {dossier.transactions.length === 0 ? (
              <EmptyState>No transactions yet.</EmptyState>
            ) : (
              <ul className="space-y-2 text-xs">
                {dossier.transactions.slice(0, 8).map((t) => (
                  <li
                    key={t.ref}
                    className="rounded-xl border border-ink-line bg-ink-soft/50 p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-slate-500">
                        {t.ref.slice(0, 12)}…
                      </span>
                      <span className="rounded-full border border-ink-line px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-400">
                        {t.status}
                      </span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2">
                      <span className="font-semibold text-slate-200">
                        {fmtIDR(t.amount)}
                      </span>
                      <span className="text-[10px] text-slate-500">
                        {fmtDate(t.paidAt ?? t.createdAt)}
                      </span>
                    </div>
                    {t.planKind === "slots" && t.status === "paid" ? (
                      <p className="mt-0.5 text-[10px] font-semibold text-teal">
                        parent-slot pack{t.slotCount ? ` (+${t.slotCount})` : ""}
                      </p>
                    ) : null}
                    {t.refundedTotal > 0 ? (
                      <p className="mt-0.5 text-[10px] text-violet-300">
                        refunded {fmtIDR(t.refundedTotal)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {/* EMERGENCY locate dialog — Owner-only, reason mandatory, audited. */}
      {emergencyOpen && onEmergencyLocate ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setEmergencyOpen(false)}
          role="presentation"
        >
          <div
            className="w-full max-w-md rounded-2xl border border-ink-line bg-ink-card p-6 shadow-glass"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3 className="flex items-center gap-2 text-base font-bold text-slate-50">
              <Crosshair size={16} className="text-teal" /> Emergency locate
            </h3>
            <p className="mt-1.5 text-sm text-slate-400">
              This reveals the raw GPS position of{" "}
              <strong className="text-slate-200">
                {dossier.profile?.nickname ?? dossier.device.id.slice(0, 8)}
              </strong>{" "}
              on a map. Use only for a genuine safety emergency (missing
              child, danger). The access — and this reason — is written to the
              audit log.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Parent reported child missing at 14:30, police report #1234"
              rows={3}
              className="glass-input mt-3 w-full resize-none"
              autoFocus
            />
            {emergencyError ? (
              <p className="mt-2 text-xs text-rose-300">{emergencyError}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setEmergencyOpen(false)}
                disabled={emergencyBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={submitEmergency}
                disabled={emergencyBusy || !reason.trim()}
              >
                {emergencyBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Crosshair size={14} />
                )}
                Show location
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* +1 slot grant — Owner-only, confirmed, audited (manual mercy path). */}
      {grantSlotOpen ? (
        <ConfirmDialog
          open
          busy={busy}
          title="Grant one extra parent slot?"
          body={
            <span>
              <strong>
                {dossier.profile?.nickname ?? dossier.device.id.slice(0, 8)}
              </strong>{' '}
              will accept {dossier.device.maxParentSlots + 1} linked parent
              devices. Families normally buy this as the &ldquo;Slot Parent +1&rdquo;
              pack (Rp 25.000) — use this grant only for support/compensation,
              it is written to the audit trail.
            </span>
          }
          confirmLabel="Grant +1 slot"
          onCancel={() => setGrantSlotOpen(false)}
          onConfirm={grantSlot}
        />
      ) : null}

    </div>
  );
}
