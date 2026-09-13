"use client";

import type { ReactNode } from "react";
import { TriangleAlert, Loader2 } from "lucide-react";
import clsx from "clsx";

/**
 * Reusable destructive-action confirmation (P2 #1).
 * Blocks the click path to any irreversible action: Revoke plan, Remove
 * admin, refunds, … Renders a modal that must be answered explicitly —
 * no more browser confirm() and no more one-click accidents.
 */
export default function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Yes, proceed",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  /** danger = rose (irreversible), default = teal. */
  tone?: "danger" | "default";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={busy ? undefined : onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-ink-line bg-ink-card p-6 shadow-glass"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start gap-3">
          <div
            className={clsx(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
              tone === "danger"
                ? "bg-rose-500/15 text-rose-300"
                : "bg-teal-soft text-teal",
            )}
          >
            <TriangleAlert size={17} />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-50">{title}</h3>
            <div className="mt-1.5 text-sm text-slate-400">{body}</div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btn-ghost"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={clsx(
              "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-50",
              tone === "danger"
                ? "border border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25"
                : "btn-primary",
            )}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
