import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull } from "@/lib/auth";

/**
 * Admin audit trail (admin_audit_log, see
 * supabase/migrations/20260913_admin_audit_log.sql).
 *
 * Rules:
 *  • Written via the SERVICE ROLE — the table is RLS read-only for admins and
 *    has no UPDATE/DELETE policies at all, so app code can never rewrite it.
 *  • Audit failures must NEVER break the user-facing action: log and carry on.
 *  • Never put credentials or raw webhook PII payloads into metadata.
 */

export const AUDIT_ACTIONS = [
  "login_succeeded",
  "login_failed",
  "login_rate_limited",
  "settings_update",
  "plan_upsert",
  "plan_toggle",
  "royalty_mark_paid",
  "transaction_override",
  "transaction_settlement_retry",
  "transaction_refund",
  "subscription_extend",
  "subscription_revoke",
  "team_invite",
  "team_role_change",
  "team_remove",
  "support_lookup",
  "parent_contact_update",
  "parent_slot_grant",
  "privacy_purge_locations",
  "emergency_locate",
  "qris_merchant_link",
  "qris_static_qr_set",
  "qris_token_refresh",
  "qris_worker_run",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: number;
  created_at: string;
  actor_email: string;
  action: string;
  scope: string;
  description: string;
  metadata: Record<string, unknown>;
  ip_address: string | null;
  user_agent: string | null;
}

/**
 * Best-effort request context. Server actions run outside the request scope
 * for headers() in some Next versions, so every field is optional.
 */
export async function getRequestContext(): Promise<{
  ip: string | null;
  userAgent: string | null;
}> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    return {
      ip: fwd ? fwd.split(",")[0].trim() : h.get("x-real-ip"),
      userAgent: h.get("user-agent"),
    };
  } catch {
    return { ip: null, userAgent: null };
  }
}

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/password|secret|token|key|nonce/i.test(k)) continue; // paranoia filter
    clean[k] = v;
  }
  return clean;
}

/**
 * Record one privileged action. Fire-and-forget by design — the caller's
 * transaction is already done or refused, and a broken audit sink must not
 * take the dashboard down with it.
 */
export async function writeAudit(opts: {
  action: AuditAction;
  scope: string;
  description: string;
  /** Actor email; falls back to the current admin session, then 'anonymous'. */
  actorEmail?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const actorEmail =
    opts.actorEmail?.toLowerCase() ??
    (await getAdminOrNull().then((a) => a?.email.toLowerCase() ?? null)) ??
    "anonymous";

  const { ip, userAgent } = await getRequestContext();

  try {
    const db = createServiceClient();
    const { error } = await db.from("admin_audit_log").insert({
      actor_email: actorEmail,
      action: opts.action,
      scope: opts.scope,
      description: opts.description,
      metadata: sanitizeMeta(opts.metadata ?? {}),
      ip_address: ip,
      user_agent: userAgent,
    });
    if (error) throw error;
  } catch (err) {
    console.error("[audit] failed to persist admin_audit_log entry:", err);
  }
}

/** Newest-first page of the trail for /admin/audit. */
export async function getAuditLog(opts: {
  action?: string;
  actor?: string;
  limit?: number;
}): Promise<{ entries: AuditEntry[]; total: number }> {
  const db = createServiceClient();
  const limit = Math.min(opts.limit ?? 200, 500);

  let query = db
    .from("admin_audit_log")
    .select("*", { count: "exact", head: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (opts.action && opts.action !== "all") {
    query = query.eq("action", opts.action);
  }
  if (opts.actor) {
    query = query.ilike("actor_email", `%${opts.actor}%`);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    entries: (data ?? []) as unknown as AuditEntry[],
    total: count ?? 0,
  };
}
