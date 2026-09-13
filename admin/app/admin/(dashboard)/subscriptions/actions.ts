"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull, requireOwner, OwnerRequiredError } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

async function guard() {
  const admin = await getAdminOrNull();
  if (!admin) throw new Error("Unauthorized");
  // Pricing is Owner territory — Support is deliberately locked out.
  if (admin.role !== "owner") throw new OwnerRequiredError();
  return admin;
}

export async function upsertPlanAction(input: {
  id?: string;
  name: string;
  description: string | null;
  /** "combo" = subscription time · "slots" = one-time parent-slot pack. */
  kind?: "combo" | "slots";
  duration_months: number;
  /** For kind="slots": how many extra parent slots the pack grants. */
  slot_count?: number | null;
  price: number;
  currency: string;
}): Promise<{ ok: boolean; message: string }> {
  await guard();

  const kind = input.kind ?? "combo";
  if (!input.name.trim()) return { ok: false, message: "Name is required." };
  if (![1, 6, 12].includes(input.duration_months)) {
    return { ok: false, message: "Duration must be 1, 6, or 12 months." };
  }
  if (input.price < 0) return { ok: false, message: "Price must be ≥ 0." };
  if (kind === "slots" && (!input.slot_count || input.slot_count < 1 || input.slot_count > 2)) {
    return { ok: false, message: "Slot packs grant 1 or 2 slots." };
  }

  const db = createServiceClient();
  const { error } = await db.from("plans").upsert({
    ...(input.id ? { id: input.id } : {}),
    name: input.name.trim(),
    description: input.description,
    kind,
    duration_months: input.duration_months,
    // Slot packs have no subscription duration — normalize to 1 (kept for
    // legacy UI surfaces that read duration_months).
    ...(kind === "slots" ? { slot_count: input.slot_count ?? 1 } : {}),
    price: input.price,
    currency: input.currency || "IDR",
  });

  revalidatePath("/admin/subscriptions");
  if (!error) {
    await writeAudit({
      action: "plan_upsert",
      scope: "subscriptions",
      description:
        kind === "slots"
          ? `Slot pack "${input.name.trim()}" ${input.id ? "updated" : "created"} — +${input.slot_count ?? 1} slots @ ${input.price} ${input.currency || "IDR"} (one-time)`
          : `Plan "${input.name.trim()}" ${input.id ? "updated" : "created"} — ${input.duration_months} mo @ ${input.price} ${input.currency || "IDR"}`,
      metadata: {
        plan_id: input.id ?? null,
        plan_name: input.name.trim(),
        kind,
        slot_count: kind === "slots" ? (input.slot_count ?? 1) : null,
        duration_months: input.duration_months,
        price: input.price,
        currency: input.currency || "IDR",
      },
    });
  }
  return error
    ? { ok: false, message: error.message }
    : { ok: true, message: `Plan "${input.name}" saved.` };
}

export async function togglePlanActiveAction(
  id: string,
  isActive: boolean,
): Promise<{ ok: boolean; message: string }> {
  await guard();

  const db = createServiceClient();
  const { error } = await db
    .from("plans")
    .update({ is_active: isActive })
    .eq("id", id);

  revalidatePath("/admin/subscriptions");
  if (!error) {
    await writeAudit({
      action: "plan_toggle",
      scope: "subscriptions",
      description: `Plan ${id} ${isActive ? "enabled" : "hidden from the paywall"}`,
      metadata: { plan_id: id, is_active: isActive },
    });
  }
  return error
    ? { ok: false, message: error.message }
    : { ok: true, message: isActive ? "Plan enabled." : "Plan hidden from the paywall." };
}

/**
 * Mark a month's developer royalty as settled (Owner-only). The amount is
 * RECORDED here — it stays derivable from the ledger, this row is the human
 * agreement that Rp X was actually sent for that month.
 */
export async function markRoyaltyPaidAction(
  periodMonth: string,
  amount: number,
  proofUrl?: string,
  note?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const actor = await requireOwner();

    if (!/^\d{4}-\d{2}$/.test(periodMonth)) {
      return { ok: false, message: "Period must look like YYYY-MM." };
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, message: "Amount must be ≥ 0." };
    }

    const db = createServiceClient();
    const { error } = await db
      .from("royalty_payments")
      .upsert(
        {
          period_month: periodMonth,
          amount,
          status: "paid",
          paid_at: new Date().toISOString(),
          proof_url: proofUrl?.trim() || null,
          note: note?.trim() || null,
          created_by_email: actor.email,
        },
        { onConflict: "period_month" },
      );
    if (error) return { ok: false, message: error.message };

    revalidatePath("/admin/subscriptions");
    revalidatePath("/admin");
    await writeAudit({
      action: "royalty_mark_paid",
      scope: "royalty",
      description: `Royalty ${periodMonth} marked PAID — ${amount} IDR`,
      actorEmail: actor.email,
      metadata: { period_month: periodMonth, amount, proof_url: proofUrl?.trim() || null },
    });
    return { ok: true, message: `Royalty ${periodMonth} marked as paid.` };
  } catch (err) {
    if (err instanceof OwnerRequiredError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: "Could not record the settlement — check the server logs." };
  }
}
