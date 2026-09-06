import { supabase } from './supabase';
import type { SubscriptionRow } from './types';

/**
 * Premium Entitlement Engine — Master Blueprint gating rules.
 *
 * Combo rule: a subscription row is keyed by `child_device_id` ONLY. A Child
 * device evaluates its own row; a Parent device must first resolve the id(s)
 * of its linked child(ren) via `family_links` and then evaluate the child's
 * subscription — parents never carry their own subscription row.
 *
 * Protocol — "Compassionate Child, Strict Parent":
 *  • PARENT node: strict gating, ZERO grace. Local end date in the past ⇒
 *    immediately locked (Paywall when online, hard block when offline).
 *  • CHILD  node: expiresAt + child_grace_period_days (dynamic from
 *    `app_settings`, default 3) of FULL offline AAC access. During grace the
 *    board is untouched (optional subtle nudge banner); past grace ⇒ soft-lock
 *    with a friendly offline-safe message. NEVER shows pricing/Paywall.
 *
 * Offline-first: expiry boundaries (`trialEndsAt` / `expiresAt`) and the grace
 * length are PERSISTED locally. Every gate evaluates those raw boundaries
 * against `Date.now()` — a persisted boolean is never trusted, so time passing
 * while offline always produces the correct phase.
 */

/** Role of the evaluating device — structurally identical to the store's UserRole. */
export type EntitlementRole = 'None' | 'Child' | 'Parent';

/** Fallback when app_settings is unreachable/missing: 3 days of child grace. */
export const DEFAULT_CHILD_GRACE_DAYS = 3;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Lifecycle phase of the gate for THIS device right now. */
export type AccessPhase =
  | 'premium'   // actively entitled (trial or paid), end date in the future
  | 'grace'     // CHILD only: ended, but still inside the compassionate window
  | 'locked'    // ended and no (or exhausted) grace — access must stop
  | 'unknown';  // nothing known yet (never fetched / never subscribed) — never auto-locks

/** Raw, locally-persisted inputs the evaluator needs — no I/O, no derived booleans. */
export interface AccessInput {
  /** True once any data is known (first fetch resolved or restored from storage). */
  loaded: boolean;
  status: SubscriptionRow['status'] | null;
  trialEndsAt: string | null;
  expiresAt: string | null;
  /** Dynamic grace length cached from app_settings.child_grace_period_days. */
  childGracePeriodDays: number;
}

export interface AccessEvaluation {
  phase: AccessPhase;
  /** Strict entitlement (no grace) — the value premium feature gates read. */
  isPremium: boolean;
  /** The end boundary that was judged: trial_ends_at (trial) else expires_at. */
  endAt: string | null;
  /** Child-only: endAt + childGracePeriodDays (null for parents / unknown). */
  graceEndsAt: string | null;
}

/**
 * Pure rule — no I/O, unit-testable, evaluated at CALL time against `now`.
 *
 *   premium: status active/trial AND end boundary in the future.
 *   grace:   (CHILD only) boundary passed, now < boundary + grace days.
 *   locked:  boundary passed with no grace left (parents always; children once
 *            the compassionate window is exhausted).
 *   unknown: nothing known — never locks either role (a fresh child with no
 *            data is never disrupted; a never-premium parent is handled by the
 *            feature paywalls, not by an expiry lock).
 */
export const evaluateAccess = (
  input: AccessInput,
  role: EntitlementRole,
  now = Date.now(),
): AccessEvaluation => {
  const endAt = input.status === 'trial' ? input.trialEndsAt : input.expiresAt;

  if (!input.loaded || !endAt) {
    return { phase: 'unknown', isPremium: false, endAt: endAt ?? null, graceEndsAt: null };
  }

  const endMs = new Date(endAt).getTime();
  if (Number.isNaN(endMs)) {
    return { phase: 'locked', isPremium: false, endAt, graceEndsAt: null };
  }

  if (now < endMs) {
    return { phase: 'premium', isPremium: true, endAt, graceEndsAt: null };
  }

  // Ended. Parents: strict, zero tolerance. Children: compassionate window.
  if (role === 'Child') {
    const graceDays = Math.max(0, input.childGracePeriodDays);
    if (graceDays > 0 && now < endMs + graceDays * DAY_MS) {
      return {
        phase: 'grace',
        isPremium: false,
        endAt,
        graceEndsAt: new Date(endMs + graceDays * DAY_MS).toISOString(),
      };
    }
    return { phase: 'locked', isPremium: false, endAt, graceEndsAt: null };
  }

  return { phase: 'locked', isPremium: false, endAt, graceEndsAt: null };
};

/**
 * Pure rule — no I/O, unit-testable:
 * Status must be 'active' OR 'trial', AND the applicable end date must be in
 * the future ('trial' rows are judged on trial_ends_at, 'active' on expires_at).
 * A missing end date fails closed (no future boundary ⇒ no entitlement).
 */
export const isSubscriptionEntitled = (row: SubscriptionRow | null): boolean => {
  if (!row) return false;
  if (row.status !== 'active' && row.status !== 'trial') return false;

  const endAt = row.status === 'trial' ? row.trial_ends_at : row.expires_at;
  if (!endAt) return false;

  return new Date(endAt).getTime() > Date.now();
};

// ── Stacking math (Subscription Upgrade CTA) ───────────────────────────────
// The shared definition of "what happens when a plan is added to an existing
// subscription". Used by the PaywallScreen CTA preview NOW and by the QRIS
// backend webhook LATER — one pure function so the UI can never promise a
// different expiry than the backend will actually write.

const AVG_DAYS_PER_MONTH = 30.4375; // 365.25 / 12
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Stack `durationMonths` onto `currentEndAt`:
 *   • current end in the FUTURE (or trial with a future trial_ends_at) →
 *     the new period is APPENDED to the existing end (no value burned),
 *   • expired / no current end → the new period starts from `now`.
 *
 * A month is computed as an average-calendar month (30.4375 days) so six
 * consecutive 1-month renewals land within hours of one 6-month purchase —
 * time-zone-proof, DST-proof, and identical on server and client.
 *
 * Pure — no I/O, unit-testable.
 */
export const computeStackedExpiry = (
  currentEndAt: string | null,
  durationMonths: number,
  now: number = Date.now(),
): string => {
  const baseMs =
    currentEndAt && new Date(currentEndAt).getTime() > now
      ? new Date(currentEndAt).getTime()
      : now;
  return new Date(baseMs + durationMonths * AVG_DAYS_PER_MONTH * MS_PER_DAY).toISOString();
};

export interface StackingInput {
  status: SubscriptionRow['status'] | null;
  trialEndsAt: string | null;
  expiresAt: string | null;
}

export interface StackingPreview {
  /** Current entitlement boundary the stacking math was based on. */
  currentEndAt: string | null;
  /** True when the new period APPENDS to existing time (nothing is lost). */
  stacks: boolean;
  /** The expires_at the backend should write after a successful purchase. */
  newExpiresAt: string;
}

/**
 * Preview the stacking outcome for THIS device's current subscription row.
 * The judged boundary follows the entitlement rule: a trial row's clock is
 * `trial_ends_at` (buying DURING the trial appends to the trial end), an
 * active row's clock is `expires_at`, anything else stacks from `now`.
 */
export const computeRenewalPreview = (
  current: StackingInput,
  durationMonths: number,
  now: number = Date.now(),
): StackingPreview => {
  const currentEndAt = current.status === 'trial' ? current.trialEndsAt : current.expiresAt;
  const endMs = currentEndAt ? new Date(currentEndAt).getTime() : NaN;
  const stacks = Number.isFinite(endMs) && endMs > now;
  return {
    currentEndAt: stacks ? currentEndAt : null,
    stacks,
    newExpiresAt: computeStackedExpiry(currentEndAt, durationMonths, now),
  };
};

export interface EntitlementSnapshot {
  /** Gate value: does THIS device currently have premium access? */
  isPremium: boolean;
  /** The live subscription row backing the decision (null when not premium). */
  subscription: SubscriptionRow | null;
  /** Linked child device ids that were evaluated (Parent context only). */
  linkedChildIds: string[];
  /**
   * Dynamic grace length read from app_settings.child_grace_period_days.
   * Persisted locally so the Child node can compute its grace window offline.
   */
  childGracePeriodDays: number;
}

const NO_ENTITLEMENT: EntitlementSnapshot = {
  isPremium: false,
  subscription: null,
  linkedChildIds: [],
  childGracePeriodDays: DEFAULT_CHILD_GRACE_DAYS,
};

/**
 * Resolve the device ids whose subscriptions entitle THIS device:
 *  - Child  → its own deviceId
 *  - Parent → every child linked via family_links.parent_device_id = deviceId
 *             (slot expansion later caps how many, entitlement covers them all)
 */
export const resolveEntitledChildIds = async (deviceId: string, role: EntitlementRole): Promise<string[]> => {
  if (role === 'Child') return [deviceId];

  const { data: links, error } = await supabase
    .from('family_links')
    .select('child_device_id')
    .eq('parent_device_id', deviceId);

  if (error) throw error;
  return (links ?? []).map((l) => l.child_device_id);
};

/**
 * Fetch + evaluate entitlement for a device in one call (imperative usage:
 * action guards, purchase confirmation, background checks).
 *
 * For a Parent linked to several children, premium = ANY linked child holding
 * a live subscription (each child subscription covers its own combo).
 * When several rows exist for one child, the newest (by created_at) wins.
 *
 * The dynamic child grace length is read from app_settings alongside the
 * subscription — a settings-read failure degrades to DEFAULT_CHILD_GRACE_DAYS
 * and never invalidates the (authoritative) subscription result.
 */
export const fetchPremiumEntitlement = async (
  deviceId: string,
  role: EntitlementRole,
): Promise<EntitlementSnapshot> => {
  if (role === 'None' || !deviceId) return NO_ENTITLEMENT;

  const childIds = await resolveEntitledChildIds(deviceId, role);
  if (childIds.length === 0) return { ...NO_ENTITLEMENT, linkedChildIds: [] };

  const { data: rows, error } = await supabase
    .from('subscriptions')
    .select('*')
    .in('child_device_id', childIds);

  if (error) throw error;

  // Newest row per child (renewals may insert fresh rows instead of updating).
  const newestPerChild = new Map<string, SubscriptionRow>();
  for (const row of (rows ?? []) as SubscriptionRow[]) {
    const current = newestPerChild.get(row.child_device_id);
    if (!current || new Date(row.created_at).getTime() > new Date(current.created_at).getTime()) {
      newestPerChild.set(row.child_device_id, row);
    }
  }

  let live: SubscriptionRow | null = null;
  for (const row of newestPerChild.values()) {
    if (isSubscriptionEntitled(row)) {
      live = row;
      break; // one live combo is enough for this device
    }
  }

  // Dynamic grace length — tolerated failure (defaults), never blocks premium.
  let childGracePeriodDays = DEFAULT_CHILD_GRACE_DAYS;
  const { data: settings } = await supabase
    .from('app_settings')
    .select('child_grace_period_days')
    .maybeSingle();

  const configured = settings?.child_grace_period_days;
  if (typeof configured === 'number' && configured >= 0) {
    childGracePeriodDays = configured;
  }

  return {
    isPremium: live !== null,
    subscription: live,
    linkedChildIds: childIds,
    childGracePeriodDays,
  };
};
