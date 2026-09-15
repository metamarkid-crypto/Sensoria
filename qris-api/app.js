'use strict';

/**
 * app.js — Sensoria QRIS API (Express, port 3200, app.aacsensoria.id).
 *
 * Mount map (blueprint §4):
 *   GET  /api/health          — uptime probe (no auth, mounted BEFORE HMAC)
 *   POST /api/qris-checkout   — mobile, HMAC   (this build)
 *   POST /api/qris-status     — mobile, HMAC   (this build)
 *   POST /internal/*          — dashboard admin ops (HMAC; next build step)
 *
 * SECURITY LAYERING (blueprint §4.5):
 *   1. helmet-lite headers set here
 *   2. IP rate limit on the money endpoints
 *   3. HMAC signature on the raw body (src/hmac.js) — a scanner filter, not
 *      strong auth; real security is server-side pricing + child-device check
 *   4. service-role Supabase access ONLY inside this process
 *
 * Raw-body subtlety: the HMAC covers the EXACT bytes the client signed, so
 * the body is captured as a Buffer BEFORE any JSON parsing and parsed by the
 * HMAC middleware itself (express.raw, then hmacVerify, then routes).
 */

require('dotenv').config();

const express = require('express');
const { createStore } = require('./src/store');
const { hmacVerify } = require('./src/hmac');
const mobileRoutes = require('./src/routes/mobile');
const internalRoutes = require('./src/routes/internal');

/**
 * Build the full app. `opts.store` injects a store (tests); otherwise the
 * service-role store is created from the env — and THROWS at boot when the
 * service key is missing: silently running without settlement is a money bug.
 */
function buildApp(opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Nginx (aaPanel) — correct req.ip

  // -- helmet-lite ------------------------------------------------------------
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // -- store (real or injected) ----------------------------------------------
  const store = opts.store || createStore();
  app.set('store', store);

  // -- health (before everything: the probe must answer even when broke) ------
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      service: 'qris-api',
      uptime_s: Math.floor(process.uptime()),
      ts: new Date().toISOString(),
    });
  });

  // -- rate limiting (IP-based; per-device cap lives in the checkout route) ---
  const ipRateLimit = makeIpRateLimit();
  app.use('/api/qris-checkout', ipRateLimit);
  app.use('/api/qris-status', ipRateLimit);

  // -- raw body → HMAC → routes ------------------------------------------------
  app.use(
    '/api',
    express.raw({ type: 'application/json', limit: '64kb' }),
    hmacVerify(opts.hmac || {}),
    mobileRoutes.router,
  );

  // -- /internal/* : dashboard server actions (same HMAC doctrine) -------------
  // JSON bodies AND raw image uploads (qr-image) both flow through here; the
  // multipart case is parsed after HMAC in the route (tiny, no extra dep).
  app.use(
    '/internal',
    express.raw({ type: '*/*', limit: '8mb' }),
    hmacVerify(opts.hmac || {}),
    parseMultipart,
    internalRoutes.router,
  );

  // -- 404 + error sink ---------------------------------------------------------
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[qris-api] unhandled:', err.code || '', err.message);
    if (process.env.QRIS_DEBUG === '1') console.error(err.stack);
    const status = err.status || 500;
    res.status(status).json({
      error: err.code || 'INTERNAL_ERROR',
      message: 'Terjadi kesalahan server. Coba lagi.',
    });
  });

  return app;
}

/**
 * Multipart/form-data parser for the ONE endpoint that needs it
 * (/internal/merchant/qr-image). NOT a general parser: it extracts the
 * single `file` field's bytes + `merchant_id` text field from the raw body
 * (already HMAC-verified as bytes above) and rewrites req.body/req.file.
 * Anything non-multipart passes through untouched (JSON stays parsed).
 */
function parseMultipart(req, res, next) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    // JSON body: HMAC middleware already left a parsed object in req.body.
    return next();
  }
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return res.status(400).json({ error: 'BAD_MULTIPART', message: 'Boundary multipart tidak ditemukan.' });
  const boundary = '--' + (m[1] || m[2]).trim();
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');

  const bodyBinary = body.toString('binary');
  const parts = bodyBinary.split(boundary).slice(1, -1);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const value = part.slice(headerEnd + 4).replace(/\r\n$/, '');
    const nameMatch = /name="([^"]+)"/.exec(headers);
    const fileMatch = /filename="([^"]*)"/.exec(headers);
    const fieldName = nameMatch ? nameMatch[1] : null;
    if (fileMatch) {
      // Binary field: slice the ORIGINAL buffer (binary-string offsets map 1:1).
      const partStart = bodyBinary.indexOf(part);
      const bufferStart = partStart + headerEnd + 4;
      const bufferEnd = bufferStart + Buffer.byteLength(value, 'binary');
      req.file = { fieldname: fieldName, filename: fileMatch[1], buffer: body.subarray(bufferStart, bufferEnd) };
    } else if (fieldName) {
      req.body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        ? req.body
        : {};
      req.body[fieldName] = Buffer.from(value, 'binary').toString('utf8');
    }
  }
  if (!req.body || Buffer.isBuffer(req.body)) req.body = {};
  return next();
}

/** Minimal window limiter (no external dep): max requests per IP per window. */
function makeIpRateLimit() {
  const WINDOW_MS = parseInt(process.env.QRIS_RATE_WINDOW_MS || '60000', 10);
  const MAX = parseInt(process.env.QRIS_RATE_MAX || '20', 10);
  const hits = new Map(); // ip → [timestamps]
  return function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (arr.length >= MAX) {
      return res.status(429).json({ error: 'RATE_LIMITED', message: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
    }
    arr.push(now);
    hits.set(ip, arr);
    if (hits.size > 10000) {
      // Memory brake: drop stale entries wholesale on overflow.
      for (const [k, v] of hits) {
        if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
      }
    }
    return next();
  };
}

/** Start listening unless imported by tests/supervisor. */
if (require.main === module) {
  const app = buildApp();
  const PORT = parseInt(process.env.PORT || '3200', 10);
  app.listen(PORT, () => {
    console.log(`[qris-api] listening on :${PORT}`);
  });

  // Same-process worker (blueprint §4.4; PM2 runs one app). Set
  // WORKER_DISABLED=1 to run the cron as a separate process instead
  // (node src/worker.js) once the deployment outgrows this.
  if (!/^(1|true|yes)$/i.test(process.env.WORKER_DISABLED || '')) {
    const { createWorker } = require('./src/worker');
    const worker = createWorker();
    worker.start();
    console.log('[qris-api] worker attached to HTTP process');
  }
}

module.exports = { buildApp, makeIpRateLimit };
