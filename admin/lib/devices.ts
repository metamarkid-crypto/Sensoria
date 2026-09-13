import { createServiceClient } from "@/lib/supabase/server";
import type {
  DeviceRow,
  ChildProfileRow,
  FamilyLinkRow,
  SubscriptionRow,
  SubscriptionStatus,
} from "@/lib/types";

/** For a PARENT row: one linked child's minimal story. */
export interface DeviceChildSummary {
  deviceId: string;
  nickname: string | null;
  fullName: string | null;
  subscriptionStatus: SubscriptionStatus | null;
}

export interface DeviceListItem {
  device: DeviceRow;
  profile: ChildProfileRow | null;
  parentLabels: string[];
  /** Slot capacity per the Combo rule (devices.max_parent_slots). */
  slotsUsed: number;
  maxParentSlots: number;
  /** First linked parent's contact row (child_devices) — one number per family. */
  parentContact: { name: string | null; phone: string | null } | null;
  /** PARENT rows only: the children this device monitors. */
  children: DeviceChildSummary[];
  subscription: {
    status: SubscriptionStatus;
    planId: string | null;
    trialEndsAt: string | null;
    expiresAt: string | null;
  } | null;
  customWordCount: number;
}

export interface FleetStats {
  totalDevices: number;
  children: number;
  parents: number;
  online24h: number;
}

/**
 * The whole fleet in one service-role fetch set, joined in JS (tables are
 * small at this scale; avoids N+1 and view creation).
 */
export async function getFleet(): Promise<{
  items: DeviceListItem[];
  stats: FleetStats;
}> {
  const db = createServiceClient();

  const [devices, profiles, links, subs, words, contacts] = await Promise.all([
    db.from("devices").select("*").order("created_at", { ascending: false }).limit(1000),
    db.from("child_profiles").select("*"),
    db.from("family_links").select("*"),
    db.from("subscriptions").select("*").order("created_at", { ascending: false }),
    db.from("custom_words").select("id, child_device_id"),
    // Contact registry (20260913_parent_contacts.sql) — tolerant of a
    // pending migration: a null result just leaves contacts empty.
    db
      .from("child_devices")
      .select("parent_device_id, parent_name, parent_phone"),
  ]);

  for (const res of [devices, profiles, links, subs, words]) {
    if (res.error) throw res.error;
  }

  const profileByDevice = new Map(
    ((profiles.data ?? []) as ChildProfileRow[]).map((p) => [p.device_id, p]),
  );
  const linksByChild = new Map<string, FamilyLinkRow[]>();
  for (const l of (links.data ?? []) as FamilyLinkRow[]) {
    const list = linksByChild.get(l.child_device_id) ?? [];
    list.push(l);
    linksByChild.set(l.child_device_id, list);
  }
  const subByChild = new Map<string, SubscriptionRow>();
  for (const s of (subs.data ?? []) as SubscriptionRow[]) {
    // queries are newest-first — first hit per child is the newest row
    if (!subByChild.has(s.child_device_id)) subByChild.set(s.child_device_id, s);
  }
  const wordCount = new Map<string, number>();
  for (const w of (words.data ?? []) as Array<{ child_device_id: string }>) {
    wordCount.set(w.child_device_id, (wordCount.get(w.child_device_id) ?? 0) + 1);
  }

  // Family topology: distinct linked children per parent device (a parent can
  // be linked to several children; each consumes one slot on that child).
  const childIdsByParent = new Map<string, string[]>();
  for (const l of (links.data ?? []) as FamilyLinkRow[]) {
    const list = childIdsByParent.get(l.parent_device_id) ?? [];
    if (!list.includes(l.child_device_id)) list.push(l.child_device_id);
    childIdsByParent.set(l.parent_device_id, list);
  }

  // Contact map (parent_device_id → its registry row), degraded safely.
  const contactByParent = new Map<string, { name: string | null; phone: string | null }>();
  if (!contacts.error) {
    for (const c of (contacts.data ?? []) as Array<{
      parent_device_id: string;
      parent_name: string | null;
      parent_phone: string | null;
    }>) {
      contactByParent.set(c.parent_device_id, {
        name: c.parent_name,
        phone: c.parent_phone,
      });
    }
  }

  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const profileList = (profiles.data ?? []) as ChildProfileRow[];
  const items: DeviceListItem[] = ((devices.data ?? []) as DeviceRow[]).map(
    (device) => {
      const sub = subByChild.get(device.id);
      const myLinks = linksByChild.get(device.id) ?? [];
      const childIds = childIdsByParent.get(device.id) ?? [];
      // "One number per family": the first linked parent that has a contact
      // row on file (rows sync automatically from family_links).
      const contact =
        myLinks
          .map((l) => contactByParent.get(l.parent_device_id))
          .find((c) => c && (c.phone || c.name)) ?? null;
      return {
        device,
        profile: profileByDevice.get(device.id) ?? null,
        parentLabels: myLinks.map((l) => l.parent_label ?? "Parent"),
        slotsUsed: myLinks.length,
        maxParentSlots: device.max_parent_slots,
        parentContact: contact,
        children: device.role === "Parent"
          ? childIds.map((id) => {
              const p = profileByDevice.get(id) ?? null;
              const cs = subByChild.get(id) ?? null;
              return {
                deviceId: id,
                nickname: p?.nickname ?? null,
                fullName: p?.full_name ?? null,
                subscriptionStatus: cs?.status ?? null,
              };
            })
          : [],
        subscription: sub
          ? {
              status: sub.status,
              planId: sub.plan_id,
              trialEndsAt: sub.trial_ends_at,
              expiresAt: sub.expires_at,
            }
          : null,
        customWordCount: wordCount.get(device.id) ?? 0,
      };
    },
  );

  const stats: FleetStats = {
    totalDevices: items.length,
    children: items.filter((i) => i.device.role === "Child").length,
    parents: items.filter((i) => i.device.role === "Parent").length,
    online24h: items.filter(
      (i) =>
        i.device.last_seen &&
        new Date(i.device.last_seen).getTime() >= since24h,
    ).length,
  };

  return { items, stats };
}
