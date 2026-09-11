import { redirect } from "next/navigation";
import { createAdminAuthClient, createServiceClient } from "@/lib/supabase/server";

export interface AdminUser {
  email: string;
}

/**
 * requireAdmin — the gate every admin page and server action calls first.
 *
 *  1. A valid Supabase Auth session must exist (email/password login).
 *  2. The session email must be in the admin_users allowlist
 *     (read via the SERVICE role — the table is RLS-locked to admins, but
 *     this check runs BEFORE we trust the caller with anything).
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
  const { data: allowlisted, error } = await service
    .from("admin_users")
    .select("email")
    .ilike("email", user.email)
    .maybeSingle();

  if (error || !allowlisted) {
    // Authenticated but not allowlisted — treat as hostile, bounce to login.
    redirect("/admin/login?denied=1");
  }

  return { email: user.email };
}

/** Non-redirecting variant for route handlers / server actions. */
export async function getAdminOrNull(): Promise<AdminUser | null> {
  const auth = await createAdminAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();

  if (!user?.email) return null;

  const service = createServiceClient();
  const { data: allowlisted } = await service
    .from("admin_users")
    .select("email")
    .ilike("email", user.email)
    .maybeSingle();

  return allowlisted ? { email: user.email } : null;
}
