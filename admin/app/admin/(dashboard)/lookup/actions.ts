"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull, requireOwner, OwnerRequiredError } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import {
  getDeviceDossier,
  getEmergencyLocation,
  searchDevices,
  type DeviceDossier,
  type LookupResultItem,
  type EmergencyLocation,
} from "@/lib/lookup";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Search wrapper — pairing code, device id, nickname, or full name. */
export async function searchDevicesAction(
  query: string,
): Promise<LookupResultItem[]> {
  const admin = await getAdminOrNull();
  if (!admin) return [];
  return searchDevices(query.slice(0, 80));
}

/** Server-action wrapper so the client page can fetch a dossier. */
export async function getDeviceDossierAction(
  deviceId: string,
): Promise<DeviceDossier | null> {
  const admin = await getAdminOrNull();
  if (!admin) return null;
  if (!UUID_RE.test(deviceId)) return null;
  return getDeviceDossier(deviceId);
}

/**
 * EMERGENCY TRACKING (Owner-only) — the dashboard's only path to a raw
 * coordinate pair. Every call is audited with the operator's stated reason.
 * Returns null both for "no fix" and "not authorized" (the audit trail is
 * the distinguishing signal, not the response shape).
 */
export async function emergencyLocateAction(
  deviceId: string,
  reason: string,
): Promise<EmergencyLocation | null> {
  try {
    const actor = await requireOwner();
    if (!UUID_RE.test(deviceId)) return null;
    const trimmed = reason.trim().slice(0, 500);
    if (!trimmed) return null; // a stated reason is mandatory

    const loc = await getEmergencyLocation(deviceId);
    if (loc) {
      await writeAudit({
        action: "emergency_locate",
        scope: "privacy",
        description: `Emergency location accessed for device ${deviceId} — reason: ${trimmed}`,
        actorEmail: actor.email,
        metadata: {
          device_id: deviceId,
          reason: trimmed,
          source: loc.source,
          fix_age_minutes: loc.recordedAt
            ? Math.round((Date.now() - new Date(loc.recordedAt).getTime()) / 60000)
            : null,
        },
      });
    }
    return loc;
  } catch {
    return null;
  }
}

/**
 * Parent contact registry (child_devices). Rows exist for every linked
 * parent device (synced by trigger); the mobile app can also write its OWN
 * phone from the Parent app — the dashboard completes/fixes the rest.
 */
export interface UpdateParentContactResult {
  ok: boolean;
  message: string;
}

export async function updateParentContactAction(
  parentDeviceId: string,
  input: { name: string; phone: string },
): Promise<UpdateParentContactResult> {
  try {
    const actor = await requireOwner();
    if (!UUID_RE.test(parentDeviceId)) {
      return { ok: false, message: "Invalid parent device id." };
    }
    const name = input.name.trim().slice(0, 120);
    const phone = input.phone.trim().slice(0, 32);
    if (!phone) return { ok: false, message: "Phone is required." };
    if (!/^[+]?[0-9 ()-]{7,32}$/.test(phone)) {
      return { ok: false, message: "Phone looks invalid — use digits, optional leading +." };
    }

    // Verify the device actually exists and IS a parent device.
    const db = createServiceClient();
    const { data: device, error: devErr } = await db
      .from("devices")
      .select("id, role")
      .eq("id", parentDeviceId)
      .maybeSingle();
    if (devErr) return { ok: false, message: devErr.message };
    if (!device) return { ok: false, message: "Parent device not found." };
    if (device.role !== "Parent") {
      return { ok: false, message: "That device is a child device — contacts belong to parents." };
    }

    const { error } = await db
      .from("child_devices")
      .upsert(
        { parent_device_id: parentDeviceId, parent_name: name || null, parent_phone: phone },
        { onConflict: "parent_device_id" },
      );
    if (error) {
      return {
        ok: false,
        message: error.code === "42P01"
          ? "child_devices table not present — run 20260913_parent_contacts.sql first."
          : error.message,
      };    }

    await writeAudit({
      action: "parent_contact_update",
      scope: "family",
      description: `Parent contact saved for device ${parentDeviceId} — ${name || "(no name)"}, ${phone}`,
      actorEmail: actor.email,
      metadata: { parent_device_id: parentDeviceId, name: name || null, phone },
    });
    return { ok: true, message: "Contact saved." };
  } catch (err) {
    if (err instanceof OwnerRequiredError) return { ok: false, message: err.message };
    return { ok: false, message: "Could not save the contact — check the server logs." };
  }
}

/**
 * MANUAL slot grant (Owner-only) — the dashboard mercy path for
 * support/compensation. Families normally purchase the "Slot Parent +1"
 * pack; this bumps devices.max_parent_slots directly. PERMANENT (same
 * semantics as a purchase), so it is confirmed in the UI and audited.
 */
export async function grantParentSlotAction(
  childDeviceId: string,
  slots: number,
): Promise<{ ok: boolean; message: string }> {
  try {
    const actor = await requireOwner();
    if (!UUID_RE.test(childDeviceId)) {
      return { ok: false, message: "Invalid device id." };
    }
    if (!Number.isInteger(slots) || slots < 1 || slots > 2) {
      return { ok: false, message: "Grant 1 or 2 slots." };
    }

    const db = createServiceClient();
    const { data: device, error: devErr } = await db
      .from("devices")
      .select("id, role, max_parent_slots")
      .eq("id", childDeviceId)
      .maybeSingle();
    if (devErr) return { ok: false, message: devErr.message };
    if (!device) return { ok: false, message: "Device not found." };
    if (device.role !== "Child") {
      return { ok: false, message: "Slots belong to child devices." };
    }
    const before = device.max_parent_slots ?? 1;
    const after = Math.min(10, before + slots);
    if (after === before) {
      return { ok: false, message: "Slot cap (10) reached — use the enforcement trigger as the real limit." };
    }

    const { error } = await db
      .from("devices")
      .update({ max_parent_slots: after })
      .eq("id", childDeviceId);
    if (error) return { ok: false, message: error.message };

    revalidatePath("/admin/devices");
    revalidatePath("/admin/lookup");
    await writeAudit({
      action: "parent_slot_grant",
      scope: "family",
      description: `max_parent_slots ${before} → ${after} for child ${childDeviceId} (manual Owner grant — no ledger entry)`,
      actorEmail: actor.email,
      metadata: { child_device_id: childDeviceId, before, after, slots },
    });
    return { ok: true, message: `Granted +${slots} slot — capacity is now ${after}.` };
  } catch (err) {
    if (err instanceof OwnerRequiredError) return { ok: false, message: err.message };
    return { ok: false, message: "Could not grant the slot — check the server logs." };
  }
}

export interface PurgeLocationsResult {
  ok: boolean;
  message: string;
  deletedHistory?: number;
}

/**
 * Privacy erase — remove ALL location data of one child device (Owner-only).
 *
 * Covers both storage places:
 *   • public.locations — the GPS history rows;
 *   • devices.latitude/longitude/last_address — the live presence columns
 *     (set to NULL; last_seen is KEPT so fleet activity stats stay true).
 *
 * The client recomputes its own state; wiping these columns only makes the
 * Parent's map show "no location yet" for the child, which is exactly the
 * requested outcome of a data-deletion request.
 */
export async function purgeDeviceLocationsAction(
  deviceId: string,
): Promise<PurgeLocationsResult> {
  try {
    const actor = await requireOwner();

    if (!UUID_RE.test(deviceId)) {
      return { ok: false, message: "Invalid device id." };
    }

    const db = createServiceClient();

    const { data: device } = await db
      .from("devices")
      .select("id, role")
      .eq("id", deviceId)
      .maybeSingle();
    if (!device) return { ok: false, message: "Device not found." };

    // 1) GPS history rows.
    const { data: deleted, error: histError } = await db
      .from("locations")
      .delete()
      .eq("child_device_id", deviceId)
      .select("id");
    if (histError) {
      return {
        ok: false,
        message: `History purge failed: ${histError.message} (is 20260906_background_location.sql applied?)`,
      };
    }
    const deletedHistory = deleted?.length ?? 0;

    // 2) Live presence coordinates on the device row (keep last_seen).
    const { error: devError } = await db
      .from("devices")
      .update({ latitude: null, longitude: null, last_address: null })
      .eq("id", deviceId);
    if (devError) {
      return { ok: false, message: `Presence wipe failed: ${devError.message}` };
    }

    revalidatePath("/admin/lookup");
    revalidatePath("/admin/devices");
    await writeAudit({
      action: "privacy_purge_locations",
      scope: "privacy",
      description: `All location data purged for device ${deviceId} (${deletedHistory} history rows + presence columns)`,
      actorEmail: actor.email,
      metadata: { device_id: deviceId, deleted_history_rows: deletedHistory },
    });

    return {
      ok: true,
      deletedHistory,
      message: `Purged ${deletedHistory} location rows and the live coordinates for this device.`,
    };
  } catch (err) {
    if (err instanceof OwnerRequiredError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: "Purge failed unexpectedly — check the server logs." };
  }
}
