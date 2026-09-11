"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull } from "@/lib/auth";

async function guard() {
  const admin = await getAdminOrNull();
  if (!admin) throw new Error("Unauthorized");
  return admin;
}

export type SettingsPatch = {
  web_payment_active?: boolean;
  maintenance_mode?: boolean;
  announcement_active?: boolean;
  announcement_text?: string;
  trial_duration_days?: number;
  child_grace_period_days?: number;
};

export async function updateSettingsAction(
  patch: SettingsPatch,
): Promise<{ ok: boolean; message: string }> {
  await guard();

  if (
    patch.trial_duration_days !== undefined &&
    (!Number.isFinite(patch.trial_duration_days) || patch.trial_duration_days < 0)
  ) {
    return { ok: false, message: "Trial days must be ≥ 0." };
  }
  if (
    patch.child_grace_period_days !== undefined &&
    (!Number.isFinite(patch.child_grace_period_days) || patch.child_grace_period_days < 0)
  ) {
    return { ok: false, message: "Grace days must be ≥ 0." };
  }

  const db = createServiceClient();
  const { error } = await db
    .from("app_settings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", true); // single-row guard

  revalidatePath("/admin/settings");
  return error
    ? { ok: false, message: error.message }
    : { ok: true, message: "Settings applied — live apps pick this up on next refresh." };
}
