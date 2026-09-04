/**
 * Conceptual Supabase row types — Subscription Architecture (Master Blueprint).
 *
 * These interfaces mirror the actual Postgres columns (snake_case, matching every
 * other table in the app) so Supabase rows map 1:1 onto them. The matching DDL
 * lives in `supabase/migrations/20260904_subscription_architecture.sql`.
 *
 * Entitlement rule (Combo Package): a subscription row is keyed by
 * `child_device_id` only. Any Parent linked to that child through `family_links`
 * inherits premium automatically — no per-parent subscription rows.
 */

export type DeviceRole = 'Child' | 'Parent';

/** Row shape of `public.devices`. */
export interface DeviceRow {
  id: string;
  role: DeviceRole;
  pairing_code: string | null;
  latitude: number | null;
  longitude: number | null;
  last_address: string | null;
  last_seen: string | null;
  /**
   * Slot-Based Parent Expansion: max linked Parent devices per Child.
   * Defaults to 1; expanded via one-time add-on purchases.
   */
  max_parent_slots: number;
  created_at: string;
}

/** Row shape of `public.app_settings` (single-row global config). */
export interface AppSettingsRow {
  /** Single-row guard: always `true` so only one settings row exists. */
  id: boolean;
  /**
   * Stealth Mode kill-switch for external (off-app) payment links.
   * `false` during App Review (paywall hidden), flipped to `true` post-approval.
   */
  web_payment_active: boolean;
  /** Free-trial length in days, dynamic from the setup table (default 1). */
  trial_duration_days: number;
  updated_at: string;
}

/** Row shape of `public.plans` — paid Combo subscription packages. */
export interface SubscriptionPlanRow {
  id: string;
  /** e.g. "Combo 1 Bulan", "Combo 6 Bulan", "Combo 12 Bulan". */
  name: string;
  description: string | null;
  /** 1 | 6 | 12 */
  duration_months: number;
  /** Displayed price (minor-currency-agnostic: store what the checkout charges). */
  price: number;
  currency: string;
  is_active: boolean;
  created_at: string;
}

export type SubscriptionStatus = 'trial' | 'active' | 'expired' | 'cancelled';

/** Row shape of `public.subscriptions` — one row per Child node. */
export interface SubscriptionRow {
  id: string;
  /** Combo key: covers this Child + every Parent linked via family_links. */
  child_device_id: string;
  /** NULL while on the free trial; set once a paid plan is purchased. */
  plan_id: string | null;
  status: SubscriptionStatus;
  starts_at: string;
  /** When the injected free trial expires (status = 'trial'). */
  trial_ends_at: string | null;
  /** End of the current paid period (status = 'active'). */
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}
