'use strict';

/**
 * gobiz.js — GoBiz WEB-session SDK for the Sensoria QRIS API.
 *
 * Port of go-merchant/src/services/goMerchant.service.js (GoBiz web path only).
 * The GoPay Mobile / Midtrans path (accounts.goto-products.com, x-e1 signed by
 * libcvsdk.so) is deliberately NOT ported — it is dead behind GoGuard WAF
 * (replay = permanent Error 1000), see docs/QRIS_API_BLUEPRINT.md §2.3.
 *
 * What this SDK does:
 *   requestOtp(phone)        → POST /goid/login/request          → { otpToken, deviceId }
 *   verifyOtp(otp, otpToken) → POST /goid/token (grant_type=otp) → { accessToken, refreshToken }
 *   refreshToken(rt)         → POST /goid/token (refresh_token)  → { accessToken, refreshToken }
 *   getMe()                  → GET  /v1/users/me                 → { merchantId, merchantName }
 *   getJournals(merchantId)  → POST /journals/search             → normalized settlements
 *
 * CRITICAL contract (blueprint §3.3): `deviceId` (the x-uniqueid header) must
 * be PERSISTENT per merchant account. It is generated once at the OTP step,
 * returned to the caller, sent back at verify, and stored in
 * qris_merchants.device_id. Token refresh with a different device id gets
 * rejected — never rotate it while a session is alive.
 *
 * Token expiry is handled "lazy": callers try → on 401 refresh → retry once
 * (see store.withAccessToken). This SDK never refreshes pre-emptively.
 *
 * Security notes:
 *   • Raw GoBiz responses are never logged at INFO; only with QRIS_DEBUG=1,
 *     and even then token-ish fields are redacted by redact().
 *   • Error messages carry the API's own message + status — never token
 *     material from the response body.
 */

const crypto = require('node:crypto');
const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.gobiz.co.id';
/** OAuth client_id of the GoBiz web dashboard (public, from the web app). */
const GOBIZ_CLIENT_ID = 'go-biz-web-new';
// 25 s: the GoBiz WAF occasionally sits on /goid/token for well over 15 s
// before answering — the dashboard's verify then died as NETWORK_ERROR
// (axios "timeout of 15000ms exceeded") even though the exchange succeeded
// server-side. 25 s leaves headroom while staying well inside the internal
// route's caller patience.
const DEFAULT_TIMEOUT_MS = 25000;
/** Journals look-back window when the caller gives no start time. */
const JOURNALS_LOOKBACK_DAYS = 30;

const DEBUG = /^(1|true|yes)$/i.test(process.env.QRIS_DEBUG || '');

// ---------------------------------------------------------------------------
// Errors & helpers
// ---------------------------------------------------------------------------

/** Normalized GoBiz failure. `status` is the HTTP status when we got one. */
class GoBizError extends Error {
  constructor(message, { status = null, code = 'GOBIZ_ERROR', apiMessage = null, cause = null } = {}) {
    super(message);
    this.name = 'GoBizError';
    this.status = status;
    this.code = code;
    this.apiMessage = apiMessage;
    if (cause) this.cause = cause;
  }
}

/** True when the error is an auth failure (401) — the refresh-retry signal. */
function isAuthError(err) {
  return Boolean(err) && (err.status === 401 || err?.response?.status === 401);
}

/**
 * Normalize an Indonesian mobile number to the bare form GoBiz expects:
 * "+62 812-…", "62 812…", "0 812…" → "812…". Returns digits only, or ''.
 */
function normalizePhone(phone) {
  if (typeof phone !== 'string') return '';
  let p = phone.replace(/\D+/g, '');
  if (p.startsWith('62')) p = p.slice(2);
  else if (p.startsWith('0')) p = p.slice(1);
  return p;
}

/** New persistent device id — call ONCE per merchant link, then store it. */
function newDeviceId() {
  return crypto.randomUUID();
}

const SENSITIVE_KEY = /(token|authorization|secret|password|refresh)/i;

/** Deep-clone a value replacing sensitive-looking string fields. Debug only. */
function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) && typeof v === 'string' ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

class GoBizClient {
  /**
   * @param {object}  opts
   * @param {?string} opts.deviceId    - persistent x-uniqueid (REQUIRED for a real session; generated if omitted)
   * @param {?string} opts.accessToken - bearer token for authenticated calls
   * @param {string}  [opts.baseUrl]
   * @param {number}  [opts.timeoutMs]
   * @param {object}  [opts.transport] - axios-like { request(config) } — injectable for tests
   */
  constructor({ deviceId = null, accessToken = null, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, transport = null } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.deviceId = deviceId || newDeviceId();
    this.accessToken = accessToken;
    // Note: full uuid as x-uniqueid — the proven web-dashboard form (the
    // mobile variant truncated to 16 chars; that is the dead path).
    this._http = transport || axios.create({ timeout: timeoutMs });
  }

  setAccessToken(token) {
    this.accessToken = token;
  }

  /**
   * Header set of the GoBiz web dashboard — ported VERBATIM from
   * go-merchant (this exact fingerprint is what the endpoint accepts).
   */
  headers() {
    const h = {
      Accept: 'application/json, text/plain, */*',
      'Authentication-Type': 'go-id',
      'X-PhoneMake': 'Android 10',
      'X-PhoneModel': 'K',
      'x-DeviceOS': 'Web',
      'X-Platform': 'Web',
      'X-User-Type': 'merchant',
      'x-appid': 'go-biz-web-dashboard',
      'x-uniqueid': this.deviceId,
      'X-AppVersion': 'platform-v3.101.0-8918927d',
      'Gojek-Country-Code': 'ID',
      'Gojek-Timezone': 'Asia/Jakarta',
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
    };
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  // -- transport glue -------------------------------------------------------

  async _request(method, path, data, extraHeaders = {}) {
    const config = { method, url: `${this.baseUrl}${path}`, data, headers: { ...this.headers(), ...extraHeaders } };
    try {
      const res = await this._http.request(config);
      return res.data;
    } catch (err) {
      throw this._wrap(err, `${method.toUpperCase()} ${path}`);
    }
  }

  _wrap(err, label) {
    const status = err?.response?.status ?? null;
    const body = err?.response?.data;
    const apiMessage = body?.errors?.[0]?.message || body?.error || body?.message || null;
    if (DEBUG) {
      console.error('[gobiz]', label, status ?? '(no response)', JSON.stringify(redact(body ?? { message: err.message })));
    }
    return new GoBizError(apiMessage ? `${label} gagal: ${apiMessage}` : `${label} gagal: ${err.message}`, {
      status,
      code: status ? `HTTP_${status}` : 'NETWORK_ERROR',
      apiMessage,
      cause: err,
    });
  }

  // -- auth flow ------------------------------------------------------------

  /**
   * Step 1 of linking: ask GoBiz to SMS an OTP to `phone`.
   * Returns { otpToken, deviceId, phone, raw } — deviceId MUST be carried to
   * verifyOtp (and then persisted) or the later refreshes break.
   */
  async requestOtp(phoneNumber) {
    const phone = normalizePhone(phoneNumber);
    if (!phone) throw new GoBizError('Nomor telepon tidak valid.');
    const data = await this._request('post', '/goid/login/request', {
      client_id: GOBIZ_CLIENT_ID,
      phone_number: phone,
      country_code: '62',
    });
    const otpToken = data?.otp_token ?? data?.data?.otp_token ?? null;
    if (!otpToken) throw new GoBizError('Respons OTP tidak memuat otp_token.', { code: 'NO_OTP_TOKEN' });
    return { otpToken, deviceId: this.deviceId, phone, raw: data };
  }

  /**
   * Step 2: exchange the SMS OTP for the session tokens.
   * Returns { accessToken, refreshToken, expiresIn, raw }.
   */
  async verifyOtp(otp, otpToken) {
    if (!otp || !otpToken) throw new GoBizError('OTP dan otp_token wajib diisi.');
    const data = await this._request('post', '/goid/token', {
      client_id: GOBIZ_CLIENT_ID,
      data: { otp: String(otp), otp_token: otpToken },
      grant_type: 'otp',
    });
    const accessToken = data?.access_token ?? data?.data?.access_token ?? null;
    if (!accessToken) throw new GoBizError('Respons verify tidak memuat access_token.', { code: 'NO_ACCESS_TOKEN' });
    return {
      accessToken,
      refreshToken: data?.refresh_token ?? data?.data?.refresh_token ?? null,
      expiresIn: data?.expires_in ?? data?.data?.expires_in ?? null,
      raw: data,
    };
  }

  /**
   * Refresh the session. Uses THE SAME device id as the original login —
   * this is why device_id persistence is non-negotiable.
   * Returns { accessToken, refreshToken, expiresIn, raw }; refreshToken is
   * null when GoBiz did not rotate it (caller keeps the old one).
   */
  async refreshToken(refreshTokenString) {
    if (!refreshTokenString) throw new GoBizError('Refresh token kosong — merchant harus login ulang.');
    const data = await this._request('post', '/goid/token', {
      client_id: GOBIZ_CLIENT_ID,
      grant_type: 'refresh_token',
      data: { refresh_token: refreshTokenString },
    });
    const accessToken = data?.access_token ?? data?.data?.access_token ?? null;
    if (!accessToken) throw new GoBizError('Respons refresh tidak memuat access_token.', { code: 'NO_ACCESS_TOKEN' });
    return {
      accessToken,
      refreshToken: data?.refresh_token ?? data?.data?.refresh_token ?? null,
      expiresIn: data?.expires_in ?? data?.data?.expires_in ?? null,
      raw: data,
    };
  }

  // -- profile --------------------------------------------------------------

  /**
   * GET /v1/users/me — the GoBiz identity. `merchantId` here is THE identity
   * stored in qris_merchants.merchant_id (unique per account), not the phone.
   */
  async getMe() {
    const data = await this._request('get', '/v1/users/me');
    const user = data?.user ?? data?.data?.user ?? data ?? {};
    const merchantId = user?.merchant_id ?? null;
    if (!merchantId) {
      throw new GoBizError('Profil GoBiz tidak memuat merchant_id.', { code: 'NO_MERCHANT_ID' });
    }
    return {
      merchantId: String(merchantId),
      merchantName: user?.full_name || user?.name || 'Unknown Merchant',
      raw: data,
    };
  }

  // -- money ----------------------------------------------------------------

  /**
   * POST /journals/search — settled/captured QRIS transactions of `merchantId`
   * in [startTime | now-30d, now]. Requires the journal Accept type — without
   * it the endpoint answers nothing useful.
   *
   * CRITICAL: journal `amount` is in SEN (cents). This method normalizes it to
   * rupiah (÷100) in `mutations[].amountIdr` — matchers must use amountIdr.
   *
   * Returns { hits, mutations, fetchedAt } where mutations[] =
   * { id, referenceId, amountIdr, status, paymentTime, merchantId, raw }.
   */
  async getJournals(merchantId, startTime = null) {
    if (!merchantId) throw new GoBizError('merchantId wajib untuk getJournals.');
    const dateTo = new Date().toISOString();
    const dateFrom = startTime || new Date(Date.now() - JOURNALS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const payload = {
      from: 0,
      size: 50,
      sort: { time: { order: 'desc' } },
      included_categories: { incoming: ['transaction_share', 'action'] },
      query: [
        {
          clauses: [
            { field: 'metadata.transaction.status', op: 'in', value: ['settlement', 'capture'] },
            { field: 'metadata.transaction.transaction_time', op: 'gte', value: dateFrom },
            { field: 'metadata.transaction.transaction_time', op: 'lte', value: dateTo },
            { field: 'metadata.transaction.merchant_id', op: 'equal', value: merchantId },
          ],
          op: 'and',
        },
      ],
    };

    const data = await this._request('post', '/journals/search', payload, {
      accept: 'application/vnd.journal.v1+json',
    });

    const hits = data?.hits ?? data?.data?.hits ?? [];
    const mutations = hits
      .filter((h) => {
        const s = h?.metadata?.transaction?.status;
        return s === 'settlement' || s === 'capture';
      })
      .map((h) => ({
        id: h?.id ?? null,
        referenceId: h?.reference_id || h?.id || null,
        // SEN → rupiah. (go-merchant worker did the same division.)
        amountIdr: (Number(h?.amount) || 0) / 100,
        status: h?.metadata?.transaction?.status ?? null,
        paymentTime: h?.metadata?.transaction?.transaction_time || h?.time || null,
        merchantId: h?.metadata?.transaction?.merchant_id ?? null,
        raw: h,
      }))
      .filter((m) => m.referenceId !== null);

    return { hits, mutations, fetchedAt: dateTo };
  }
}

/** Factory kept for symmetry with createStore(); same as `new GoBizClient(o)`. */
const createGoBizClient = (opts) => new GoBizClient(opts);

module.exports = {
  GoBizClient,
  createGoBizClient,
  GoBizError,
  isAuthError,
  normalizePhone,
  newDeviceId,
  redact,
  DEFAULT_BASE_URL,
  GOBIZ_CLIENT_ID,
};
