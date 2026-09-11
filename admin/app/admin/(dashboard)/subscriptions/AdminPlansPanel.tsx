"use client";

import { useState, useTransition } from "react";
import { Save, Power } from "lucide-react";
import type { PlanRow } from "@/lib/types";
import type { SubOverviewItem } from "@/lib/subscriptions";
import {
  Card,
  EmptyState,
  SubscriptionBadge,
  fmtDate,
  fmtIDR,
} from "@/components/ui";
import { upsertPlanAction, togglePlanActiveAction } from "./actions";

type PlanDraft = {
  id?: string;
  name: string;
  description: string;
  duration_months: number;
  price: string;
};

const EMPTY_DRAFT: PlanDraft = {
  name: "",
  description: "",
  duration_months: 1,
  price: "",
};

export default function AdminPlansPanel({
  plans,
  items,
}: {
  plans: PlanRow[];
  items: SubOverviewItem[];
}) {
  const [draft, setDraft] = useState<PlanDraft>(EMPTY_DRAFT);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
        duration_months: draft.duration_months,
        price: Number.isFinite(price) ? price : -1,
        currency: "IDR",
      }),
    );
    setDraft(EMPTY_DRAFT);
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
                  <th className="table-head">Duration</th>
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
                    <td className="table-cell">{p.duration_months} mo</td>
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
                              duration_months: p.duration_months,
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
                            run(() => togglePlanActiveAction(p.id, !p.is_active))
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

      {toast ? (
        <div className="fixed bottom-6 right-6 z-50 rounded-xl border border-teal/40 bg-ink-card px-4 py-3 text-sm text-slate-100 shadow-glass">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
