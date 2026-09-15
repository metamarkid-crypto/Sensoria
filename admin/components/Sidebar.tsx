"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  LayoutDashboard,
  ReceiptText,
  Tablets,
  CreditCard,
  Settings2,
  ScrollText,
  Users,
  SearchCheck,
  QrCode,
} from "lucide-react";
import { signOutAction } from "@/app/admin/login/actions";

const NAV = [
  { href: "/admin", label: "Executive", icon: LayoutDashboard },
  { href: "/admin/lookup", label: "Lookup", icon: SearchCheck },
  { href: "/admin/transactions", label: "Transactions", icon: ReceiptText },
  { href: "/admin/devices", label: "Devices", icon: Tablets },
  { href: "/admin/subscriptions", label: "Subscriptions", icon: CreditCard },
  { href: "/admin/payment", label: "Payment Gateway", icon: QrCode },
  { href: "/admin/settings", label: "Settings", icon: Settings2 },
  { href: "/admin/team", label: "Team", icon: Users },
  { href: "/admin/audit", label: "Audit Log", icon: ScrollText },
] as const;

export default function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();

  return (
    <aside className="flex h-full w-full flex-col gap-6 border-r border-ink-line bg-ink-soft/70 backdrop-blur-card lg:h-screen lg:w-64 lg:sticky lg:top-0">
      <div className="flex items-center gap-3 px-5 pt-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-soft text-sm font-black text-teal">
          S
        </div>
        <div>
          <p className="text-sm font-bold text-slate-100">Sensoria Admin</p>
          <p className="text-[11px] text-slate-500">aacsensoria.id</p>
        </div>
      </div>

      <nav className="flex flex-row gap-1 overflow-x-auto px-3 lg:flex-col">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/admin"
              ? pathname === "/admin"
              : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-3 whitespace-nowrap rounded-xl px-3 py-2.5 text-sm font-medium transition",
                active
                  ? "bg-teal-soft text-teal"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200",
              )}
            >
              <Icon size={17} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-ink-line px-5 py-4">
        <p className="truncate text-xs text-slate-500">{email}</p>
        <form action={signOutAction} className="mt-2">
          <button
            type="submit"
            className="text-xs font-semibold text-slate-400 transition hover:text-rose-300"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
