/**
 * CLEANUP ONLY — reverts the labeled TEST contact written during the
 * post-migration verification. Scoped to exactly one parent device row and
 * only touches the two contact columns. Prints counts, never keys.
 *
 * Usage: node scripts/revert-test-parent-contact.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const PARENT_DEVICE_ID = "e7fa4e7f"; // short code shown in the dossier; resolved to full id

const envText = readFileSync(new URL("../admin/.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Resolve the full uuid from the 8-char short code (fleet is tiny — filter client-side).
const { data: parents, error: devErr } = await db
  .from("devices")
  .select("id, role")
  .eq("role", "Parent");

if (devErr) {
  console.log("RESOLVE_ERR", devErr.code);
  process.exit(1);
}
const device = (parents ?? []).find((d) => String(d.id).startsWith(PARENT_DEVICE_ID));

const { data, error } = await db
  .from("child_devices")
  .update({ parent_name: null, parent_phone: null, updated_at: new Date().toISOString() })
  .eq("parent_device_id", device.id)
  .eq("parent_phone", "+62 000 000 0000") // matches ANY labeled TEST contact
  .select("parent_device_id");

if (error) {
  console.log("UPDATE_ERR", error.code);
  process.exit(1);
}

console.log("CLEANED_ROWS", data?.length ?? 0, "PARENT_DEVICE", String(device.id).slice(0, 8));
