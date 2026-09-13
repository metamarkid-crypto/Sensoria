"use client";

import { useState, useTransition } from "react";
import { Loader2, X, Undo2 } from "lucide-react";
import type { TxListRow } from "@/lib/transactions";
import { fmtIDR } from "@/components/ui";
import { refundTransactionAction } from "./actions";

/**
 * Refund form for one PAID transaction (Owner-only).
 * The money is refunded manually in the gateway dashboard; this records the
 * ledger leg and pulls the entitlement back (see refundTransactionAction).
 * Partial refunds allowed — amount defaults to the remaining balance.
 */
export default function RefundDialog({
  tx,
  onClose,
  onCompleted,
}: {
  tx: TxListRow;
  onClose: () => void;
  onCompleted: (message: string) => void;
}) {
  const remaining = Math.max(0, tx.amount - tx.refundedTotal);
  const [amount, setAmount] = useState(String(remaining));
  const [reason, setReason] = useState("");
  const [gwRef, setGwRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Amount must be a positive number.");
      return;
    }
    if (parsed > remaining + 0.001) {
      setError(`Amount exceeds the remaining balance (${fmtIDR(remaining)}).`);
      return;
    }
    if (!reason.trim()) {
      setError("Reason is required — it goes into the audit trail.");
      return;
    }

    startTransition(async () => {
      const res = await refundTransactionAction(
        tx.transaction_ref,
        parsed,
        reason,
        gwRef || undefined,
      );
      if (res.ok) {
        onCompleted(res.message);
      } else {
        setError(res.message);
      }
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={pending ? undefined : onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-ink-line bg-ink-card p-6 shadow-glass"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300">
              <Undo2 size={17} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-50">Record refund</h3>
              <p className="font-mono text-[11px] text-slate-500">
                {tx.transaction_ref}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-200"
          >
            <X size={16} />
          </button>
        </div>

        <dl className="mt-4 space-y-1.5 rounded-xl border border-ink-line bg-ink-soft/60 p-3 text-xs">
          <div className="flex justify-between">
            <dt className="text-slate-500">Paid</dt>
            <dd className="font-medium text-slate-200">{fmtIDR(tx.amount)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Already refunded</dt>
            <dd className="font-medium text-slate-200">{fmtIDR(tx.refundedTotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Remaining</dt>
            <dd className="font-semibold text-violet-300">{fmtIDR(remaining)}</dd>
          </div>
        </dl>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
              Refund amount (IDR)
            </span>
            <input
              type="number"
              min={1}
              max={remaining}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={pending}
              className="glass-input w-full"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
              Reason (required)
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. duplicate payment, requested cancellation"
              disabled={pending}
              className="glass-input w-full"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
              Gateway refund reference (optional)
            </span>
            <input
              value={gwRef}
              onChange={(e) => setGwRef(e.target.value)}
              placeholder="refund leg id from the gateway dashboard"
              disabled={pending}
              className="glass-input w-full"
            />
          </label>
        </div>

        {error ? (
          <p className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error}
          </p>
        ) : null}

        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
          Refund the money in the QRIS gateway dashboard first, then record it
          here. On record: the subscription is clawed back automatically —
          revoking the plan if this was the child&apos;s last purchase, or
          shortening the expiry if it was stacked onto an active one.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="btn-ghost"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending}
            className="btn-primary disabled:opacity-50"
          >
            {pending ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
            Record refund
          </button>
        </div>
      </div>
    </div>
  );
}
