"use client";

import { useState, useTransition } from "react";
import { Save, Power, BadgeCheck, Users } from "lucide-react";
import type { PlanRow } from "@/lib/types";
import type { SubOverviewItem } from "@/lib/subscriptions";
import {
  Card,
  EmptyState,
  SubscriptionBadge,
  fmtDate,
  fmtIDR,
} from "@/components/ui";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  upsertPlanAction,
  togglePlanActiveAction,
  markRoyaltyPaidAction,
} from "./actions";
import type { RoyaltyRecord } from "@/lib/analytics";

type PlanDraft = {
  id?: string;
  name: string;
  description: string;
  /** "combo" = subscription time · "slots" = one-time parent-slot pack. */
  kind: "combo" | "slots";
  duration_months: number;
  slot_count: number;
  price: string;
};

const EMPTY_DRAFT: PlanDraft = {
  name: "",
  description: "",
  kind: "combo",
  duration_months: 1,
  slot_count: 1,
  price: "",
};

export default function AdminPlansPanel({
  plans,
  items,
  royaltyHistory,
  dashboardOwner,
}: {
  plans: PlanRow[];
  items: SubOverviewItem[];
  /** Monthly royalty rows + their settlement state (lib/royalty.ts). */
  royaltyHistory: RoyaltyRecord[];
  /** Viewer is the Owner — settlements & pricing are Owner-only. */
  dashboardOwner: boolean;
}) {
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_DRAFT);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [hideTarget, setHideTarget] = useState<PlanRow | null>(null);
  const [savingMonth, setSavingMonth] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => {
    startTransition(async () => {
      const res = await fn();
      setToast(res.message);
      setTimeout(() => setToast(null), 4000);
    });
  };

  const savePlan = () => {
    const price = Number(draft.price);
    run(async () =>
      upsertPlanAction({
        id: draft.id,
        name: draft.name,
        description: draft.description || null,
        kind: draft.kind,
        duration_months: draft.duration_months,
        slot_count: draft.kind === "slots" ? draft.slot_count : null,
        price: Number.isFinite(price) ? price : -1,
        currency: "IDR",
      }),
    );
    setDraft(EMPTY_DRAFT);
  };

  const downloadStatement = (r: RoyaltyRecord) => {
    const lines = [
      `Sensoria Developer Royalty Statement — ${r.monthKey}`,
      `Gross realized revenue (paid transactions), IDR,"${Math.round(r.revenue)}"`,
      `Refunded (money returned to customers), IDR,"${Math.round(r.refunded)}"`,
      `Net realized revenue, IDR,"${Math.round(r.net)}"`,
      `Royalty rate,10%`,
      `Royalty payable, IDR,"${Math.round(r.royalty)}"`,
      `Settlement status,${r.settlementStatus === "paid" ? "PAID" : "DUE"}`,
      r.settlementPaidAt ? `Paid at,"${r.settlementPaidAt}"` : null,
      r.settlementProofUrl ? `Proof,${r.settlementProofUrl}` : null,
    ].filter(Boolean);
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sensoria-royalty-${r.monthKey}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <Card title={draft.id ? "Edit plan" : "Create plan"}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            placeholder="Plan name"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="glass-input"
          />
          <select
            value={draft.kind}
            onChange={(e) =>
              setDraft({ ...draft, kind: e.target.value as PlanDraft["kind"] })
            }
            className="glass-input"
          >
            <option value="combo" className="bg-ink-card">
              Combo subscription (recurring time)
            </option>
            <option value="slots" className="bg-ink-card">
              Parent-slot pack (one-time, permanent)
            </option>
          </select>
          {draft.kind === "combo" ? (
            <select
              value={draft.duration_months}
              onChange={(e) =>
                setDraft({ ...draft, duration_months: Number(e.target.value) })
              }
              className="glass-input"
            >
              {[1, 6, 12].map((m) => (
                <option key={m} value={m} className="bg-ink-card">
                  {m} month{m > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          ) : (
            <select
              value={draft.slot_count}
              onChange={(e) =>
                setDraft({ ...draft, slot_count: Number(e.target.value) })
              }
              className="glass-input"
            >
              {[1, 2].map((n) => (
                <option key={n} value={n} className="bg-ink-card">
                  +{n} parent slot{n > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          )}
          <input
            placeholder="Price (IDR)"
            inputMode="numeric"
            value={draft.price}
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            className="glass-input"
          />
          <input
            placeholder="Description (optional)"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            className="glass-input"
          />
        </div>
        <div className="mt-4 flex gap-2">
          <p className="sm:col-span-2 lg:col-span-4 text-xs text-slate-500">
            {draft.kind === "slots"
              ? "Slot packs are ONE-TIME permanent purchases — the QRIS backend calls apply_parent_slot_purchase() after payment, max_parent_slots rises and never expires. Revenue flows through the same ledger, royalty and refund pipeline."
              : "Combo plans stack onto the child's current end date (30.4375-day months, same rule as the mobile preview)."}
          </p>
        </div>
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={savePlan} disabled={pending} className="btn-teal">
            <Save size={14} /> {draft.id ? "Save changes" : "Create plan"}
          </button>
          {draft.id ? (
            <button
              type="button"
              onClick={() => setDraft(EMPTY_DRAFT)}
              className="btn-ghost"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </Card>

      <Card title="Plans & pricing">
        {plans.length === 0 ? (
          <EmptyState>No plans yet — create the first one above.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-ink-line">
              <thead>
                <tr>
                  <th className="table-head">Name</th>
                  <th className="table-head">Type</th>
                  <th className="table-head">Price</th>
                  <th className="table-head">Status</th>
                  <th className="table-head">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {plans.map((p) => (
                  <tr key={p.id} className="hover:bg-white/5">
                    <td className="table-cell">
                      <p className="font-medium">{p.name}</p>
                      {p.description ? (
                        <p className="text-xs text-slate-500">{p.description}</p>
                      ) : null}
                    </td>
                    <td className="table-cell">
                      {p.kind === "slots" ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal">
                          <Users size={12} /> +{p.slot_count ?? 1} slot
                          {(p.slot_count ?? 1) > 1 ? "s" : ""} · one-time
                        </span>
                      ) : (
                        <span className="text-xs text-slate-300">
                          {p.duration_months} mo subscription
                        </span>
                      )}
                    </td>
                    <td className="table-cell">{fmtIDR(Number(p.price))}</td>
                    <td className="table-cell">
                      <span
                        className={
                          p.is_active
                            ? "text-xs font-semibold text-emerald-300"
                            : "text-xs font-semibold text-slate-500"
                        }
                      >
                        {p.is_active ? "active" : "hidden"}
                      </span>
                    </td>
                    <td className="table-cell">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setDraft({
                              id: p.id,
                              name: p.name,
                              description: p.description ?? "",
                              kind: p.kind ?? "combo",
                              duration_months: p.duration_months,
                              slot_count: p.slot_count ?? 1,
                              price: String(p.price),
                            })
                          }
                          className="btn-ghost"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            p.is_active ? setHideTarget(p) : run(() => togglePlanActiveAction(p.id, true))
                          }
                          className="btn-ghost"
                        >
                          <Power size={13} /> {p.is_active ? "Hide" : "Enable"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Developer royalty ledger (10% of net realized revenue)"
        action={
          <span className="text-[11px] uppercase tracking-wider text-slate-500">
            {dashboardOwner ? "Owner settles monthly" : "read-only"}
          </span>
        }
      >
        {royaltyHistory.length === 0 ? (
          <EmptyState>
            No realized revenue yet — royalty rows appear after the first paid
            transaction.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-ink-line">
              <thead>
                <tr>
                  <th className="table-head">Month</th>
                  <th className="table-head">Gross</th>
                  <th className="table-head">Refunded</th>
                  <th className="table-head">Net</th>
                  <th className="table-head">Royalty (10%)</th>
                  <th className="table-head">Settlement</th>
                  <th className="table-head">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {royaltyHistory.map((r) => {
                  const isPaid = r.settlementStatus === "paid";
                  return (
                    <tr key={r.monthKey} className="hover:bg-white/5">
                      <td className="table-cell font-medium">{r.monthKey}</td>
                      <td className="table-cell">{fmtIDR(r.revenue)}</td>
                      <td className="table-cell text-violet-300">
                        {r.refunded > 0 ? `−${fmtIDR(r.refunded)}` : "—"}
                      </td>
                      <td className="table-cell">{fmtIDR(r.net)}</td>
                      <td className="table-cell font-semibold text-teal">
                        {fmtIDR(r.royalty)}
                      </td>
                      <td className="table-cell">
                        {isPaid ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-300">
                            <BadgeCheck size={13} /> paid
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-amber-300">due</span>
                        )}
                      </td>
                      <td className="table-cell">
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => downloadStatement(r)}
                            className="btn-ghost text-xs"
                            title="Download CSV statement"
                          >
                            Statement
                          </button>
                          {dashboardOwner && !isPaid ? (
                            <button
                              type="button"
                              disabled={pending || savingMonth === r.monthKey}
                              onClick={() => {
                                setSavingMonth(r.monthKey);
                                run(async () => {
                                  const res = await markRoyaltyPaidAction(
                                    r.monthKey,
                                    r.royalty,
                                  );
                                  setSavingMonth(null);
                                  return res;
                                });
                              }}
                              className="btn-ghost text-xs text-emerald-300"
                              title="Mark this month as settled to the developer"
                            >
                              Mark paid
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Royalty counts only <strong>paid</strong> money, minus refunds —
          pending or failed transactions are never royalty-eligible. “Statement”
          downloads the monthly CSV breakdown as settlement proof.
        </p>
      </Card>

      <Card title="Current subscriptions — stacking preview (+1 month)">
        {items.length === 0 ? (
          <EmptyState>No subscription rows yet.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-ink-line">
              <thead>
                <tr>
                  <th className="table-head">Child</th>
                  <th className="table-head">Status</th>
                  <th className="table-head">Plan</th>
                  <th className="table-head">Current end</th>
                  <th className="table-head">If +1 month stacked now</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {items.map((s) => (
                  <tr key={s.subscription.id} className="hover:bg-white/5">
                    <td className="table-cell">
                      <p className="font-medium">{s.childNickname ?? "—"}</p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {s.subscription.child_device_id.slice(0, 8)}…
                      </p>
                    </td>
                    <td className="table-cell">
                      <SubscriptionBadge status={s.subscription.status} />
                    </td>
                    <td className="table-cell text-xs">
                      {s.planName ?? "—"}
                      {s.planPrice ? (
                        <span className="text-slate-500"> · {fmtIDR(s.planPrice)}</span>
                      ) : null}
                    </td>
                    <td className="table-cell text-xs text-slate-400">
                      {fmtDate(
                        s.subscription.status === "trial"
                          ? s.subscription.trial_ends_at
                          : s.subscription.expires_at,
                      )}
                    </td>
                    <td className="table-cell text-xs text-teal">
                      {s.projectedIfPlusOneMonth
                        ? fmtDate(s.projectedIfPlusOneMonth)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {hideTarget ? (
        <ConfirmDialog
          open
          tone="danger"
          busy={pending}
          title="Hide this plan?"
          body={
            <span>
              <strong>{hideTarget.name}</strong> disappears from the paywall
              immediately. Existing subscriptions are unaffected; re-enable it
              any time.
            </span>
          }
          confirmLabel="Hide plan"
          onCancel={() => setHideTarget(null)}
          onConfirm={() => {
            const target = hideTarget;
            setHideTarget(null);
            run(() => togglePlanActiveAction(target.id, false));
          }}
        />
      ) : null}

      {toast ? (
        <div className="fixed bottom-6 right-6 z-50 rounded-xl border border-teal/40 bg-ink-card px-4 py-3 text-sm text-slate-100 shadow-glass">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
