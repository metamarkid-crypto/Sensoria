import { supabase } from './supabase';
import type { SubscriptionPlanRow } from './types';
import {
  sensoriaSignatureHeaders,
  QRIS_API_SECRET,
  QRIS_API_SECRET_MISSING,
} from './hmac';

/**
 * Paywall / QRIS service — Stealth External Subscription (Master Blueprint).
 *
 * The mobile client stays SDK-free: no payment-gateway libraries. Selecting a
 * plan POSTs to our own web backend, which returns a QRIS image the client
 * renders natively. Verification is a plain `refreshEntitlement()` re-read of
 * the `subscriptions` table (the backend flips the row after payment settles).
 */

/**
 * Web backend base (qris-api, blueprint §4.3).
 *
 * DEFAULT = https://api.aacsensoria.id — the LIVE deployment (verified via
 * /api/health). The old planned host `app.aacsensoria.id` does not resolve in
 * DNS; the roadmap docs still mention it, but the deployed service lives on
 * `api.`. Override with EXPO_PUBLIC_QRIS_API_BASE_URL when the host moves —
 * trailing slashes are stripped so concatenation is always safe.
 */
export const QRIS_API_BASE_URL = (
  process.env.EXPO_PUBLIC_QRIS_API_BASE_URL || 'https://api.aacsensoria.id'
).replace(/\/+$/, '');

export const QRIS_CHECKOUT_URL = `${QRIS_API_BASE_URL}/api/qris-checkout`;
export const QRIS_STATUS_URL = `${QRIS_API_BASE_URL}/api/qris-status`;

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
    // LOUD diagnostic — this failure mode is indistinguishable from intentional
    // stealth mode in the UI, so the exact PostgREST error MUST reach the logs.
    // Typical culprits when web_payment_active=true but the app still shows
    // "Segera Hadir":
    //   • RLS: `new row violates row-level security policy` / error code 42501
    //     (no SELECT policy on app_settings for role anon)
    //   • 401/403: wrong or missing SUPABASE_ANON_KEY
    //   • 404 / PGRST205: table missing — migration never applied
    //   • TypeError: fetch failed — offline / bad SUPABASE_URL
    console.error(
      '[PaywallSettings] fetchPaywallSettings FAILED — degrading to stealth-safe. ' +
        'If web_payment_active is TRUE in Supabase but this fires, check RLS on ' +
        'public.app_settings for the anon role. Raw error follows:',
      JSON.stringify(
        {
          message: e instanceof Error ? e.message : String(e),
          code: (e as { code?: string } | null)?.code ?? null,
          details: (e as { details?: string } | null)?.details ?? null,
          hint: (e as { hint?: string } | null)?.hint ?? null,
        },
        null,
        2,
      ),
    );
    return STEALTH_SAFE;
  }
};

/**
 * Active Combo plans (1 / 6 / 12 months), cheapest first.
 *
 * Scoped to kind = 'combo' so the one-time parent-slot packs (kind = 'slots',
 * seeded by 20260913_parent_slot_packs.sql) NEVER surface in the subscription
 * paywall — they are bought from the pairing sheet instead. When the kind
 * column does not exist yet (pre-migration), the filter degrades gracefully:
 * the scoped query fails and we retry unscoped, exactly the old behavior.
 * Errors degrade to an empty list so the screen can show a retry state.
 */
export const fetchActivePlans = async (): Promise<SubscriptionPlanRow[]> => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('*')
      .eq('is_active', true)
      .eq('kind', 'combo')
      .order('duration_months', { ascending: true });

    if (error) throw error;
    return (data ?? []) as SubscriptionPlanRow[];
  } catch (kindErr) {
    // Legacy fallback: plans.kind missing (unapplied migration) → retry
    // unscoped so Combo plans still render on old databases.
    try {
      const { data, error } = await supabase
        .from('plans')
        .select('*')
        .eq('is_active', true)
        .order('duration_months', { ascending: true });
      if (error) throw error;
      return (data ?? []).filter((p) => (p as SubscriptionPlanRow).kind !== 'slots') as SubscriptionPlanRow[];
    } catch (e) {
      console.warn('fetchActivePlans failed:', kindErr, e);
      return [];
    }
  }
};

/**
 * POST the signed JSON body to a qris-api endpoint.
 *
 * Signing: X-Sensoria-Sign = HMAC-SHA256("<unix-ts>.<rawBody>", secret) —
 * the raw bytes the server verifies are the exact bytes we signed, so the
 * body is serialized ONCE here and never re-stringified. Timeout via
 * Promise.race (no AbortController dependency in this RN target).
 */
const signedPost = async (
  url: string,
  payload: Record<string, unknown>,
  { timeoutMs = 20000 }: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> => {
  const rawBody = JSON.stringify(payload);
  let headers: Record<string, string>;
  try {
    headers = {
      'Content-Type': 'application/json',
      ...sensoriaSignatureHeaders(rawBody, QRIS_API_SECRET),
    };
  } catch {
    // Blank/missing EXPO_PUBLIC_QRIS_API_SECRET (e.g. dev build without env).
    throw new Error(QRIS_API_SECRET_MISSING);
  }

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('PAYMENT_SERVER_TIMEOUT')), timeoutMs);
  });

  let response: Response;
  try {
    response = await Promise.race([fetch(url, { method: 'POST', headers, body: rawBody }), timeout]);
  } catch (e) {
    if (e instanceof Error && e.message === 'PAYMENT_SERVER_TIMEOUT') throw e;
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
  return { ok: response.ok, status: response.status, body };
};

/** Normalized QRIS checkout result returned by the web backend. */
export interface QrisCheckoutResult {
  orderId: string | null;
  /** https URL or a `data:image/png;base64,…` URI — directly renderable. */
  imageUri: string;
  qrisExpiresAt: string | null;
}

/** Instant-verify result — mirrors qris-api's /api/qris-status response. */
export interface QrisStatusResult {
  status: 'pending' | 'paid' | 'expired' | 'failed' | null;
  paidAt: string | null;
  transactionRef: string | null;
  amount: number | null;
  expiresAt: string | null;
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
 * Stable error CODES callers map to localized toasts: PAYMENT_SERVER_TIMEOUT,
 * CHECKOUT_NO_QRIS, QRIS_API_SECRET_MISSING.
 */
export const createQrisCheckout = async (
  deviceId: string,
  planId: string,
): Promise<QrisCheckoutResult> => {
  const { ok, status, body } = await signedPost(QRIS_CHECKOUT_URL, {
    device_id: deviceId,
    plan_id: planId,
  });

  if (!ok) {
    // 401 with BAD_SIGNATURE/TIMESTAMP_SKEW → the shipped secret doesn't match
    // the server's — a config bug, not a user error; surface the stable code.
    const errCode = typeof body.error === 'string' ? body.error : null;
    if (status === 401 && (errCode === 'BAD_SIGNATURE' || errCode === 'TIMESTAMP_SKEW')) {
      throw new Error('QRIS_SIGNATURE_REJECTED');
    }
    const serverMessage =
      typeof body.message === 'string' ? body.message : `Kode error ${status}`;
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
    throw new Error('CHECKOUT_NO_QRIS');
  }

  return {
    orderId: typeof body.order_id === 'string' ? body.order_id : null,
    imageUri,
    qrisExpiresAt: typeof body.qris_expires_at === 'string' ? body.qris_expires_at : null,
  };
};

/**
 * Instant verify for the "Saya Sudah Membayar" button: asks the backend to
 * poll the merchant's GoBiz journals NOW and settle on a match, then returns
 * the fresh order state. The caller still re-reads entitlements afterwards —
 * the ledger/entitlement flow stays the source of truth.
 *
 * NEVER throws: a verification hiccup (network, 404 for a GC'd order, GoBiz
 * outage) resolves to a null-status result so the UI can keep the QR up and
 * let the user retry. Verification must not punish the paying user.
 */
export const checkQrisStatus = async (orderId: string): Promise<QrisStatusResult> => {
  const empty: QrisStatusResult = {
    status: null,
    paidAt: null,
    transactionRef: null,
    amount: null,
    expiresAt: null,
  };
  try {
    const { ok, body } = await signedPost(QRIS_STATUS_URL, { order_id: orderId }, { timeoutMs: 15000 });
    if (!ok) return empty;
    return {
      status: typeof body.status === 'string' ? (body.status as QrisStatusResult['status']) : null,
      paidAt: typeof body.paid_at === 'string' ? body.paid_at : null,
      transactionRef: typeof body.transaction_ref === 'string' ? body.transaction_ref : null,
      amount: typeof body.amount === 'number' ? body.amount : null,
      expiresAt: typeof body.expires_at === 'string' ? body.expires_at : null,
    };
  } catch {
    return empty;
  }
};
