"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

async function guard() {
  const admin = await getAdminOrNull();
  if (!admin) throw new Error("Unauthorized");
  return admin;
}

/**
 * Manual trial extension (entitlement mercy button).
 *
 * Extends the newest subscription row's applicable end date by `days` and —
 * if the row had expired — restores its pre-expiry status so the device is
 * live again. Clients pick it up on their next refresh / realtime event;
 * the raw boundary stays the single source of truth everywhere.
 */
export async function extendTrialAction(
  childDeviceId: string,
  days: number,
): Promise<{ ok: boolean; message: string }> {
  await guard();
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    return { ok: false, message: "Days must be between 1 and 365." };
  }

  const db = createServiceClient();
  const { data: rows, error: fetchErr } = await db
    .from("subscriptions")
    .select("*")
    .eq("child_device_id", childDeviceId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (fetchErr) return { ok: false, message: fetchErr.message };
  const row = (rows ?? [])[0];
  if (!row) return { ok: false, message: "No subscription row for this child." };

  const isTrialOrigin = row.trial_ends_at !== null;
  const baseIso = isTrialOrigin ? row.trial_ends_at : row.expires_at;
  const base = baseIso ? new Date(baseIso).getTime() : Date.now();
  const extended = new Date(Math.max(base, Date.now()) + days * 86400_000).toISOString();

  const patch = isTrialOrigin
    ? {
        status: "trial" as const,
        trial_ends_at: extended,
        expires_at: extended, // trial rows mirror the boundary (mobile rule)
        updated_at: new Date().toISOString(),
      }
    : {
        status: "active" as const,
        expires_at: extended,
        updated_at: new Date().toISOString(),
      };

  const { error } = await db
    .from("subscriptions")
    .update(patch)
    .eq("id", row.id);

  revalidatePath("/admin/devices");
  if (!error) {
    await writeAudit({
      action: "subscription_extend",
      scope: "devices",
      description: `Subscription extended by ${days} days → ${extended.slice(0, 10)} (${isTrialOrigin ? "trial" : "paid"} boundary)`,
      metadata: {
        child_device_id: childDeviceId,
        subscription_id: row.id,
        days,
        boundary: isTrialOrigin ? "trial_ends_at" : "expires_at",
        new_end: extended,
      },
    });
  }
  return error
    ? { ok: false, message: error.message }
    : { ok: true, message: `Extended by ${days} days → ${extended.slice(0, 10)}.` };
}

/**
 * Revoke the plan: flips the newest row to 'cancelled' while KEEPING its
 * dates — the mobile gate treats cancellation as an explicit revocation
 * (parent locks instantly mid-period; the child finishes its compassionate
 * boundary + grace). Dates stay for the audit trail.
 */
export async function revokePlanAction(
  childDeviceId: string,
): Promise<{ ok: boolean; message: string }> {
  await guard();

  const db = createServiceClient();
  const { data: rows, error: fetchErr } = await db
    .from("subscriptions")
    .select("id")
    .eq("child_device_id", childDeviceId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (fetchErr) return { ok: false, message: fetchErr.message };
  const row = (rows ?? [])[0];
  if (!row) return { ok: false, message: "No subscription row for this child." };

  const { error } = await db
    .from("subscriptions")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", row.id);

  revalidatePath("/admin/devices");
  if (!error) {
    await writeAudit({
      action: "subscription_revoke",
      scope: "devices",
      description: `Plan revoked (cancelled) for child ${childDeviceId} — devices lock on next sync`,
      metadata: { child_device_id: childDeviceId, subscription_id: row.id },
    });
  }
  return error
    ? { ok: false, message: error.message }
    : { ok: true, message: "Plan revoked (cancelled) — devices lock on next sync." };
}
