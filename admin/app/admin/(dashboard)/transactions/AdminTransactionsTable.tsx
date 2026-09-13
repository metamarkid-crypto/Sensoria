"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Download, RefreshCw, X, Search, Undo2 } from "lucide-react";
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
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  overrideStatusAction,
  retrySettlementAction,
  getRefundsForTransaction,
  type RefundRow,
} from "./actions";
import RefundDialog from "./RefundDialog";

type StatusFilter = "all" | "pending" | "paid" | "failed" | "refunded";

export default function AdminTransactionsTable({
  rows,
  stats,
  dashboardOwner,
  canRefund,
}: {
  rows: TxListRow[];
  stats: TxStats;
  /** Viewer is the Owner — refunds are Owner-only money operations. */
  dashboardOwner: boolean;
  /** refund_transaction RPC exists on the DB (20260913_manual_refunds.sql applied). */
  canRefund: boolean;
}) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<TxListRow | null>(null);
  const [drawerRefunds, setDrawerRefunds] = useState<RefundRow[]>([]);
  const [refundTarget, setRefundTarget] = useState<TxListRow | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{
    row: TxListRow;
    toStatus: "paid" | "failed";
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Refund history for the detail drawer (fetched when the drawer opens).
  useEffect(() => {
    setDrawerRefunds([]);
    if (!selected) return;
    let cancelled = false;
    getRefundsForTransaction(selected.transaction_ref).then((rs) => {
      if (!cancelled) setDrawerRefunds(rs);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

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
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
        <StatCard label="Pending" value={stats.pending} />
        <StatCard label="Paid" value={stats.paid} />
        <StatCard
          label="Refunded"
          value={fmtIDR(stats.refunded)}
          sub="money returned to customers"
        />
        <StatCard
          accent
          label="Net settled"
          value={fmtIDR(stats.netSettledVolume)}
          sub={`${fmtIDR(stats.volumePaid)} gross`}
        />
        <StatCard label="Failed" value={stats.failed} />
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
            {(["all", "pending", "paid", "refunded", "failed"] as StatusFilter[]).map((s) => (
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
                      {r.refundedTotal > 0 && r.status !== "refunded" ? (
                        <span className="mt-0.5 block text-[10px] text-violet-300">
                          {fmtIDR(r.refundedTotal)} refunded
                        </span>
                      ) : null}
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
                        ) : r.status === "paid" ? (
                          <>
                            {canRefund && dashboardOwner ? (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() => setRefundTarget(r)}
                                className="btn-ghost text-violet-300 hover:border-violet-400/50"
                                title="Record a manual gateway refund"
                              >
                                <Undo2 size={13} /> Refund
                              </button>
                            ) : null}
                            {canRefund ? (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() =>
                                  setConfirmTarget({ row: r, toStatus: "failed" })
                                }
                                className="btn-ghost"
                              >
                                Mark failed
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={pending}
                                onClick={() =>
                                  runAction(() =>
                                    overrideStatusAction(r.transaction_ref, "failed"),
                                  )
                                }
                                className="btn-ghost"
                              >
                                Mark failed
                              </button>
                            )}
                          </>
                        ) : r.status === "failed" ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() =>
                              setConfirmTarget({ row: r, toStatus: "paid" })
                            }
                            className="btn-ghost"
                          >
                            Mark paid
                          </button>
                        ) : null}
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
                ["Refunded", selected.refundedTotal > 0 ? fmtIDR(selected.refundedTotal) : "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="text-right font-medium text-slate-200">{v}</dd>
                </div>
              ))}
            </dl>

            {drawerRefunds.length > 0 ? (
              <div className="mt-6">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Refund history ({drawerRefunds.length})
                </h4>
                <ul className="space-y-2">
                  {drawerRefunds.map((rf) => (
                    <li
                      key={rf.id}
                      className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-3 text-xs"
                    >
                      <div className="flex justify-between">
                        <span className="font-semibold text-violet-300">
                          {fmtIDR(rf.amount)}
                        </span>
                        <span className="text-slate-500">{fmtDate(rf.created_at)}</span>
                      </div>
                      <p className="mt-1 text-slate-300">{rf.reason}</p>
                      <p className="mt-1 text-slate-500">
                        by {rf.created_by_email}
                        {rf.gateway_reference
                          ? ` · gateway ref ${rf.gateway_reference}`
                          : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

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

      {/* Owner-only refund dialog — records a manual gateway refund. */}
      {refundTarget ? (
        <RefundDialog
          tx={refundTarget}
          onClose={() => setRefundTarget(null)}
          onCompleted={(msg) => {
            setRefundTarget(null);
            setToast(msg);
            setTimeout(() => setToast(null), 6000);
          }}
        />
      ) : null}

      {/* Destructive status overrides now confirm explicitly (P2 #1). */}
      {confirmTarget ? (
        <ConfirmDialog
          open
          tone="danger"
          busy={pending}
          title={`Mark as ${confirmTarget.toStatus}?`}
          body={
            confirmTarget.toStatus === "failed" ? (
              <span>
                Transaction <code className="font-mono">{confirmTarget.row.transaction_ref}</code>{" "}
                will be marked <strong>failed</strong>. Its amount leaves the
                settled revenue. Use Refund instead if the money is being
                returned.
              </span>
            ) : (
              <span>
                Transaction <code className="font-mono">{confirmTarget.row.transaction_ref}</code>{" "}
                will be marked <strong>paid</strong> and its plan applied to the
                subscription immediately.
              </span>
            )
          }
          confirmLabel={confirmTarget.toStatus === "failed" ? "Mark failed" : "Mark paid & apply plan"}
          onCancel={() => setConfirmTarget(null)}
          onConfirm={() => {
            const { row, toStatus } = confirmTarget;
            setConfirmTarget(null);
            runAction(() => overrideStatusAction(row.transaction_ref, toStatus));
          }}
        />
      ) : null}
    </div>
  );
}
