import { supabase } from './supabase';
import type { SubscriptionPlanRow } from './types';

/**
 * Paywall / QRIS service — Stealth External Subscription (Master Blueprint).
 *
 * The mobile client stays SDK-free: no payment-gateway libraries. Selecting a
 * plan POSTs to our own web backend, which returns a QRIS image the client
 * renders natively. Verification is a plain `refreshEntitlement()` re-read of
 * the `subscriptions` table (the backend flips the row after payment settles).
 */

/** Web backend endpoint (owned by aacsensoria.id — built server-side later). */
export const QRIS_CHECKOUT_URL = 'https://app.aacsensoria.id/api/qris-checkout';

/** Subset of app_settings the paywall needs (stealth kill-switch). */
export interface PaywallSettings {
  /** Stealth toggle: false during App Review ⇒ paywall must show NO pricing. */
  web_payment_active: boolean;
  trial_duration_days: number | null;
}

const STEALTH_SAFE: PaywallSettings = { web_payment_active: false, trial_duration_days: null };

/**
 * Read the kill-switch from app_settings.
 *
 * Fail-safe to STEALTH mode: a missing row, DB error, or unapplied migration
 * resolves to `web_payment_active = false` — the app can never accidentally
 * surface live pricing during App Review, and a misconfigured backend never
 * leaks payment UI.
 */
export const fetchPaywallSettings = async (): Promise<PaywallSettings> => {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('web_payment_active, trial_duration_days')
      .maybeSingle();

    if (error) throw error;
    return {
      web_payment_active: data?.web_payment_active ?? false,
      trial_duration_days: data?.trial_duration_days ?? null,
    };
  } catch (e) {
    console.warn('fetchPaywallSettings failed — staying stealth-safe:', e);
    return STEALTH_SAFE;
  }
};

/**
 * Active Combo plans (1 / 6 / 12 months), cheapest first.
 * Errors degrade to an empty list so the screen can show a retry state.
 */
export const fetchActivePlans = async (): Promise<SubscriptionPlanRow[]> => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .eq('is_active', true)
      .order('duration_months', { ascending: true });

    if (error) throw error;
    return (data ?? []) as SubscriptionPlanRow[];
  } catch (e) {
    console.warn('fetchActivePlans failed:', e);
    return [];
  }
};

/** Normalized QRIS checkout result returned by the web backend. */
export interface QrisCheckoutResult {
  orderId: string | null;
  /** https URL or a `data:image/png;base64,…` URI — directly renderable. */
  imageUri: string;
  qrisExpiresAt: string | null;
}

/**
 * POST { device_id, plan_id } to the web backend and normalize the response.
 *
 * Accepted response shapes (backend contract, both optional):
 *   { qris_image_url: "https://…/qr.png" }
 *   { qris_image_base64: "<base64>" }            (also accepts a full data URI)
 * plus optional { order_id, qris_expires_at }.
 *
 * @throws a human-readable Error on network failure, non-2xx, or missing image.
 */
export const createQrisCheckout = async (
  deviceId: string,
  planId: string,
): Promise<QrisCheckoutResult> => {
  // Timeout via Promise.race (no AbortController dependency in this RN target).
  const TIMEOUT_MS = 20000;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error('Server pembayaran tidak merespons. Silakan coba lagi.')),
      TIMEOUT_MS,
    );
  });

  let response: Response;
  try {
    response = await Promise.race([
      fetch(QRIS_CHECKOUT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId, plan_id: planId }),
      }),
      timeout,
    ]);
  } catch (e) {
    throw new Error(
      e instanceof Error && e.message
        ? e.message
        : 'Tidak dapat menghubungi server pembayaran. Periksa koneksi Anda.',
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new Error('Respons server tidak valid.');
  }

  if (!response.ok) {
    const serverMessage =
      typeof body.message === 'string' ? body.message : `Kode error ${response.status}`;
    throw new Error(`Checkout gagal: ${serverMessage}`);
  }

  const imageUrl = typeof body.qris_image_url === 'string' ? body.qris_image_url : null;
  const imageBase64 = typeof body.qris_image_base64 === 'string' ? body.qris_image_base64 : null;

  let imageUri: string | null = null;
  if (imageUrl) imageUri = imageUrl;
  else if (imageBase64) {
    imageUri = imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/png;base64,${imageBase64}`;
  }

  if (!imageUri) {
    throw new Error('Respons checkout tidak berisi gambar QRIS. Silakan coba lagi.');
  }

  return {
    orderId: typeof body.order_id === 'string' ? body.order_id : null,
    imageUri,
    qrisExpiresAt: typeof body.qris_expires_at === 'string' ? body.qris_expires_at : null,
  };
};
