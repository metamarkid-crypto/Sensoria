import { createServiceClient } from "@/lib/supabase/server";
import type { AppSettingsRow } from "@/lib/types";
import AdminSettingsPanel from "./AdminSettingsPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const db = createServiceClient();
  const { data, error } = await db
    .from("app_settings")
    .select("*")
    .eq("id", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return (
      <div className="glass-card p-6 text-sm text-rose-300">
        app_settings row missing — run the base subscription migration first.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">App Configuration</h1>
        <p className="mt-1 text-sm text-slate-400">
          Live switches for every deployed app — changes apply on the next
          client refresh, no app update needed.
        </p>
      </header>
      <AdminSettingsPanel settings={data as AppSettingsRow} />
    </div>
  );
}
