"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  UserPlus,
  ShieldCheck,
  UserCog,
  UserMinus,
  Clock,
  ShieldAlert,
  Loader2,
} from "lucide-react";
import { Card, fmtDate } from "@/components/ui";
import type { AdminRole } from "@/lib/auth";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  inviteAdminAction,
  changeRoleAction,
  removeAdminAction,
  type TeamMember,
} from "./actions";

const ROLE_STYLES: Record<AdminRole, string> = {
  owner: "bg-teal-soft text-teal border-teal/40",
  support: "bg-slate-500/15 text-slate-300 border-slate-500/30",
};

export default function TeamPanel({
  initialMembers,
  loadError,
  dashboardOwner,
}: {
  initialMembers: TeamMember[];
  loadError: string | null;
  /** Viewer's role from requireAdmin() — gates all mutation UI. */
  dashboardOwner: boolean;
}) {
  const router = useRouter();
  const [members, setMembers] = useState(initialMembers);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AdminRole>("support");
  const [pending, startTransition] = useTransition();
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);

  function run(fn: () => Promise<{ ok: boolean; message: string }>, email?: string) {
    setMessage(null);
    if (email) setBusyEmail(email);
    startTransition(async () => {
      const res = await fn();
      setMessage({ ok: res.ok, text: res.message });
      if (email) setBusyEmail(null);
      if (res.ok) {
        // Roster (incl. roles) is server-rendered — refetch after a mutation.
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-4">
      {loadError ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Failed to load the team: {loadError}
        </div>
      ) : null}

      {message ? (
        <div
          className={
            message.ok
              ? "rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
              : "rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
          }
          role="status"
        >
          {message.text}
        </div>
      ) : null}

      <Card
        title={`Team members (${members.length})`}
        action={
          <span className="text-[11px] uppercase tracking-wider text-slate-500">
            Owner manages this list
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-line text-left">
                <th className="table-head">Admin</th>
                <th className="table-head">Role</th>
                <th className="table-head hidden md:table-cell">Last sign-in</th>
                <th className="table-head hidden lg:table-cell">Added</th>
                <th className="table-head text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.email} className="border-b border-ink-line/60 last:border-0">
                  <td className="table-cell font-medium text-slate-100">{m.email}</td>
                  <td className="table-cell">
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${ROLE_STYLES[m.role]}`}
                    >
                      {m.role === "owner" ? (
                        <ShieldCheck size={12} className="mr-1" />
                      ) : (
                        <UserCog size={12} className="mr-1" />
                      )}
                      {m.role}
                    </span>
                  </td>
                  <td className="table-cell hidden md:table-cell">
                    {m.lastSignInAt ? (
                      <span className="inline-flex items-center gap-1.5 text-slate-300">
                        <Clock size={13} className="text-slate-500" />
                        {fmtDate(m.lastSignInAt)}
                      </span>
                    ) : (
                      <span className="text-slate-500">invite pending</span>
                    )}
                  </td>
                  <td className="table-cell hidden text-slate-400 lg:table-cell">
                    {fmtDate(m.createdAt)}
                  </td>
                  <td className="table-cell text-right">
                    {dashboardOwner && m.role !== "owner" ? (
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => run(() => changeRoleAction(m.email, "owner"), m.email)}
                          className="btn-ghost text-xs"
                          title="Transfer Owner role"
                        >
                          {busyEmail === m.email ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <ShieldCheck size={13} className="mr-1" />
                          )}
                          Make Owner
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setRemoveTarget(m)}
                          className="btn-ghost text-xs text-rose-300"
                        >
                          <UserMinus size={13} className="mr-1" />
                          Remove
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {members.length === 0 ? (
                <tr>
                  <td colSpan={5} className="table-cell text-center text-slate-500">
                    No admins yet — invite the first one below.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {removeTarget ? (
        <ConfirmDialog
          open
          tone="danger"
          busy={pending}
          title="Remove this admin?"
          body={
            <span>
              <strong>{removeTarget.email}</strong> loses dashboard access
              immediately and their Supabase Auth account is deleted. This is
              logged in the audit trail.
            </span>
          }
          confirmLabel="Remove admin"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => {
            const target = removeTarget;
            setRemoveTarget(null);
            run(() => removeAdminAction(target.email), target.email);
          }}
        />
      ) : null}

      {dashboardOwner ? (
        <Card
          title={
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
              <UserPlus size={15} className="text-teal" />
              Invite a new admin
            </h2>
          }
        >
          <form
            className="flex flex-col gap-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => inviteAdminAction(email, inviteRole));
            }}
          >
            <label className="flex-1">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                Email
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@yourdomain.com"
                className="w-full rounded-xl border border-ink-line bg-ink-soft px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal/50 focus:outline-none"
              />
            </label>
            <label className="sm:w-44">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                Role
              </span>
              <select
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as AdminRole)}
                className="w-full rounded-xl border border-ink-line bg-ink-soft px-3 py-2.5 text-sm text-slate-100 focus:border-teal/50 focus:outline-none"
              >
                <option value="support">Support — ops only</option>
                <option value="owner">Owner — full control</option>
              </select>
            </label>
            <button
              type="submit"
              disabled={pending}
              className="btn-primary shrink-0 disabled:opacity-50"
            >
              {pending ? <Loader2 size={15} className="animate-spin" /> : <UserPlus size={15} />}
              Send invite
            </button>
          </form>
          <p className="mt-3 flex items-start gap-2 text-xs text-slate-500">
            <ShieldAlert size={13} className="mt-0.5 shrink-0 text-amber-400" />
            Support can look up devices, extend or revoke plans, and read the money
            ledger — but cannot change prices, override settlements, edit app settings,
            or manage this team. Only one Owner exists at a time; use “Make Owner” to
            hand the role over.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
