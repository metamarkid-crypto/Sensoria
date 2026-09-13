import clsx from "clsx";
import type { ReactNode } from "react";
import type { TransactionStatus, SubscriptionStatus } from "@/lib/types";

export function Card({
  title,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("glass-card p-5", className)}>
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {typeof title === "string" ? (
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
              {title}
            </h2>
          ) : (
            title
          )}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div
      className={clsx(
        "glass-card p-5",
        accent && "border-teal/40 bg-teal-soft/40",
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-3xl font-bold text-slate-50">{value}</p>
      {sub ? <p className="mt-1 text-xs text-slate-400">{sub}</p> : null}
    </div>
  );
}

const TX_STYLES: Record<TransactionStatus, string> = {
  pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  paid: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  refunded: "bg-violet-500/15 text-violet-300 border-violet-500/30",
};

export function TransactionBadge({ status }: { status: TransactionStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize",
        TX_STYLES[status],
      )}
    >
      {status}
    </span>
  );
}

const SUB_STYLES: Record<SubscriptionStatus, string> = {
  trial: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  expired: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  cancelled: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

export function SubscriptionBadge({ status }: { status: SubscriptionStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize",
        SUB_STYLES[status],
      )}
    >
      {status}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-line px-6 py-10 text-center text-sm text-slate-500">
      {children}
    </div>
  );
}

export const fmtIDR = (n: number) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);

export const fmtDate = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso))
    : "—";
