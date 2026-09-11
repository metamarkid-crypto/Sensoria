"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull } from "@/lib/auth";

async function guard() {
  const admin = await getAdminOrNull();
  if (!admin) throw new Error("Unauthorized");
  return admin;
}

export async function upsertPlanAction(input: {
  id?: string;
  name: string;
  description: string | null;
  duration_months: number;
  price: number;
  currency: string;
}): Promise<{ ok: boolean; message: string }> {
  await guard();

  if (!input.name.trim()) return { ok: false, message: "Name is required." };
  if (![1, 6, 12].includes(input.duration_months)) {
    return { ok: false, message: "Duration must be 1, 6, or 12 months." };
  }
  if (input.price < 0) return { ok: false, message: "Price must be ≥ 0." };

  const db = createServiceClient();
  const { error } = await db.from("plans").upsert({
    ...(input.id ? { id: input.id } : {}),
    name: input.name.trim(),
    description: input.description,
    duration_months: input.duration_months,
    price: input.price,
    currency: input.currency || "IDR",
  });

  revalidatePath("/admin/subscriptions");
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
  return error
    ? { ok: false, message: error.message }
    : { ok: true, message: isActive ? "Plan enabled." : "Plan hidden from the paywall." };
}
