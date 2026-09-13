import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createAdminAuthClient, createServiceClient } from "@/lib/supabase/server";

export interface AdminUser {
  email: string;
  /** True when the session satisfies the project's MFA policy (AAL2). */
  mfaVerified: boolean;
  /** 'owner' controls pricing/money/settings/team; 'support' is ops-only. */
  role: AdminRole;
}

/**
 * Role model (see supabase/migrations/20260913_admin_roles.sql):
 *  • owner   — plans & pricing, money ledger overrides, app settings, team.
 *  • support — devices, extend/revoke, read-only view of money.
 * The DB keeps the hard invariant of exactly ONE Owner; the dashboard
 * enforces per-action through requireOwner().
 */
export const ADMIN_ROLES = ["owner", "support"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export function normalizeAdminRole(value: unknown): AdminRole {
  return ADMIN_ROLES.includes(value as AdminRole) ? (value as AdminRole) : "support";
}

/** Thrown by requireOwner() and surfaced by the Team actions. */
export class OwnerRequiredError extends Error {
  constructor() {
    super("Owner role required — this action is restricted to the dashboard Owner.");
    this.name = "OwnerRequiredError";
  }
}

/**
 * Server-side password policy mirror — keep in sync with the Supabase
 * dashboard (Authentication → Providers → Email). The login action surfaces
 * Supabase's own WeakPasswordError through this shape, and SECURITY.md
 * documents the dashboard side. See lib/SECURITY.md for the full guide.
 */
export const ADMIN_PASSWORD_POLICY = {
  minLength: 12,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true, // allowed: !@#$%^&*()_+-=[]{};'\\:"|<>?,./`~
  rejectLeaked: true, // HaveIBeenPwned check — Supabase Pro plan and above
} as const;

/**
 * MFA policy switch for the dashboard. Flip ADMIN_ENFORCE_MFA to true in
 * lib/auth.ts once every allowlisted admin has enrolled a TOTP factor
 * (see lib/SECURITY.md → "Enable MFA"). While false, the gate only reports
 * mfaVerified so the shell can show an enrollment warning banner.
 */
export const ADMIN_ENFORCE_MFA = false;

/**
 * requireAdmin — the gate every admin page and server action calls first.
 *
 *  1. A valid Supabase Auth session must exist (email/password login).
 *  2. The session email must be in the admin_users allowlist
 *     (read via the SERVICE role — the table is RLS-locked to admins, but
 *     this check runs BEFORE we trust the caller with anything).
 *  3. When ADMIN_ENFORCE_MFA is on, the session must carry aal2 (a verified
 *     second factor). Unverified sessions are sent back to the login screen.
 *
 * Otherwise the request is redirected to /admin/login.
 */
export async function requireAdmin(): Promise<AdminUser> {
  const auth = await createAdminAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user?.email) redirect("/admin/login");

  const service = createServiceClient();

  // Prefer the role column (20260913_admin_roles.sql); if the roles migration
  // has not been applied yet the combined select errors — fall back to the
  // plain allowlist check so admins keep working pre-migration. Every
  // pre-roles admin had Owner-level powers, so that is the honest default
  // until the migration runs and promotes them properly.
  let row: { email: string; role?: string } | null = null;
  const withRole = await service
    .from("admin_users")
    .select("email, role")
    .ilike("email", user.email)
    .maybeSingle();
  if (!withRole.error) {
    row = withRole.data;
  } else {
    const fallback = await service
      .from("admin_users")
      .select("email")
      .ilike("email", user.email)
      .maybeSingle();
    row = fallback.error ? null : fallback.data;
  }

  if (!row) {
    // Authenticated but not allowlisted — treat as hostile, bounce to login.
    redirect("/admin/login?denied=1");
  }

  const mfaVerified = (await getAssuranceLevel(auth)) === "aal2";
  if (ADMIN_ENFORCE_MFA && !mfaVerified) {
    redirect("/admin/login?mfa=1");
  }

  return {
    email: user.email,
    mfaVerified,
    role: normalizeAdminRole(row.role ?? "owner"),
  };
}

/** Non-redirecting variant for route handlers / server actions. */
export async function getAdminOrNull(): Promise<AdminUser | null> {
  const auth = await createAdminAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user?.email) return null;

  const service = createServiceClient();

  // Same pre-migration fallback as requireAdmin() above.
  let row: { email: string; role?: string } | null = null;
  const withRole = await service
    .from("admin_users")
    .select("email, role")
    .ilike("email", user.email)
    .maybeSingle();
  if (!withRole.error) {
    row = withRole.data;
  } else {
    const fallback = await service
      .from("admin_users")
      .select("email")
      .ilike("email", user.email)
      .maybeSingle();
    row = fallback.error ? null : fallback.data;
  }

  if (!row) return null;

  return {
    email: user.email,
    mfaVerified: (await getAssuranceLevel(auth)) === "aal2",
    role: normalizeAdminRole(row.role ?? "owner"),
  };
}

/**
 * Owner-only gate for server actions. Call after requireAdmin-style auth:
 * throws OwnerRequiredError when the session belongs to a Support admin —
 * the Team UI surfaces that as a friendly banner instead of a crash.
 */
export async function requireOwner(): Promise<AdminUser & { role: "owner" }> {
  const admin = await getAdminOrNull();
  if (!admin) redirect("/admin/login");
  if (admin.role !== "owner") throw new OwnerRequiredError();
  return admin as AdminUser & { role: "owner" };
}

/**
 * Authenticator Assurance Level of the current session: aal1 = password
 * only, aal2 = a verified second factor (TOTP). Uses the supabase-js MFA
 * API, which reads the `aal` claim of the session's access token.
 */
async function getAssuranceLevel(
  auth: Awaited<ReturnType<typeof createAdminAuthClient>>,
): Promise<"aal1" | "aal2" | "unknown"> {
  try {
    const { data } = await auth.auth.mfa.getAuthenticatorAssuranceLevel();
    const level = data?.currentLevel;
    return level === "aal2" ? "aal2" : level === "aal1" ? "aal1" : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Caller IP for rate limiting. Server actions can read headers; fall back to
 * a fixed bucket so a header-less environment still gets global limiting.
 */
export async function getLoginClientIp(): Promise<string> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    return fwd ? fwd.split(",")[0].trim() : h.get("x-real-ip") ?? "unknown";
  } catch {
    return "unknown";
  }
}
