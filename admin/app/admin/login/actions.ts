"use server";

import { redirect } from "next/navigation";
import { createAdminAuthClient } from "@/lib/supabase/server";

export async function signInAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) redirect("/admin/login?error=missing");

  const supabase = await createAdminAuthClient();
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) redirect(`/admin/login?error=invalid`);
  redirect("/admin");
}

export async function signOutAction() {
  const supabase = await createAdminAuthClient();
  await supabase.auth.signOut();
  redirect("/admin/login");
}
