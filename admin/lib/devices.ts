import { createServiceClient } from "@/lib/supabase/server";
import type {
  DeviceRow,
  ChildProfileRow,
  FamilyLinkRow,
  SubscriptionRow,
  SubscriptionStatus,
} from "@/lib/types";

export interface DeviceListItem {
  device: DeviceRow;
  profile: ChildProfileRow | null;
  parentLabels: string[];
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

  const [devices, profiles, links, subs, words] = await Promise.all([
    db.from("devices").select("*").order("created_at", { ascending: false }).limit(1000),
    db.from("child_profiles").select("*"),
    db.from("family_links").select("*"),
    db.from("subscriptions").select("*").order("created_at", { ascending: false }),
    db.from("custom_words").select("id, child_device_id"),
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

  const since24h = Date.now() - 24 * 60 * 60 * 1000;
  const items: DeviceListItem[] = ((devices.data ?? []) as DeviceRow[]).map(
    (device) => {
      const sub = subByChild.get(device.id);
      return {
        device,
        profile: profileByDevice.get(device.id) ?? null,
        parentLabels: (linksByChild.get(device.id) ?? []).map(
          (l) => l.parent_label ?? "Parent",
        ),
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
