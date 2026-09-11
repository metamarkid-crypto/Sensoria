"use client";

import { useMemo, useState, useTransition } from "react";
import { Download, RefreshCw, X, Search } from "lucide-react";
import clsx from "clsx";
import type { TxListRow, TxStats } from "@/lib/transactions";
import {
  Card,
  EmptyState,
  StatCard,
  TransactionBadge,
  fmtDate,
  fmtIDR,
} from "@/components/ui";
import {
  overrideStatusAction,
  retrySettlementAction,
} from "./actions";

type StatusFilter = "all" | "pending" | "paid" | "failed";

export default function AdminTransactionsTable({
  rows,
  stats,
}: {
  rows: TxListRow[];
  stats: TxStats;
}) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<TxListRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (status !== "all" && r.status !== status) return false;
        if (dateFrom && r.created_at.slice(0, 10) < dateFrom) return false;
        if (search) {
          const q = search.toLowerCase();
          const hay = `${r.transaction_ref} ${r.child_device_id} ${r.plan_name ?? ""}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      }),
    [rows, status, dateFrom, search],
  );

  const exportCsv = () => {
    const header = "transaction_ref,child_device_id,plan,amount,currency,status,gateway,created_at,paid_at";
    const body = filtered
      .map((r) =>
        [
          r.transaction_ref,
          r.child_device_id,
          r.plan_name ?? "",
          r.amount,
          r.currency,
          r.status,
          r.payment_gateway,
          r.created_at,
          r.paid_at ?? "",
        ]
          .map((v) => `"${String(v).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sensoria-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runAction = (fn: () => Promise<{ message: string }>) => {
    startTransition(async () => {
      const res = await fn();
      setToast(res.message);
      setTimeout(() => setToast(null), 5000);
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="Pending" value={stats.pending} />
        <StatCard label="Paid" value={stats.paid} />
        <StatCard label="Failed" value={stats.failed} />
        <StatCard accent label="Settled volume" value={fmtIDR(stats.volumePaid)} />
      </div>

      <Card
        title="Transaction ledger"
        action={
          <button type="button" onClick={exportCsv} className="btn-ghost">
            <Download size={14} /> Export CSV
          </button>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-xl border border-ink-line p-1">
            {(["all", "pending", "paid", "failed"] as StatusFilter[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={clsx(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition",
                  status === s
                    ? "bg-teal-soft text-teal"
                    : "text-slate-400 hover:text-slate-200",
                )}
              >
                {s}
              </button>
            ))}
          </div>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="glass-input w-auto"
          />
          <div className="relative">
            <Search size={14} className="absolute left-3 top-2.5 text-slate-500" />
            <input
              placeholder="Search ref / device / plan"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="glass-input w-64 pl-8"
            />
          </div>
          <span className="ml-auto text-xs text-slate-500">
            {filtered.length} of {rows.length}
          </span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState>No transactions match the filters.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-ink-line">
              <thead>
                <tr>
                  <th className="table-head">Ref</th>
                  <th className="table-head">Device</th>
                  <th className="table-head">Plan</th>
                  <th className="table-head">Amount</th>
                  <th className="table-head">Status</th>
                  <th className="table-head">Created</th>
                  <th className="table-head">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-line">
                {filtered.map((r) => (
                  <tr key={r.id} className="hover:bg-white/5">
                    <td className="table-cell">
                      <button
                        type="button"
                        onClick={() => setSelected(r)}
                        className="font-mono text-xs text-teal hover:underline"
                      >
                        {r.transaction_ref}
                      </button>
                    </td>
                    <td className="table-cell font-mono text-xs text-slate-400">
                      {r.child_device_id.slice(0, 8)}…
                    </td>
                    <td className="table-cell">{r.plan_name ?? "—"}</td>
                    <td className="table-cell">{fmtIDR(r.amount)}</td>
                    <td className="table-cell">
                      <TransactionBadge status={r.status} />
                    </td>
                    <td className="table-cell text-xs text-slate-400">
                      {fmtDate(r.created_at)}
                    </td>
                    <td className="table-cell">
                      <div className="flex gap-2">
                        {r.status === "pending" ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              runAction(() => retrySettlementAction(r.transaction_ref))
                            }
                            className="btn-ghost"
                            title="Replay gateway settlement"
                          >
                            <RefreshCw size={13} /> Retry
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              runAction(() =>
                                overrideStatusAction(
                                  r.transaction_ref,
                                  r.status === "paid" ? "failed" : "paid",
                                ),
                              )
                            }
                            className="btn-ghost"
                          >
                            {r.status === "paid" ? "Mark failed" : "Mark paid"}
                          </button>
                        )}
                      </div>
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

      {/* Detail drawer — raw webhook payload inspection */}
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
              <h3 className="text-lg font-bold text-slate-50">Transaction detail</h3>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
              >
                <X size={18} />
              </button>
            </div>

            <dl className="space-y-3 text-sm">
              {[
                ["Reference", selected.transaction_ref],
                ["Device", selected.child_device_id],
                ["Plan", selected.plan_name ?? "—"],
                ["Amount", fmtIDR(selected.amount)],
                ["Status", selected.status],
                ["Gateway", selected.payment_gateway],
                ["Created", fmtDate(selected.created_at)],
                ["Paid at", fmtDate(selected.paid_at)],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="text-right font-medium text-slate-200">{v}</dd>
                </div>
              ))}
            </dl>

            <h4 className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wider text-slate-400">
              Raw webhook payload
            </h4>
            <pre className="max-h-96 overflow-auto rounded-xl border border-ink-line bg-ink/80 p-4 font-mono text-xs text-slate-300">
              {selected.raw_payload
                ? JSON.stringify(selected.raw_payload, null, 2)
                : "No payload stored for this transaction."}
            </pre>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
