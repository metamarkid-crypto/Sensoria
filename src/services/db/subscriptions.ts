import { supabase } from './supabase';

/** Fallback when app_settings row is missing/unreachable: 1-Day Free Trial. */
const DEFAULT_TRIAL_DAYS = 1;

/**
 * Inject the premium free trial for a child node — Master Blueprint rule.
 *
 * Idempotent: if ANY subscription row already exists for this child_device_id
 * (trial, active, expired, ...) this is a no-op and never downgrades/overwrites.
 *
 * The trial duration is read dynamically from `app_settings.trial_duration_days`
 * (the setup table), defaulting to 1 day. A subscription is keyed by the Child
 * only — per the Combo rule, linked Parents inherit entitlement via family_links.
 *
 * @returns true when a new trial row was created, false when one already existed.
 * @throws on network/DB errors — callers decide whether to surface or swallow.
 */
export const ensureTrialSubscription = async (childDeviceId: string): Promise<boolean> => {
  // 1) Never double-trial: skip if a subscription already exists for this child.
  const { data: existing } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('child_device_id', childDeviceId)
    .maybeSingle();

  if (existing) return false;

  // 2) Read the dynamic trial duration from app_settings (default 1 day).
  let trialDays = DEFAULT_TRIAL_DAYS;
  const { data: settings } = await supabase
    .from('app_settings')
    .select('trial_duration_days')
    .maybeSingle();

  const configured = settings?.trial_duration_days;
  if (typeof configured === 'number' && configured > 0) {
    trialDays = configured;
  }

  // 3) Insert the trial row (plan_id stays NULL until a paid plan is purchased).
  const now = new Date();
  const trialEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

  const { error } = await supabase.from('subscriptions').insert({
    child_device_id: childDeviceId,
    plan_id: null,
    status: 'trial',
    starts_at: now.toISOString(),
    trial_ends_at: trialEndsAt.toISOString(),
    expires_at: trialEndsAt.toISOString(),
  });

  if (error) throw error;
  return true;
};
