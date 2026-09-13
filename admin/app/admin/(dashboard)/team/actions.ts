"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull, requireOwner, normalizeAdminRole, type AdminRole } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

/**
 * Admin team management — /admin/team.
 *
 * Access model:
 *  • Every allowlisted admin can VIEW the team roster.
 *  • Owner-only: invite, change role, remove. (Support helps users, not
 *    the admin team itself.)
 *
 * The single-Owner invariant is enforced twice: the UI refuses destructive
 * changes to the last Owner, and the DB trigger
 * (20260913_admin_roles.sql → enforce_single_owner) is the final backstop.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TeamMember {
  email: string;
  role: AdminRole;
  createdAt: string;
  /** Null when the member has never completed a login (e.g. invite pending). */
  lastSignInAt: string | null;
}

/** Roster + last sign-in. Visible to every admin (Support included). */
export async function getTeam(): Promise<{ members: TeamMember[]; error?: string }> {
  const admin = await getAdminOrNull();
  if (!admin) return { members: [], error: "Unauthorized" };

  const db = createServiceClient();
  const { data, error } = await db
    .from("admin_users")
    .select("email, role, created_at")
    .order("created_at", { ascending: true });
  if (error) return { members: [], error: error.message };

  // last_sign_in_at lives in auth.users, not admin_users — join by email.
  const { data: usersData } = await db.auth.admin.listUsers({ perPage: 200 });
  const lastSeen = new Map<string, string>();
  for (const u of usersData?.users ?? []) {
    if (u.email && u.last_sign_in_at) {
      lastSeen.set(u.email.toLowerCase(), u.last_sign_in_at);
    }
  }

  return {
    members: (data ?? []).map((r) => ({
      email: String(r.email),
      role: normalizeAdminRole(r.role),
      createdAt: String(r.created_at),
      lastSignInAt: lastSeen.get(String(r.email).toLowerCase()) ?? null,
    })),
  };
}

/**
 * Invite a new admin: creates the Supabase Auth user with a "set your
 * password" email, and (only when that succeeds) adds the allowlist row.
 * Supabase's invite flow is idempotent per email — a re-invite resends the
 * email without duplicating the user, so a lost invite is recoverable here.
 */
export async function inviteAdminAction(
  email: string,
  role: AdminRole,
): Promise<{ ok: boolean; message: string }> {
  try {
    const actor = await requireOwner();

    const normalized = email.trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) {
      return { ok: false, message: "That doesn't look like a valid email address." };
    }

    const db = createServiceClient();

    const { data: existing } = await db
      .from("admin_users")
      .select("email")
      .ilike("email", normalized)
      .maybeSingle();
    if (existing) {
      return { ok: false, message: `${normalized} is already an admin.` };
    }

    // 1) Auth identity first — the allowlist row must never point at a user
    //    that cannot actually sign in.
    const { error: inviteError } = await db.auth.admin.inviteUserByEmail(normalized, {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100"}/admin/login`,
    });
    if (inviteError) {
      return { ok: false, message: inviteError.message };
    }

    // 2) Allowlist entry — this is what grants dashboard access.
    const { error: insertError } = await db
      .from("admin_users")
      .insert({ email: normalized, role });
    if (insertError) {
      return { ok: false, message: insertError.message };
    }

    revalidatePath("/admin/team");
    await writeAudit({
      action: "team_invite",
      scope: "team",
      description: `${normalized} invited as ${role}`,
      actorEmail: actor.email,
      metadata: { invited_email: normalized, role },
    });
    return {
      ok: true,
      message: `Invite sent to ${normalized} — they'll appear here once they accept.`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "OwnerRequiredError") {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: "Invite failed unexpectedly — check the server logs." };
  }
}

/** Promote to Owner / demote to Support. Owner-only, guarded against lockout. */
export async function changeRoleAction(
  email: string,
  newRole: AdminRole,
): Promise<{ ok: boolean; message: string }> {
  try {
    const actor = await requireOwner();

    const db = createServiceClient();
    const { data: target } = await db
      .from("admin_users")
      .select("email, role")
      .ilike("email", email)
      .maybeSingle();
    if (!target) return { ok: false, message: "Admin not found." };

    const currentRole = normalizeAdminRole(target.role);
    if (currentRole === newRole) {
      return { ok: false, message: `${email} is already ${newRole}.` };
    }

    // Lockout guard — the DB trigger is the backstop, this is the UX.
    if (currentRole === "owner" && actor.email.toLowerCase() === email.toLowerCase()) {
      return { ok: false, message: "You are the only Owner — promote another admin to Owner first." };
    }

    const { error } = await db
      .from("admin_users")
      .update({ role: newRole })
      .ilike("email", email);
    if (error) return { ok: false, message: error.message };

    revalidatePath("/admin/team");
    await writeAudit({
      action: "team_role_change",
      scope: "team",
      description: `${email}: ${currentRole} → ${newRole}`,
      actorEmail: actor.email,
      metadata: { target_email: email, from_role: currentRole, to_role: newRole },
    });
    return { ok: true, message: `${email} is now ${newRole}.` };
  } catch (err) {
    if (err instanceof Error && err.name === "OwnerRequiredError") {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: "Role change failed unexpectedly — check the server logs." };
  }
}

/**
 * Remove an admin: allowlist row first (access dies instantly, even before
 * the auth user is gone), then the Supabase Auth user. The Owner cannot
 * remove themselves — the DB trigger refuses the last-Owner delete anyway.
 */
export async function removeAdminAction(email: string): Promise<{ ok: boolean; message: string }> {
  try {
    const actor = await requireOwner();

    if (actor.email.toLowerCase() === email.trim().toLowerCase()) {
      return { ok: false, message: "You cannot remove your own account — ask another Owner." };
    }

    const db = createServiceClient();

    const { data: target } = await db
      .from("admin_users")
      .select("role")
      .ilike("email", email)
      .maybeSingle();
    if (!target) return { ok: false, message: "Admin not found." };

    const { error: deleteError } = await db
      .from("admin_users")
      .delete()
      .ilike("email", email);
    if (deleteError) return { ok: false, message: deleteError.message };

    // Auth identity cleanup — non-fatal if it fails (allowlist already gates
    // access; a stray auth user without an allowlist row cannot log in).
    const { data: usersData } = await db.auth.admin.listUsers({ perPage: 200 });
    const authUser = usersData?.users?.find(
      (u) => u.email?.toLowerCase() === email.trim().toLowerCase(),
    );
    if (authUser) {
      await db.auth.admin.deleteUser(authUser.id);
    }

    revalidatePath("/admin/team");
    await writeAudit({
      action: "team_remove",
      scope: "team",
      description: `${email} removed from the admin team`,
      actorEmail: actor.email,
      metadata: { removed_email: email, was_role: normalizeAdminRole(target.role) },
    });
    return { ok: true, message: `${email} removed — dashboard access revoked.` };
  } catch (err) {
    if (err instanceof Error && err.name === "OwnerRequiredError") {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: "Removal failed unexpectedly — check the server logs." };
  }
}
