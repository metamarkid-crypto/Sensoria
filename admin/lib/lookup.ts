import { createServiceClient } from "@/lib/supabase/server";
import type {
  DeviceRow,
  DeviceRole,
  SubscriptionRow,
  SubscriptionStatus,
  TransactionStatus,
} from "@/lib/types";

/**
 * Support Lookup — one search, the whole story of a device
 * (family links with REAL parent identity, subscriptions, transactions,
 * recent locations) in a single timeline.
 *
 * PRIVACY CONTRACT (Play Families / data-safety):
 *   • Raw coordinates (devices.latitude/longitude, locations.latitude/
 *     longitude) are NEVER selected into this module. The dossier carries
 *     the reverse-geocoded `address` / `last_address` only — enough for
 *     support conversations, useless for tracking.
 *   • Location HISTORY is capped (20 newest) and can be purged per device
 *     by the Owner (see lookup/actions.ts); the 30-day pg_cron retention is
 *     the passive half of the same policy.
 *   • Parent phone numbers are support-contact data: shown to signed-in
 *     admins only (every entry point is getAdminOrNull-guarded), never in
 *     any client-facing mobile surface.
 *
 * GRACEFUL DEGRADATION: tables/columns added by pending migrations
 * (child_devices, locations, plans.kind) are tolerated — the dossier
 * renders with a note instead of crashing.
 */

export interface LookupResultItem {
  deviceId: string;
  role: DeviceRole;
  nickname: string | null;
  fullName: string | null;
  pairingCode: string | null;
  lastSeen: string | null;
  lastAddress: string | null;
  matchOn:
    | "pairing_code"
    | "device_id"
    | "nickname"
    | "full_name"
    | "parent_phone"
    | "parent_name";
  /** For Child results: how many parent devices are linked. */
  parentCount: number | null;
  /** For Parent results: how many children they monitor. */
  linkedChildCount: number | null;
  /** Parent contact registry row (child_devices), when present. */
  contact: { name: string | null; phone: string | null } | null;
}

export interface DossierTransaction {
  ref: string;
  planName: string | null;
  /** "slots" purchases are permanent add-ons, not subscription time. */
  planKind: "combo" | "slots" | null;
  slotCount: number | null;
  amount: number;
  currency: string;
  status: TransactionStatus;
  gateway: string;
  createdAt: string;
  paidAt: string | null;
  refundedTotal: number;
}

export interface DossierSubscription {
  id: string;
  status: SubscriptionStatus;
  planName: string | null;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
}

export type TimelineTone = "good" | "warn" | "bad" | "neutral" | "teal" | "violet";

/**
 * EMERGENCY TRACKING payload. The ONLY shape in this codebase that carries
 * raw coordinates to the dashboard — produced exclusively by
 * getEmergencyLocation(), never by getDeviceDossier()/searchDevices().
 */
export interface EmergencyLocation {
  lat: number;
  lng: number;
  accuracy: number | null;
  address: string | null;
  recordedAt: string | null;
  /** "live" = devices presence columns, "history" = newest locations row. */
  source: "live" | "history";
}

export interface TimelineItem {
  kind: "subscription" | "transaction" | "location" | "family";
  at: string;
  title: string;
  detail: string | null;
  tone: TimelineTone;
}

/** One family_links row enriched with the parent device + contact info. */
export interface LinkedParentDetail {
  linkId: string;
  parentDeviceId: string;
  label: string | null;
  linkedAt: string;
  parentLastSeen: string | null;
  parentPairingCode: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactUpdatedAt: string | null;
}

/** For a PARENT dossier: the children this device monitors. */
export interface LinkedChildSummary {
  deviceId: string;
  nickname: string | null;
  fullName: string | null;
  pairingCode: string | null;
  lastSeen: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  planName: string | null;
  endsAt: string | null;
}

export interface DeviceDossier {
  device: {
    id: string;
    role: DeviceRole;
    pairingCode: string | null;
    lastSeen: string | null;
    lastAddress: string | null; // reverse-geocoded text, never coordinates
    maxParentSlots: number;
    createdAt: string;
  };
  profile: { nickname: string | null; fullName: string | null } | null;
  /** Raw labels only ("Ibu", "Ayah") — kept for compatibility. */
  parents: string[];
  /** THE ANSWER to "which parent is linked, and how do I reach them?" */
  parentDetails: LinkedParentDetail[];
  /** For Parent devices: which children they monitor. */
  linkedChildren: LinkedChildSummary[];
  /** This parent device's own contact row (child_devices), when present. */
  ownContact: {
    name: string | null;
    phone: string | null;
    updatedAt: string | null;
  } | null;
  /** false when the child_devices table is missing (migration not run). */
  contactsAvailable: boolean;
  currentSubscription: DossierSubscription | null;
  subscriptionHistory: DossierSubscription[];
  transactions: DossierTransaction[];
  recentAddresses: Array<{ address: string | null; recordedAt: string }>;
  /** false when the locations table is missing (older deployment). */
  locationsAvailable: boolean;
  timeline: TimelineItem[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Human dates inside timeline details (id-ID, same style as the tables). */
const formatDateTime = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("id-ID", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso))
    : "—";

function toLookupResult(
  d: DeviceRow,
  profile: { nickname: string | null; full_name: string | null } | null,
  matchOn: LookupResultItem["matchOn"],
): LookupResultItem {
  return {
    deviceId: d.id,
    role: d.role,
    nickname: profile?.nickname ?? null,
    fullName: profile?.full_name ?? null,
    pairingCode: d.pairing_code,
    lastSeen: d.last_seen,
    lastAddress: d.last_address,
    matchOn,
    parentCount: null,
    linkedChildCount: null,
    contact: null,
  };
}

interface ContactRow {
  parent_device_id: string;
  parent_name: string | null;
  parent_phone: string | null;
  updated_at?: string | null;
}

/** Tolerant contact fetch — null map when the table is not migrated yet. */
async function fetchContacts(
  db: ReturnType<typeof createServiceClient>,
  parentIds: string[],
): Promise<Map<string, ContactRow>> {
  const map = new Map<string, ContactRow>();
  if (parentIds.length === 0) return map;
  const { data, error } = await db
    .from("child_devices")
    .select("parent_device_id, parent_name, parent_phone, updated_at")
    .in("parent_device_id", parentIds);
  if (error) return map; // migration pending — degrade, don't crash
  for (const c of (data ?? []) as ContactRow[]) {
    map.set(c.parent_device_id, c);
  }
  return map;
}

/**
 * Multi-key search: pairing code, device id (uuid prefix), child nickname,
 * child full name, parent contact name, parent contact phone.
 * Deduped, newest devices first, capped at 10.
 */
export async function searchDevices(query: string): Promise<LookupResultItem[]> {
  const q = query.trim();
  if (!q) return [];

  const db = createServiceClient();
  const like = `%${q}%`;

  const [byPairing, byProfile, byContact] = await Promise.all([
    db
      .from("devices")
      .select("*")
      .or(`pairing_code.ilike.${like},id.ilike.${like}`)
      .order("created_at", { ascending: false })
      .limit(10),
    db
      .from("child_profiles")
      .select("device_id, nickname, full_name")
      .or(`nickname.ilike.${like},full_name.ilike.${like}`)
      .limit(10),
    // Parent contact search (child_devices may not exist yet — tolerated).
    db
      .from("child_devices")
      .select("parent_device_id, parent_name, parent_phone")
      .or(`parent_phone.ilike.${like},parent_name.ilike.${like}`)
      .limit(10),
  ]);

  // Profiles → their device rows (single extra round-trip).
  const profileDeviceIds = [...new Set((byProfile.data ?? []).map((p) => p.device_id))];
  const profileByDevice = new Map(
    (byProfile.data ?? []).map((p) => [p.device_id, p]),
  );
  let profileDevices: DeviceRow[] = [];
  if (profileDeviceIds.length > 0) {
    const { data } = await db
      .from("devices")
      .select("*")
      .in("id", profileDeviceIds)
      .order("created_at", { ascending: false });
    profileDevices = (data ?? []) as DeviceRow[];
  }

  // Contact matches → the parent device rows.
  const contactRows = (byContact.error ? [] : (byContact.data ?? [])) as ContactRow[];
  const contactMatchIds = [...new Set(contactRows.map((c) => c.parent_device_id))];
  let contactDevices: DeviceRow[] = [];
  if (contactMatchIds.length > 0) {
    const { data } = await db
      .from("devices")
      .select("*")
      .in("id", contactMatchIds)
      .order("created_at", { ascending: false });
    contactDevices = (data ?? []) as DeviceRow[];
  }

  // Contact matches → ALSO surface their linked children: a support agent
  // searching "Ibu Ratna" or "+62…" wants the child's story in one click,
  // not just the parent device row.
  const matchedContactByChild = new Map<string, ContactRow>();
  if (contactMatchIds.length > 0) {
    const { data: contactLinks } = await db
      .from("family_links")
      .select("parent_device_id, child_device_id")
      .in("parent_device_id", contactMatchIds);
    for (const l of (contactLinks ?? []) as Array<{
      parent_device_id: string;
      child_device_id: string;
    }>) {
      if (!matchedContactByChild.has(l.child_device_id)) {
        const row = contactRows.find((c) => c.parent_device_id === l.parent_device_id);
        if (row) matchedContactByChild.set(l.child_device_id, row);
      }
    }
  }
  let contactChildDevices: DeviceRow[] = [];
  let contactChildProfiles = new Map<
    string,
    { nickname: string | null; full_name: string | null }
  >();
  if (matchedContactByChild.size > 0) {
    const childIds = [...matchedContactByChild.keys()];
    const [devRes, profRes] = await Promise.all([
      db.from("devices").select("*").in("id", childIds),
      db
        .from("child_profiles")
        .select("device_id, nickname, full_name")
        .in("device_id", childIds),
    ]);
    contactChildDevices = (devRes.data ?? []) as DeviceRow[];
    contactChildProfiles = new Map(
      ((profRes.data ?? []) as Array<{
        device_id: string;
        nickname: string | null;
        full_name: string | null;
      }>).map((p) => [p.device_id, p]),
    );
  }

  const results = new Map<string, LookupResultItem>();
  for (const d of (byPairing.data ?? []) as DeviceRow[]) {
    const matchOn: LookupResultItem["matchOn"] =
      d.pairing_code && d.pairing_code.toLowerCase().includes(q.toLowerCase())
        ? "pairing_code"
        : "device_id";
    results.set(d.id, toLookupResult(d, profileByDevice.get(d.id) ?? null, matchOn));
  }
  for (const d of contactChildDevices) {
    if (results.has(d.id)) continue;
    const row = matchedContactByChild.get(d.id) ?? null;
    const matchOn: LookupResultItem["matchOn"] =
      row?.parent_phone && row.parent_phone.toLowerCase().includes(q.toLowerCase())
        ? "parent_phone"
        : "parent_name";
    results.set(
      d.id,
      toLookupResult(d, profileByDevice.get(d.id) ?? contactChildProfiles.get(d.id) ?? null, matchOn),
    );
  }
  for (const d of profileDevices) {
    if (!results.has(d.id)) {
      const p = profileByDevice.get(d.id) ?? null;
      const matchOn: LookupResultItem["matchOn"] =
        p?.nickname && p.nickname.toLowerCase().includes(q.toLowerCase())
          ? "nickname"
          : "full_name";
      results.set(d.id, toLookupResult(d, p, matchOn));
    }
  }
  for (const d of contactDevices) {
    if (results.has(d.id)) continue;
    const row = contactRows.find((c) => c.parent_device_id === d.id);
    const matchOn: LookupResultItem["matchOn"] =
      row?.parent_phone && row.parent_phone.toLowerCase().includes(q.toLowerCase())
        ? "parent_phone"
        : "parent_name";
    results.set(d.id, toLookupResult(d, null, matchOn));
  }

  // Enrich every result with family counts + contact info (one round-trip
  // each, tolerant of a missing child_devices table).
  const allIds = [...results.keys()];
  if (allIds.length > 0) {
    const idList = allIds.join(",");
    const [linksRes, contactMap] = await Promise.all([
      db
        .from("family_links")
        .select("parent_device_id, child_device_id")
        .or(
          `child_device_id.in.(${idList}),parent_device_id.in.(${idList})`,
        ),
      fetchContacts(db, allIds),
    ]);

    const parentCountById = new Map<string, number>();
    const childCountById = new Map<string, number>();
    for (const l of (linksRes.data ?? []) as Array<{
      parent_device_id: string;
      child_device_id: string;
    }>) {
      parentCountById.set(
        l.child_device_id,
        (parentCountById.get(l.child_device_id) ?? 0) + 1,
      );
      childCountById.set(
        l.parent_device_id,
        (childCountById.get(l.parent_device_id) ?? 0) + 1,
      );
    }

    for (const id of allIds) {
      const item = results.get(id)!;
      const contact = contactMap.get(id);
      item.parentCount = parentCountById.get(id) ?? 0;
      item.linkedChildCount = childCountById.get(id) ?? 0;
      item.contact = contact
        ? { name: contact.parent_name, phone: contact.parent_phone }
        : null;
    }
  }

  return [...results.values()];
}

/**
 * EMERGENCY TRACKING ONLY — missing-child / safety emergency.
 *
 * The single deliberate exception to the privacy contract above: raw
 * coordinates leave the database here and nowhere else. Call sites MUST be
 * Owner-gated and MUST audit the access with a human reason (the server
 * action in lookup/actions.ts enforces both). Never wire this into the
 * regular dossier or the fleet table.
 */
export async function getEmergencyLocation(
  deviceId: string,
): Promise<EmergencyLocation | null> {
  if (!UUID_RE.test(deviceId)) return null;
  const db = createServiceClient();

  // 1) Live presence columns (what the child's own writes keep fresh).
  const { data: dev, error: devErr } = await db
    .from("devices")
    .select("latitude, longitude, last_address, last_seen")
    .eq("id", deviceId)
    .maybeSingle();
  if (!devErr && dev && typeof dev.latitude === "number" && typeof dev.longitude === "number") {
    return {
      lat: dev.latitude,
      lng: dev.longitude,
      accuracy: null,
      address: dev.last_address,
      recordedAt: dev.last_seen,
      source: "live",
    };
  }

  // 2) Fallback: newest history row (tolerates a missing locations table).
  const { data: hist, error: histErr } = await db
    .from("locations")
    .select("latitude, longitude, accuracy, address, recorded_at")
    .eq("child_device_id", deviceId)
    .order("recorded_at", { ascending: false })
    .limit(1);
  const row = (hist ?? [])[0] as
    | {
        latitude: number;
        longitude: number;
        accuracy: number | null;
        address: string | null;
        recorded_at: string;
      }
    | undefined;
  if (histErr || !row) return null;
  return {
    lat: row.latitude,
    lng: row.longitude,
    accuracy: row.accuracy,
    address: row.address,
    recordedAt: row.recorded_at,
    source: "history",
  };
}

const SUB_TONE: Record<SubscriptionStatus, TimelineTone> = {
  trial: "teal",
  active: "good",
  expired: "neutral",
  cancelled: "bad",
};

/**
 * Full dossier for one device — Child OR Parent. Degrades gracefully:
 * missing locations/child_devices tables yield empty sections with the
 * corresponding *Available flags false instead of a crashed page.
 */
export async function getDeviceDossier(
  deviceId: string,
): Promise<DeviceDossier | null> {
  if (!UUID_RE.test(deviceId)) return null;

  const db = createServiceClient();

  const [deviceRes, profileRes] = await Promise.all([
    db.from("devices").select("*").eq("id", deviceId).maybeSingle(),
    db.from("child_profiles").select("*").eq("device_id", deviceId).maybeSingle(),
  ]);
  const device = deviceRes.data as DeviceRow | null;
  if (!device) return null;

  const profile = (profileRes.data as {
    nickname: string | null;
    full_name: string | null;
  } | null) ?? null;

  const isChild = device.role === "Child";

  // ── Family links from THIS device's side ──────────────────────────────────
  const linksRes = await db
    .from("family_links")
    .select("id, parent_device_id, child_device_id, parent_label, created_at")
    .eq(isChild ? "child_device_id" : "parent_device_id", deviceId)
    .order("created_at", { ascending: false });
  const links = (linksRes.data ?? []) as Array<{
    id: string;
    parent_device_id: string;
    child_device_id: string;
    parent_label: string | null;
    created_at: string;
  }>;

  // ── Parent identity + contacts (Child dossiers) ──────────────────────────
  const parentIds = isChild ? [...new Set(links.map((l) => l.parent_device_id))] : [];
  let parentDevicesById = new Map<string, DeviceRow>();
  if (parentIds.length > 0) {
    const { data } = await db
      .from("devices")
      .select("*")
      .in("id", parentIds);
    parentDevicesById = new Map(
      ((data ?? []) as DeviceRow[]).map((d) => [d.id, d]),
    );
  }
  const contactMap = await fetchContacts(db, parentIds);
  let contactsAvailable = true;
  if (parentIds.length > 0) {
    const probe = await db.from("child_devices").select("parent_device_id").limit(1);
    contactsAvailable = !probe.error;
  }

  const parentDetails: LinkedParentDetail[] = isChild
    ? links.map((l) => {
        const pd = parentDevicesById.get(l.parent_device_id);
        const contact = contactMap.get(l.parent_device_id);
        return {
          linkId: l.id,
          parentDeviceId: l.parent_device_id,
          label: l.parent_label,
          linkedAt: l.created_at,
          parentLastSeen: pd?.last_seen ?? null,
          parentPairingCode: pd?.pairing_code ?? null,
          contactName: contact?.parent_name ?? null,
          contactPhone: contact?.parent_phone ?? null,
          contactUpdatedAt: contact?.updated_at ?? null,
        };
      })
    : [];

  // ── Linked children (Parent dossiers) ─────────────────────────────────────
  const childIds = isChild ? [] : [...new Set(links.map((l) => l.child_device_id))];
  let childDevicesById = new Map<string, DeviceRow>();
  let childProfilesById = new Map<string, { nickname: string | null; full_name: string | null }>();
  let newestSubByChild = new Map<string, SubscriptionRow>();
  if (childIds.length > 0) {
    const [devRes, profRes, subRes] = await Promise.all([
      db.from("devices").select("*").in("id", childIds),
      db
        .from("child_profiles")
        .select("device_id, nickname, full_name")
        .in("device_id", childIds),
      db
        .from("subscriptions")
        .select("*")
        .in("child_device_id", childIds)
        .order("created_at", { ascending: false }),
    ]);
    childDevicesById = new Map(((devRes.data ?? []) as DeviceRow[]).map((d) => [d.id, d]));
    childProfilesById = new Map(
      ((profRes.data ?? []) as Array<{
        device_id: string;
        nickname: string | null;
        full_name: string | null;
      }>).map((p) => [p.device_id, p]),
    );
    for (const s of (subRes.data ?? []) as SubscriptionRow[]) {
      if (!newestSubByChild.has(s.child_device_id)) newestSubByChild.set(s.child_device_id, s);
    }
  }

  // This parent's own contact row.
  let ownContact: DeviceDossier["ownContact"] = null;
  if (!isChild) {
    const own = await fetchContacts(db, [deviceId]);
    const row = own.get(deviceId);
    if (row) {
      ownContact = {
        name: row.parent_name,
        phone: row.parent_phone,
        updatedAt: row.updated_at ?? null,
      };
    }
  }

  const [subsRes, txRes, locationsRes] = await Promise.all([
    isChild
      ? db
          .from("subscriptions")
          .select("*")
          .eq("child_device_id", deviceId)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    db
      .from("transactions")
      .select(
        // plans(id, name): both columns predate the slot-pack migration, so
        // kind/slot_count come from the tolerant plan fetch below instead.
        "transaction_ref, amount, currency, status, payment_gateway, created_at, paid_at, plans(id, name)",
      )
      .eq("child_device_id", deviceId)
      .order("created_at", { ascending: false })
      .limit(50),
    // Privacy contract: address + recorded_at ONLY — no coordinates.
    isChild
      ? db
          .from("locations")
          .select("address, recorded_at")
          .eq("child_device_id", deviceId)
          .order("recorded_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Refund totals for the listed transactions (tolerates missing table).
  const txRaw = (txRes.data ?? []) as Array<Record<string, unknown>>;
  const refs = txRaw.map((t) => t.transaction_ref as string);
  const refundedByRef = new Map<string, number>();
  if (refs.length > 0) {
    const { data: refundRows } = await db
      .from("refunds")
      .select("transaction_ref, amount")
      .in("transaction_ref", refs);
    for (const r of (refundRows ?? []) as Array<{
      transaction_ref: string;
      amount: number;
    }>) {
      refundedByRef.set(
        r.transaction_ref,
        (refundedByRef.get(r.transaction_ref) ?? 0) + Number(r.amount),
      );
    }
  }

  // Plan metadata (tolerant of a pre-migration DB without kind/slot_count).
  const planNames = new Map<string, string>();
  const planKind = new Map<string, "combo" | "slots">();
  const planSlots = new Map<string, number>();
  {
    const planRows = await db.from("plans").select("id, name, kind, slot_count");
    if (planRows.error) {
      // Migration pending — names still work, kinds degrade to null.
      const { data: basic } = await db.from("plans").select("id, name");
      for (const p of (basic ?? []) as Array<{ id: string; name: string }>) {
        planNames.set(p.id, p.name);
      }
    } else {
      for (const p of (planRows.data ?? []) as Array<{
        id: string;
        name: string;
        kind: "combo" | "slots";
        slot_count: number | null;
      }>) {
        planNames.set(p.id, p.name);
        planKind.set(p.id, p.kind);
        if (p.slot_count != null) planSlots.set(p.id, p.slot_count);
      }
    }
  }

  const subRows = (subsRes.data ?? []) as SubscriptionRow[];
  const subscriptionHistory: DossierSubscription[] = subRows.map((s) => ({
    id: s.id,
    status: s.status,
    planName: s.plan_id ? (planNames.get(s.plan_id) ?? null) : null,
    startsAt: s.starts_at,
    endsAt: s.status === "trial" ? s.trial_ends_at : s.expires_at,
    createdAt: s.created_at,
  }));

  const linkedChildren: LinkedChildSummary[] = childIds
    .map((id) => {
      const d = childDevicesById.get(id);
      if (!d) return null;
      const p = childProfilesById.get(id) ?? null;
      const sub = newestSubByChild.get(id) ?? null;
      return {
        deviceId: id,
        nickname: p?.nickname ?? null,
        fullName: p?.full_name ?? null,
        pairingCode: d.pairing_code,
        lastSeen: d.last_seen,
        subscriptionStatus: sub?.status ?? null,
        planName: sub?.plan_id ? (planNames.get(sub.plan_id) ?? null) : null,
        endsAt: sub
          ? sub.status === "trial"
            ? sub.trial_ends_at
            : sub.expires_at
          : null,
      } satisfies LinkedChildSummary;
    })
    .filter((c): c is LinkedChildSummary => c !== null);

  const transactions: DossierTransaction[] = txRaw.map((t) => {
    const planId = (t.plans as { id?: string } | null)?.id ?? null;
    const planMeta = (t.plans as { name?: string } | null) ?? null;
    return {
      ref: t.transaction_ref as string,
      planName: planMeta?.name ?? null,
      planKind: planId ? (planKind.get(planId) ?? null) : null,
      slotCount: planId ? (planSlots.get(planId) ?? null) : null,
      amount: Number(t.amount),
      currency: t.currency as string,
      status: t.status as TransactionStatus,
      gateway: t.payment_gateway as string,
      createdAt: t.created_at as string,
      paidAt: (t.paid_at as string | null) ?? null,
      refundedTotal: refundedByRef.get(t.transaction_ref as string) ?? 0,
    };
  });

  const locationsAvailable = !locationsRes.error;
  const recentAddresses = (
    (locationsRes.error ? [] : (locationsRes.data ?? [])) as Array<{
      address: string | null;
      recorded_at: string;
    }>
  ).map((l) => ({ address: l.address, recordedAt: l.recorded_at }));

  // ── Merged timeline (newest first, capped for readability) ──────────────
  const timeline: TimelineItem[] = [];
  for (const s of subscriptionHistory) {
    timeline.push({
      kind: "subscription",
      at: s.createdAt,
      title: `Subscription ${s.status}`,
      detail: s.planName
        ? `${s.planName} — ends ${formatDateTime(s.endsAt)}`
        : `Ends ${formatDateTime(s.endsAt)}`,
      tone: SUB_TONE[s.status],
    });
  }
  for (const t of transactions) {
    timeline.push({
      kind: "transaction",
      at: t.paidAt ?? t.createdAt,
      title:
        t.planKind === "slots"
          ? "Parent slot purchased"
          : t.status === "refunded"
            ? "Payment refunded"
            : t.status === "paid"
              ? "Payment received"
              : t.status === "pending"
                ? "Payment pending"
                : "Payment failed",
      detail: `${t.planName ?? "—"} · ${t.currency} ${t.amount.toLocaleString("id-ID")}${t.refundedTotal > 0 ? ` · refunded ${t.refundedTotal.toLocaleString("id-ID")}` : ""}`,
      tone: t.planKind === "slots" && t.status === "paid"
        ? "teal"
        : t.status === "paid"
          ? "good"
          : t.status === "refunded"
            ? "violet"
            : t.status === "pending"
              ? "warn"
              : "bad",
    });
  }
  for (const l of recentAddresses) {
    timeline.push({
      kind: "location",
      at: l.recordedAt,
      title: "Location ping",
      detail: l.address ?? "(no address resolved)",
      tone: "neutral",
    });
  }
  for (const p of parentDetails) {
    timeline.push({
      kind: "family",
      at: p.linkedAt,
      title: `Parent linked${p.label ? ` — ${p.label}` : ""}`,
      detail: [
        p.contactName ? `name ${p.contactName}` : null,
        p.contactPhone ? `☎ ${p.contactPhone}` : null,
        p.parentPairingCode ? `parent device ${p.parentPairingCode}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null,
      tone: "teal",
    });
  }
  timeline.sort((a, b) => b.at.localeCompare(a.at));

  return {
    device: {
      id: device.id,
      role: device.role,
      pairingCode: device.pairing_code,
      lastSeen: device.last_seen,
      lastAddress: device.last_address,
      maxParentSlots: device.max_parent_slots,
      createdAt: device.created_at,
    },
    profile: profile
      ? { nickname: profile.nickname, fullName: profile.full_name }
      : null,
    parents: parentDetails.map((p) => p.label ?? "Parent"),
    parentDetails,
    linkedChildren,
    ownContact,
    contactsAvailable,
    currentSubscription: subscriptionHistory[0] ?? null,
    subscriptionHistory,
    transactions,
    recentAddresses,
    locationsAvailable,
    timeline: timeline.slice(0, 60),
  };
}
