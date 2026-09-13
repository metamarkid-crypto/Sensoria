import { supabase } from './supabase';
import type { DeviceRow } from './types';

/** Row shape of `public.plans` WHERE kind = 'slots' (one-time slot packs). */
export interface SlotPackRow {
  id: string;
  name: string;
  description: string | null;
  /** Extra parent slots this pack grants (1 for the seeded Rp 25.000 pack). */
  slot_count: number;
  price: number;
  currency: string;
  is_active: boolean;
}

/**
 * Parent-Slot service — Slot-Based Parent Expansion (Master Blueprint).
 *
 * A Child device accepts `devices.max_parent_slots` linked Parents (default 1).
 * Extra slots are PERMANENT one-time add-ons ("Slot Parent +1", plans.kind =
 * 'slots'), purchased via the SAME QRIS flow as Combo plans:
 *   • checkout:  POST { device_id, plan_id } → QRIS image (no gateway SDK);
 *   • settle:    the QRIS backend calls apply_parent_slot_purchase() with the
 *                service role, bumping devices.max_parent_slots;
 *   • verify:    re-read THIS device's row — capacity grew ⇒ paid.
 *
 * Everything here degrades gracefully when 20260913_parent_slot_packs.sql has
 * not been applied yet: the capacity check returns a conservative UNKNOWN that
 * HIDES the buy button, and plan fetches return an empty list — the pairing
 * flow keeps working exactly as before.
 */

export interface ChildSlotState {
  /** Linked parent rows (family_links) for this child. */
  linkedParents: Array<{ id: string; parent_label: string | null }>;
  /** Configured capacity; null = unknown (migration not applied). */
  maxParentSlots: number | null;
  /** null maxParentSlots ⇒ capacity unknown ⇒ never auto-show the paywall. */
  atCapacity: boolean | null;
}

/**
 * Read the child's slot state. Reads family_links (always exists) and
 * devices.max_parent_slots (may be missing pre-migration — tolerated).
 */
export const fetchChildSlotState = async (
  childDeviceId: string,
): Promise<ChildSlotState> => {
  const [linksRes, deviceRes] = await Promise.all([
    supabase
      .from('family_links')
      .select('id, parent_label')
      .eq('child_device_id', childDeviceId),
    supabase
      .from('devices')
      .select('max_parent_slots')
      .eq('id', childDeviceId)
      .maybeSingle(),
  ]);

  // capacityKnown = the devices row exists AND carried a numeric max.
  const capacity =
    !deviceRes.error && deviceRes.data && typeof deviceRes.data.max_parent_slots === 'number'
      ? deviceRes.data.max_parent_slots
      : null;  const linkedParents = (linksRes.data ?? []) as Array<{
    id: string;
    parent_label: string | null;
  }>; 

  return {
    linkedParents,
    maxParentSlots: capacity,
    atCapacity: capacity === null ? null : linkedParents.length >= capacity,
  };
};

/**
 * The active slot-pack plans (kind = 'slots'), cheapest first.
 * Degrades to [] when plans.kind does not exist yet (PostgREST error) or the
 * table is unreachable — the buy button then renders its own retry state.
 */
export const fetchActiveSlotPlans = async (): Promise<SlotPackRow[]> => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .eq('is_active', true)
      .eq('kind', 'slots')
      .order('slot_count', { ascending: true })
      .order('price', { ascending: true });

    if (error) throw error;
    return (data ?? []) as SlotPackRow[];
  } catch {
    // plans.kind missing pre-migration (PGRST204/42703) or offline → [].
    return [];
  }
};
