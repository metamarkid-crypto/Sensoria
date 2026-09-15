import "server-only";

import crypto from "node:crypto";

/**
 * Signed client for the qris-api service (https://app.aacsensoria.id,
 * blueprint §4.3 "Internal" endpoints).
 *
 * Signing mirrors qris-api/src/hmac.js exactly:
 *   X-Sensoria-Timestamp : unix seconds (± QRIS_HMAC_MAX_SKEW, default 300 s)
 *   X-Sensoria-Sign      = HEX HMAC-SHA256(`${timestamp}.${rawBody}`, secret)
 *
 * Callers are SERVER ACTIONS that have already passed requireOwner() — the
 * secret lives only in server env (QRIS_API_SECRET, same value the service
 * and the mobile app carry). Never import this from a client component.
 */

export const QRIS_API_BASE_URL = (
  process.env.QRIS_API_BASE_URL || "https://app.aacsensoria.id"
).replace(/\/+$/, "");

/** Stable error code strings the actions layer maps to friendly messages. */
export const QRIS_API_ERRORS = {
  NOT_CONFIGURED: "QRIS_API_NOT_CONFIGURED",
  TIMEOUT: "QRIS_API_TIMEOUT",
  SIGNATURE_REJECTED: "QRIS_API_SIGNATURE_REJECTED",
  UNREACHABLE: "QRIS_API_UNREACHABLE",
} as const;

function signPayload(rawBody: string, secret: string, timestamp: number): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

function assertConfigured(): { secret: string; baseUrl: string } {
  const secret = process.env.QRIS_API_SECRET;
  const baseUrl = process.env.QRIS_API_BASE_URL || QRIS_API_BASE_URL;
  if (!secret) {
    throw new Error(QRIS_API_ERRORS.NOT_CONFIGURED);
  }
  return { secret, baseUrl };
}

/** Internal error carrying the stable code + HTTP status when present. */
export class QrisApiError extends Error {
  code: string;
  status: number | null;
  serverMessage: string | null;

  constructor(code: string, message: string, opts: { status?: number | null; serverMessage?: string | null } = {}) {
    super(message);
    this.name = "QrisApiError";
    this.code = code;
    this.status = opts.status ?? null;
    this.serverMessage = opts.serverMessage ?? null;
  }
}

/**
 * Byte ceiling mirroring qris-api/src/decodeQris.js DEFAULT_MAX_BYTES — the
 * server rejects anything larger before it ever tries to decode.
 */
export const DEFAULT_QR_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * POST/GET a signed request to qris-api. JSON bodies are signed as their
 * exact serialized bytes; GET sends an empty body (signed as ""); a
 * Uint8Array payload (multipart form for /qr-image) is signed as the exact
 * raw bytes — `payload.toString("utf8")` in the HMAC is a lossless
 * byte→string→byte round-trip for binary data (see the CJS qris-api side).
 */
export async function qrisApiRequest<T = Record<string, unknown>>(
  method: "GET" | "POST",
  path: string,
  payload?: Record<string, unknown> | Uint8Array,
  opts: { timeoutMs?: number; contentType?: string } = {},
): Promise<T> {
  const { secret, baseUrl } = assertConfigured();
  const isBinary = payload instanceof Uint8Array;
  const rawBody =
    method === "POST" && payload !== undefined
      ? isBinary
        ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8")
        : JSON.stringify(payload)
      : "";
  const timestamp = Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(method === "POST"
          ? { "Content-Type": opts.contentType ?? "application/json" }
          : {}),
        "X-Sensoria-Timestamp": String(timestamp),
        "X-Sensoria-Sign": signPayload(rawBody, secret, timestamp),
      },
      body: method === "POST" ? rawBody : undefined,
      signal: controller.signal,
      // Server actions must never cache side-effecting calls.
      cache: "no-store",
    });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    throw new QrisApiError(
      aborted ? QRIS_API_ERRORS.TIMEOUT : QRIS_API_ERRORS.UNREACHABLE,
      aborted
        ? "qris-api tidak menjawab dalam batas waktu."
        : `qris-api tidak dapat dihubungi: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON (proxy error page etc.) — fall through to the status check.
  }

  if (!res.ok) {
    if (res.status === 401) {
      // BAD_SIGNATURE / TIMESTAMP_SKEW / MISSING_SIGNATURE — the two sides
      // don't share the same secret (deploy/config bug, not user error).
      throw new QrisApiError(QRIS_API_ERRORS.SIGNATURE_REJECTED, "Tanda tangan ditolak qris-api — periksa QRIS_API_SECRET di kedua sisi.", {
        status: res.status,
        serverMessage: typeof body.error === "string" ? body.error : null,
      });
    }
    throw new QrisApiError(
      typeof body.error === "string" ? body.error : `HTTP_${res.status}`,
      typeof body.message === "string" ? body.message : `qris-api error ${res.status}`,
      { status: res.status, serverMessage: typeof body.message === "string" ? body.message : null },
    );
  }

  return body as T;
}

// ─── Typed shapes of the /internal responses (blueprint §4.3) ──────────────

export interface MerchantView {
  merchant_id: string;
  merchant_name: string;
  phone: string | null;
  status: "active" | "token_expired" | "disabled";
  token_age_hours: number | null;
  last_sync: string | null;
  has_static_qris: boolean;
  static_qris_source: "paste" | "image" | null;
  static_qris_set_at: string | null;
  ready: boolean;
}

export interface MerchantStatusResponse {
  merchants: MerchantView[];
  summary: { total: number; ready: number; token_expired: number; disabled: number };
}

export interface OtpStartResponse {
  otp_token: string;
  device_id: string;
  phone: string;
  message: string;
}

export interface VerifyResponse {
  merchant_id: string;
  merchant_name: string;
  linked: boolean;
  has_static_qris: boolean;
  status: string;
  message: string;
}

export interface WorkerRunResponse {
  ok: boolean;
  expired: number;
  polled: number;
  settled: number;
}

// ─── Endpoint wrappers (used by the payment server actions) ────────────────

export const getMerchantStatus = () =>
  qrisApiRequest<MerchantStatusResponse>("GET", "/internal/merchant/status");

export const startMerchantOtp = (phone: string) =>
  qrisApiRequest<OtpStartResponse>("POST", "/internal/merchant/otp", { phone });

export const verifyMerchantOtp = (input: {
  phone: string;
  otp: string;
  otpToken: string;
  deviceId: string;
}) =>
  qrisApiRequest<VerifyResponse>("POST", "/internal/merchant/verify", {
    phone: input.phone,
    otp: input.otp,
    otp_token: input.otpToken,
    device_id: input.deviceId,
  });

export const setMerchantQrisPayload = (merchantId: string, payload: string) =>
  qrisApiRequest<MerchantView>("POST", "/internal/merchant/qr", {
    merchant_id: merchantId,
    payload,
  });

/**
 * Upload the official QRIS image (blueprint §4.3 POST /internal/merchant/
 * qr-image): multipart/form-data with a `merchant_id` text field and a `file`
 * field (PNG/JPEG). The API decodes the QR server-side and stores the
 * validated payload with source 'image'.
 */
/** The qr-image response is the merchant view plus a human message. */
export type QrisImageUploadResponse = MerchantView & { message?: string };

export function setMerchantQrisImage(merchantId: string, image: Uint8Array): Promise<QrisImageUploadResponse> {
  const boundary = `----sensoriadash${crypto.randomBytes(12).toString("hex")}`;
  const contentType = `multipart/form-data; boundary=${boundary}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="merchant_id"\r\n\r\n` +
    `${merchantId}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="qris.png"\r\n` +
    `Content-Type: image/png\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const headBytes = Buffer.from(head, "utf8");
  const tailBytes = Buffer.from(tail, "utf8");
  const body = new Uint8Array(headBytes.length + image.length + tailBytes.length);
  body.set(headBytes, 0);
  body.set(image, headBytes.length);
  body.set(tailBytes, headBytes.length + image.length);
  return qrisApiRequest<QrisImageUploadResponse>("POST", "/internal/merchant/qr-image", body, {
    contentType,
    timeoutMs: 30_000, // decode of a big scan can take longer than a JSON call
  });
}

export const refreshMerchantToken = (merchantId: string) =>
  qrisApiRequest<{ merchant_id: string; refreshed_at: string; rotated: boolean; message: string }>(
    "POST",
    "/internal/merchant/refresh",
    { merchant_id: merchantId },
  );

export const runWorkerSweep = () =>
  qrisApiRequest<WorkerRunResponse>("POST", "/internal/worker/run", {});
