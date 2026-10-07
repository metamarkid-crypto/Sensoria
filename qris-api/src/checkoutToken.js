'use strict';

/**
 * checkoutToken.js — stateless, signed "browser checkout session" tokens.
 *
 * WHY: the mobile app can sign requests with HMAC (QRIS_API_SECRET), but a
 * BROWSER page cannot hold that secret (it ships in the APK). So the app
 * first asks the backend (authenticated, HMAC) for a short-lived TOKEN, and
 * the checkout page proves its authority by carrying that token — the token
 * itself is the capability. No DB row, no migration: the payload is base64
 * + HMAC-SHA256, so it cannot be forged or tampered with, and it expires.
 *
 * Payload (JSON, compact):
 *   { v: 1, d: <child device uuid>, l: <lang id|en|zh|ms>, exp: <unix seconds> }
 *
 * Token format:
 *   base64url(payloadJSON) + '.' + hex(HMAC-SHA256(payloadJSON, secret))
 *
 * The signature covers the EXACT payload bytes — any change (device, expiry)
 * breaks it. `exp` is enforced on verify. Security class: same as the mobile
 * HMAC layer — a scanner filter + tamper-proof binding to ONE child device.
 * The device uuid itself stays unguessable (v4 UUID).
 */

const crypto = require('node:crypto');

const DEFAULT_TTL_SECONDS = 6 * 60 * 60; // 6 h — long enough to finish paying

/** Resolve the token-signing secret (injectable for tests). */
function resolveSecret(override) {
  const secret =
    override ??
    process.env.PAY_CHECKOUT_TOKEN_SECRET ??
    process.env.QRIS_INTERNAL_SECRET ??
    process.env.QRIS_API_SECRET;
  if (!secret) {
    throw new Error('checkoutToken: PAY_CHECKOUT_TOKEN_SECRET (atau QRIS_INTERNAL_SECRET/QRIS_API_SECRET) wajib di-set.');
  }
  if (override === undefined && !process.env.PAY_CHECKOUT_TOKEN_SECRET) {
    console.warn(
      '[checkoutToken] PAY_CHECKOUT_TOKEN_SECRET belum di-set — memakai secret HMAC lain. ' +
        'Set PAY_CHECKOUT_TOKEN_SECRET terpisah agar token checkout tidak bergantung pada secret mobile/internal.',
    );
  }
  return secret;
}

const LANGS = new Set(['id', 'en', 'zh', 'ms']);

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Mint a token. `opts.secret`/`opts.now`/`opts.ttlSeconds` injectable (tests).
 * @returns {{ token: string, expiresAt: string }} expiresAt = ISO timestamp.
 */
function createCheckoutToken(deviceId, lang = 'id', opts = {}) {
  const secret = resolveSecret(opts.secret);
  const now = opts.now || Math.floor(Date.now() / 1000);
  const ttl = Number.isFinite(opts.ttlSeconds) ? opts.ttlSeconds : DEFAULT_TTL_SECONDS;
  const payload = JSON.stringify({
    v: 1,
    d: String(deviceId),
    l: LANGS.has(lang) ? lang : 'id',
    exp: now + ttl,
  });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const token = `${base64url(payload)}.${sig}`;
  return { token, expiresAt: new Date((now + ttl) * 1000).toISOString() };
}

/**
 * Verify a token. Returns the payload { d, l, exp, v } — or null for ANY
 * failure (bad format, bad signature, expired). Never throws: the browser
 * route just renders a "link expired" page.
 */
function verifyCheckoutToken(token, opts = {}) {
  try {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const payloadB64 = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!/^[0-9a-f]{64}$/i.test(sig)) return null;

    const secret = resolveSecret(opts.secret);
    const payloadStr = fromBase64url(payloadB64);
    const expected = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
    const a = Buffer.from(sig.toLowerCase(), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(payloadStr);
    if (!payload || payload.v !== 1 || typeof payload.d !== 'string') return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.d)) return null;

    const now = opts.now || Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || now > payload.exp) return null;

    return { d: payload.d, l: LANGS.has(payload.l) ? payload.l : 'id', exp: payload.exp, v: payload.v };
  } catch {
    return null;
  }
}

module.exports = { createCheckoutToken, verifyCheckoutToken, resolveSecret, DEFAULT_TTL_SECONDS };
