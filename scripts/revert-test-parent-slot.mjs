/**
 * CLEANUP ONLY — reverts the "+1 slot" grant written during the
 * post-migration verification: sets max_parent_slots back to 1 for the one
 * child device, ONLY if it currently reads 2 (guarded, prints counts,
 * never keys).
 *
 * Usage: node scripts/revert-test-parent-slot.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const CHILD_DEVICE_ID = "bdaf90f6"; // short code; resolved to full uuid

const envText = readFileSync(new URL("../admin/.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Fleet is tiny — pull children and resolve the short code client-side.
const { data: children, error: devErr } = await db
  .from("devices")
  .select("id, role, max_parent_slots")
  .eq("role", "Child");

if (devErr) {
  console.log("RESOLVE_ERR", devErr.code);
  process.exit(1);
}
const child = (children ?? []).find((d) => String(d.id).startsWith(CHILD_DEVICE_ID));
if (!child) {
  console.log("ABORT child_not_found");
  process.exit(1);
}
if (child.max_parent_slots !== 2) {
  console.log("ABORT capacity_is", child.max_parent_slots, "— nothing to revert");
  process.exit(1);
}

const { data, error } = await db
  .from("devices")
  .update({ max_parent_slots: 1 })
  .eq("id", child.id)
  .eq("max_parent_slots", 2) // re-guard inside the update
  .select("id");

if (error) {
  console.log("UPDATE_ERR", error.code);
  process.exit(1);
}

console.log("REVERTED_ROWS", data?.length ?? 0, "CHILD", String(child.id).slice(0, 8), "capacity 2 → 1");
