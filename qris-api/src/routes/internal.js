'use strict';

/**
 * routes/internal.js — dashboard admin operations (blueprint §4.3 "Internal").
 *
 * Consumed by Next.js admin SERVER ACTIONS (service-to-service), never by
 * the app: the HMAC secret here is the DASHBOARD-side secret, and the
 * dashboard additionally gates every action on the Owner role + audit log
 * (qris_merchant_link, qris_static_qr_set, qris_token_refresh) BEFORE this
 * endpoint is called. An IP allowlist for /internal/* at the Nginx layer is
 * the Fase-2 roadmap item — the routes are still mounted under the same
 * HMAC middleware so nothing is reachable without a signature today.
 *
 *   POST /internal/merchant/otp      {phone}                        → {otp_token, device_id, phone}
 *   POST /internal/merchant/verify   {phone, otp, otp_token, device_id} → {merchant_id, merchant_name, linked, ...}
 *   POST /internal/merchant/qr       {merchant_id, payload}         → {merchant_id, source:'paste', ...}
 *   POST /internal/merchant/qr-image (multipart file=...)           → {merchant_id, source:'image', ...}
 *   GET  /internal/merchant/status                                  → {merchants:[...health...]}
 *   POST /internal/merchant/refresh  {merchant_id}                  → {merchant_id, refreshed_at}
 *   POST /internal/worker/run        {}                             → sweep result (manual trigger)
 *
 * OTP LINK FLOW (pola asli, blueprint §4.3):
 *   1. /otp      → GoBiz SMS. The SDK generates the persistent device_id ONCE
 *                  (newDeviceId) and it travels to the dashboard with the
 *                  otp_token; both MUST come back on /verify.
 *   2. /verify   → verifyOtp(otp, otp_token) with the SAME device_id →
 *                  getMe() → upsert qris_merchants (tokens + device_id).
 *   3. /qr|/qr-image → attach the STATIC QRIS payload (validated EMV).
 *
 * STATUS CONTRACT (what the dashboard's "Payment Gateway" panel renders):
 *   per merchant: name/phone, status (active|token_expired|disabled),
 *   token age, last_sync, has static QR + its source, and a ready flag.
 */

const express = require('express');
const { GoBizClient, normalizePhone, newDeviceId, GoBizError } = require('../gobiz');
const { validateStaticQRIS } = require('../emv');
const { decodeQrImage } = require('../decodeQris');
const { runSweep } = require('../worker');

const router = express.Router();

/** shorthands */
function bad(res, code, message) {
  return res.status(400).json({ error: code, message });
}

/**
 * Resolve `merchant_id` (the GoBiz identity) → qris_merchants row.
 * The dashboard always addresses merchants by their GoBiz merchant_id,
 * never by our internal uuid.
 */
async function requireMerchant(store, res, merchantId) {
  if (!merchantId || typeof merchantId !== 'string') {
    bad(res, 'BAD_REQUEST', 'merchant_id wajib diisi.');
    return null;
  }
  const merchant = await store.getMerchantByMerchantId(store.db, merchantId);
  if (!merchant) {
    res.status(404).json({ error: 'MERCHANT_NOT_FOUND', message: 'Merchant belum tertaut.' });
    return null;
  }
  return merchant;
}

// ---------------------------------------------------------------------------
// POST /internal/merchant/otp — step 1 of linking
// ---------------------------------------------------------------------------

async function merchantOtp(req, res, next) {
  try {
    const store = req.app.get('store');
    const { phone } = req.body || {};
    if (!phone) return bad(res, 'BAD_REQUEST', 'phone wajib diisi.');

    const bare = normalizePhone(phone);
    if (!bare || bare.length < 8) {
      return bad(res, 'BAD_REQUEST', 'Nomor telepon tidak valid (contoh: 0812… / +62 812…).');
    }

    // Device id is minted NOW and reused at verify + every future refresh —
    // rotating it later breaks the GoBiz session (blueprint §3.3).
    const deviceId = newDeviceId();
    const client = new GoBizClient({ deviceId });
    const { otpToken } = await client.requestOtp(bare);

    // Pre-warm persistence for ALREADY-LINKED rows (never touches tokens —
    // an abandoned re-link must leave the live session intact).
    await store.saveOtpSession(store.db, { phone: bare, deviceId });

    return res.json({
      otp_token: otpToken,
      device_id: deviceId,
      phone: bare,
      message: 'OTP dikirim via SMS. Kirim otp_token + device_id kembali saat verify.',
    });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /internal/merchant/verify — step 2: tokens + identity + upsert
// ---------------------------------------------------------------------------

async function merchantVerify(req, res, next) {
  try {
    const store = req.app.get('store');
    const { phone, otp, otp_token: otpToken, device_id: deviceId } = req.body || {};
    if (!phone || !otp || !otpToken || !deviceId) {
      return bad(res, 'BAD_REQUEST', 'phone, otp, otp_token, dan device_id wajib diisi.');
    }

    const bare = normalizePhone(phone);
    if (!bare) return bad(res, 'BAD_REQUEST', 'Nomor telepon tidak valid.');

    // SAME device_id as the /otp step — non-negotiable (§3.3).
    const client = new GoBizClient({ deviceId });
    const session = await client.verifyOtp(String(otp).trim(), otpToken);
    // getMe is an AUTHENTICATED call: the access token verifyOtp just minted
    // must be set on the client before it (go-merchant does exactly this:
    // `sdk.accessToken = access_token`). Without it the request goes out
    // headerless and GoBiz answers 401 "missing auth header" — the exact
    // prod failure this fixes.
    client.setAccessToken(session.accessToken);
    const me = await client.getMe();

    const { row, linked } = await store.linkMerchant(store.db, {
      merchantId: me.merchantId,
      merchantName: me.merchantName,
      phone: bare,
      deviceId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    });

    return res.json({
      merchant_id: row.merchant_id,
      merchant_name: row.merchant_name,
      linked, // true = first link, false = session refresh of an existing row
      has_static_qris: Boolean(row.static_qris),
      status: row.status,
      message: linked
        ? 'Merchant tertaut. Langkah berikutnya: unggah QRIS statis.'
        : 'Sesi diperbarui untuk merchant yang sudah tertaut.',
    });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /internal/merchant/qr — paste the payload string
// ---------------------------------------------------------------------------

async function merchantSetQr(req, res, next) {
  try {
    const store = req.app.get('store');
    const { merchant_id: merchantId, payload } = req.body || {};
    const merchant = await requireMerchant(store, res, merchantId);
    if (!merchant) return;

    if (!payload || typeof payload !== 'string') {
      return bad(res, 'BAD_REQUEST', 'payload (string QRIS) wajib diisi.');
    }
    const cleaned = payload.trim();
    if (cleaned.length > 883) {
      // EMVCo caps the payload at 512 bytes; QRIS strings run far below.
      return bad(res, 'BAD_REQUEST', 'Payload terlalu panjang — bukan string QRIS.');
    }

    const row = await store.setMerchantStaticQris(store.db, merchant.id, cleaned, validateStaticQRIS, 'paste');
    return res.json(toMerchantView(row, { message: 'QRIS statis tersimpan (sumber: paste).' }));
  } catch (err) {
    if (err.code === 'INVALID_QRIS') {
      return res.status(400).json({ error: 'INVALID_QRIS', message: err.message });
    }
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /internal/merchant/qr-image — upload the official QR image
// ---------------------------------------------------------------------------

/**
 * Accepts multipart/form-data (field `file`) or a raw image body
 * (Content-Type image/png | image/jpeg) — the dashboard server action can
 * forward whichever it already has. The payload is DECODED server-side and
 * validated identically to the paste path before storage.
 */
async function merchantSetQrImage(req, res, next) {
  try {
    const store = req.app.get('store');
    const merchantId =
      (req.body && req.body.merchant_id) ||
      (typeof req.query.merchant_id === 'string' ? req.query.merchant_id : null);
    const merchant = await requireMerchant(store, res, merchantId);
    if (!merchant) return;

    // Raw-image bodies carry the bytes in req.body (Buffer via express.raw);
    // multipart requests carry them in req.file.buffer (busboylike).
    const image = req.file && req.file.buffer ? req.file.buffer : Buffer.isBuffer(req.body) ? req.body : null;
    if (!image || image.length === 0) {
      return bad(res, 'BAD_REQUEST', 'File gambar tidak ditemukan (multipart field "file" atau raw PNG/JPEG body).');
    }

    let payload;
    try {
      payload = decodeQrImage(image);
    } catch (err) {
      return res.status(400).json({ error: err.code || 'DECODE_FAILED', message: err.message });
    }

    const row = await store.setMerchantStaticQris(store.db, merchant.id, payload, validateStaticQRIS, 'image');
    return res.json(toMerchantView(row, { message: 'QRIS statis tersimpan (sumber: gambar).' }));
  } catch (err) {
    if (err.code === 'INVALID_QRIS') {
      return res.status(400).json({ error: 'INVALID_QRIS', message: err.message });
    }
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// GET /internal/merchant/status — the dashboard panel's data source
// ---------------------------------------------------------------------------

function toMerchantView(row, extra = {}) {
  const tokenAgeHours = row.token_updated_at
    ? Math.floor((Date.now() - new Date(row.token_updated_at).getTime()) / 3_600_000)
    : null;
  return {
    merchant_id: row.merchant_id,
    merchant_name: row.merchant_name,
    phone: row.phone,
    status: row.status,
    token_age_hours: tokenAgeHours,
    last_sync: row.last_sync,
    has_static_qris: Boolean(row.static_qris),
    static_qris_source: row.static_qris_source ?? null,
    static_qris_set_at: row.static_qris_set_at ?? null,
    ready: row.status === 'active' && Boolean(row.static_qris), // can host checkouts
    ...extra,
  };
}

async function merchantStatus(req, res, next) {
  try {
    const store = req.app.get('store');
    const merchants = await store.listActiveMerchants(store.db); // active + token_expired
    const disabled = merchants.filter((m) => m.status === 'disabled');
    return res.json({
      merchants: merchants.map((m) => toMerchantView(m)),
      // Ops glance: any of these true → the dashboard shows a warning strip.
      summary: {
        total: merchants.length,
        ready: merchants.filter((m) => m.status === 'active' && m.static_qris).length,
        token_expired: merchants.filter((m) => m.status === 'token_expired').length,
        disabled: disabled.length,
      },
    });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /internal/merchant/refresh — force a token refresh
// ---------------------------------------------------------------------------

async function merchantRefresh(req, res, next) {
  try {
    const store = req.app.get('store');
    const { merchant_id: merchantId } = req.body || {};
    const merchant = await requireMerchant(store, res, merchantId);
    if (!merchant) return;
    if (merchant.status === 'disabled') {
      return res.status(403).json({ error: 'MERCHANT_DISABLED', message: 'Merchant dinonaktifkan — aktifkan dulu.' });
    }
    if (!merchant.refresh_token) {
      return res.status(409).json({
        error: 'NO_REFRESH_TOKEN',
        message: 'Tidak ada refresh token — lakukan link ulang (OTP) untuk merchant ini.',
      });
    }

    // withAccessToken's refresh-retry expects a 401 first; a MANUAL refresh
    // goes straight to the SDK with the PERSISTENT device id instead.
    const client = new GoBizClient({ deviceId: merchant.device_id });
    try {
      const out = await client.refreshToken(merchant.refresh_token);
      await store.saveMerchantTokens(store.db, merchant.id, {
        accessToken: out.accessToken,
        refreshToken: out.refreshToken, // null → store keeps the old one
      });
      return res.json({
        merchant_id: merchant.merchant_id,
        refreshed_at: new Date().toISOString(),
        rotated: Boolean(out.refreshToken),
        message: 'Token diperbarui.',
      });
    } catch (err) {
      // Hard failure → flag for the dashboard; the message says re-link.
      await store.markMerchantTokenExpired(store.db, merchant.id);
      return res.status(502).json({
        error: 'REFRESH_FAILED',
        message: `Refresh gagal: ${err.message} — lakukan link ulang (OTP).`,
      });
    }
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /internal/worker/run — manual sweep trigger (ops/debug)
// ---------------------------------------------------------------------------

async function workerRun(req, res, next) {
  try {
    const store = req.app.get('store');
    const result = await runSweep(store);
    return res.json({ ok: true, ...result });
  } catch (err) {
    return next(err);
  }
}

router.post('/merchant/otp', merchantOtp);
router.post('/merchant/verify', merchantVerify);
router.post('/merchant/qr', merchantSetQr);
router.post('/merchant/qr-image', merchantSetQrImage);
router.get('/merchant/status', merchantStatus);
router.post('/merchant/refresh', merchantRefresh);
router.post('/worker/run', workerRun);

module.exports = { router, toMerchantView };
