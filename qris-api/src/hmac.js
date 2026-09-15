'use strict';

/**
 * hmac.js — shared-secret signature verification for the qris-api HTTP layer.
 *
 * Contract (blueprint §4.3/§4.5):
 *   X-Sensoria-Timestamp : unix seconds, |now - ts| <= QRIS_HMAC_MAX_SKEW (default 300 s)
 *   X-Sensoria-Sign      : HEX HMAC-SHA256( `${timestamp}.${rawBody}`, QRIS_API_SECRET )
 *
 * The timestamp binds each signature to a small time window so a captured
 * (sign, body) pair cannot be replayed forever. Clock drift between phone
 * and server is tolerated up to QRIS_HMAC_MAX_SKEW seconds.
 *
 * SECURITY honesty (blueprint §4.5): the mobile secret ships inside the APK,
 * so this is a SCANNER FILTER, not strong auth. Real security is server-side:
 * amount and plan kind are resolved from `plans`, the device must exist, and
 * the ledger is append-only. Internal routes additionally gate on admin auth
 * at the dashboard server-action layer (never the APK).
 *
 * Timing-safe comparison via crypto.timingSafeEqual on equal-length buffers.
 */

const crypto = require('node:crypto');

const DEFAULT_MAX_SKEW_SECONDS = 300;

/**
 * Compute the signature for a raw body — exported so the admin dashboard
 * server actions and tests can sign requests the same way the middleware
 * verifies them.
 */
function signPayload(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Constant-time hex-string comparison (false instead of throw on length mismatch). */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware factory. `opts.secret` defaults to QRIS_API_SECRET.
 *
 * MUST be mounted AFTER the raw-body parser (the signature covers the exact
 * bytes the client signed — a re-serialized JSON body would fail).
 */
function hmacVerify(opts = {}) {
  const secret = opts.secret || process.env.QRIS_API_SECRET;
  const maxSkew = Number.isFinite(opts.maxSkewSeconds)
    ? opts.maxSkewSeconds
    : parseInt(process.env.QRIS_HMAC_MAX_SKEW || String(DEFAULT_MAX_SKEW_SECONDS), 10);

  if (!secret) {
    throw new Error('hmac: QRIS_API_SECRET wajib di-set (env atau opts.secret).');
  }

  return function hmacMiddleware(req, res, next) {
    const timestamp = req.get('X-Sensoria-Timestamp');
    const signature = req.get('X-Sensoria-Sign');

    if (!timestamp || !signature) {
      return res.status(401).json({ error: 'MISSING_SIGNATURE', message: 'Header tanda tangan hilang.' });
    }

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      return res.status(401).json({ error: 'BAD_TIMESTAMP', message: 'Timestamp tidak valid.' });
    }

    const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (skew > maxSkew) {
      return res.status(401).json({ error: 'TIMESTAMP_SKEW', message: 'Timestamp di luar jendela yang diizinkan.' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const expected = signPayload(rawBody.toString('utf8'), secret, ts);
    if (!safeEqualHex(signature.toLowerCase(), expected)) {
      return res.status(401).json({ error: 'BAD_SIGNATURE', message: 'Tanda tangan tidak valid.' });
    }

    // Hand the parsed body downstream: JSON is parsed from the exact bytes
    // we verified; non-JSON bodies (multipart form, raw image upload) stay a
    // Buffer for their route to consume.
    if (rawBody.length > 0) {
      const contentType = String(req.headers['content-type'] || '');
      if (contentType.includes('application/json')) {
        try {
          req.body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return res.status(400).json({ error: 'BAD_JSON', message: 'Body bukan JSON yang valid.' });
        }
      } else {
        req.body = rawBody;
      }
    } else {
      req.body = {};
    }
    return next();
  };
}

module.exports = { hmacVerify, signPayload, safeEqualHex, DEFAULT_MAX_SKEW_SECONDS };
