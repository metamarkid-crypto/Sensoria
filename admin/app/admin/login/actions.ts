"use server";

import { redirect } from "next/navigation";
import { createAdminAuthClient, createServiceClient } from "@/lib/supabase/server";
import {
  checkAllowed,
  recordFailure,
  resetFailures,
} from "@/lib/rate-limit";
import { getLoginClientIp } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

export async function signInAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) redirect("/admin/login?error=missing");

  const ip = await getLoginClientIp();
  const emailKey = email.toLowerCase();

  // ── 1) Rate limit BEFORE touching Supabase Auth ────────────────────────────
  //    Per-identifier (email) + per-IP buckets, plus a global failure budget.
  //    Checked without recording, so page refreshes during a lockout stay free.
  const pre =
    checkAllowed("identifier", emailKey).allowed &&
    checkAllowed("identifier", ip).allowed &&
    checkAllowed("global", "").allowed;

  if (!pre) {
    await writeAudit({
      action: "login_rate_limited",
      scope: "auth.login",
      description: `Rate limiter blocked a sign-in attempt for ${emailKey}`,
      actorEmail: emailKey,
      metadata: { ip },
    });
    redirect("/admin/login?error=rate_limited");
  }

  // ── 2) Allowlist pre-check: never reveal whether the email exists in Auth ──
  //    Anonymous probes for admin@… get one cheap DB round-trip instead of a
  //    Supabase Auth password verdict, and get counted as a failure either way.
  const service = createServiceClient();
  const { data: allowlisted } = await service
    .from("admin_users")
    .select("email")
    .ilike("email", email)
    .maybeSingle();

  if (!allowlisted) {
    recordFailure("identifier", emailKey);
    recordFailure("identifier", ip);
    recordFailure("global", "");
    await writeAudit({
      action: "login_failed",
      scope: "auth.login",
      description: `Sign-in refused — ${emailKey} is not on the admin allowlist`,
      actorEmail: emailKey,
      metadata: { ip, reason: "not_allowlisted" },
    });
    redirect("/admin/login?error=invalid");
  }

  // ── 3) Real credential check ────────────────────────────────────────────────
  const supabase = await createAdminAuthClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    recordFailure("identifier", emailKey);
    recordFailure("identifier", ip);
    recordFailure("global", "");
    await writeAudit({
      action: "login_failed",
      scope: "auth.login",
      description: `Failed sign-in for ${emailKey}`,
      actorEmail: emailKey,
      metadata: {
        ip,
        reason: error.name === "AuthWeakPasswordError" ? "weak_password" : "invalid_credentials",
      },
    });
    redirect(`/admin/login?error=${error.name === "AuthWeakPasswordError" ? "weak_password" : "invalid"}`);
  }

  resetFailures(emailKey);
  resetFailures(ip);

  await writeAudit({
    action: "login_succeeded",
    scope: "auth.login",
    description: `Admin signed in: ${emailKey}`,
    actorEmail: emailKey,
    metadata: { ip },
  });

  redirect("/admin");
}

export async function signOutAction() {
  const supabase = await createAdminAuthClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}
