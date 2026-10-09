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
const appUpdateRoutes = require('./src/routes/appUpdate');
const webRoutes = require('./src/routes/web');

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
  app.use('/api/checkout-session', ipRateLimit);
  app.use('/api/webhook/toyyibpay', ipRateLimit);

  // -- browser checkout (NO HMAC: the page can never hold the APK secret) -----
  // GET /pay/:token (signed session token) + POST /api/webhook/toyyibpay
  // (gateway callback, MD5-verified inside the route). Mounted BEFORE the
  // global /api HMAC gate — the webhook and page come from browsers/gateways,
  // not the signed mobile client.
  app.use('/', webRoutes.router);

  // -- app self-update (mobile Android distribution from this VPS) --------------
  // /api/app-update/* — public version check; the DOWNLOAD itself is gated by
  // an expiring HMAC link minted here (no static open file server).
  app.use('/', appUpdateRoutes.router);

  // -- raw body → HMAC → routes ------------------------------------------------
  // Mobile mount: signed with QRIS_API_SECRET (the APK-embedded secret). This
  // is a scanner filter only — real security is server-side amount/plan
  // resolution (blueprint A4.5).
  app.use(
    '/api',
    express.raw({ type: 'application/json', limit: '64kb' }),
    hmacVerify(opts.hmac || { secretEnv: 'QRIS_API_SECRET' }),
    mobileRoutes.router,
  );

  // -- /internal/* : dashboard server actions -----------------------------------
  // HARDENING C-4 — two independent gates, because these routes can redirect
  // every customer payment (POST /internal/merchant/qr replaces the static
  // QRIS payload):
  //   1. IP allowlist (QRIS_INTERNAL_ALLOWLIST) — defaults to loopback only.
  //   2. A SEPARATE HMAC secret (QRIS_INTERNAL_SECRET). The mobile secret
  //      ships inside the APK, so it must NEVER be able to sign /internal/*.
  //      Falls back to QRIS_API_SECRET only when the dedicated secret is
  //      absent, so an un-migrated deployment keeps working (with a loud warn).
  //
  // JSON bodies AND raw image uploads (qr-image) both flow through here; the
  // multipart case is parsed after HMAC in the route (tiny, no extra dep).
  app.use(
    '/internal',
    internalIpAllowlist(opts.internalAllowlist),
    // App-update APK uploads are big; everything else stays tiny. (multipart
    // form-data IS an express-raw-parseable binary — parseMultipart splits it.)
    express.raw({ type: 'application/vnd.android.package-archive', limit: '200mb' }),
    express.raw({ type: 'application/octet-stream', limit: '200mb' }),
    express.raw({ type: 'multipart/form-data', limit: '200mb' }),
    express.raw({ type: '*/*', limit: '8mb' }),
    hmacVerify(opts.internalHmac || opts.hmac || { secretEnv: 'QRIS_INTERNAL_SECRET' }),
    parseMultipart,
    // App-update publish/status share the SAME HMAC gate (dashboard Owner-only).
    // Mounted WITH the internal router so both live behind identical gates.
    internalRoutes.router,
    appUpdateRoutes.router,
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

/**
 * IP allowlist for /internal/*  (HARDENING C-4).
 *
 * These routes can re-point every customer payment to another bank account,
 * so this is an OPT-IN extra gate on top of the separate HMAC secret.
 *
 * The PRIMARY defence is the separate QRIS_INTERNAL_SECRET (see app.js mount);
 * this allowlist is optional hardening for operators who know the dashboard's
 * source IP. It is DISABLED by default because a single-server aaPanel/Nginx
 * deployment calls https://app.aacsensoria.id and hairpins back through the
 * server's own public IP — a loopback default would wrongly 403 the dashboard
 * (the exact "tidak dapat diakses dari jaringan ini" symptom).
 *
 * QRIS_INTERNAL_ALLOWLIST: comma-separated IPs. When unset/empty → check is
 * skipped (HMAC still enforced). Set it to lock /internal/* to specific IPs,
 * e.g. QRIS_INTERNAL_ALLOWLIST=127.0.0.1,::1,10.0.0.5. Set * to explicitly
 * allow everything.
 */
function internalIpAllowlist(override) {
  const raw = override ?? process.env.QRIS_INTERNAL_ALLOWLIST ?? '';
  const list = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Unconfigured → rely on the separate HMAC secret alone (never break the
  // dashboard). Explicit `*` → same, but intentional.
  if (list.length === 0 || list.includes('*')) {
    return function internalAllowlist(req, res, next) {
      return next();
    };
  }

  return function internalAllowlist(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1) so operators
    // only have to list the familiar form.
    const bare = ip.replace(/^::ffff:/, '');
    if (list.includes(ip) || list.includes(bare)) return next();
    console.warn('[qris-api] /internal ditolak untuk IP', ip);
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Endpoint internal tidak dapat diakses dari jaringan ini.',
    });
  };
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
  // Fail-fast / loud-warn on the C-4 secret separation.
  if (!process.env.QRIS_INTERNAL_SECRET) {
    console.warn(
      '[qris-api] PERINGATAN KEAMANAN: QRIS_INTERNAL_SECRET belum di-set — /internal/* ' +
        'masih memakai QRIS_API_SECRET yang ikut terkirim di dalam APK. ' +
        'Set secret terpisah (lihat .env.example) lalu isi QRIS_API_SECRET yang sama di admin/.env.local.',
    );
  } else if (process.env.QRIS_INTERNAL_SECRET === process.env.QRIS_API_SECRET) {
    console.warn(
      '[qris-api] PERINGATAN KEAMANAN: QRIS_INTERNAL_SECRET identik dengan QRIS_API_SECRET — ' +
        'pemisahan tidak berguna. Gunakan nilai acak yang berbeda.',
    );
  }

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

  // Multi-provider hook: poll toyyibPay (MY) bills whose callback has not
  // arrived — every 30 s over the same node-cron tick as the QRIS worker.
  if (!/^(1|true|yes)$/i.test(process.env.TP_POLL_DISABLED || '')) {
    const nodeCron = require('node-cron');
    const providers = require('./src/providers');
    const store = app.get('store');
    nodeCron.schedule(process.env.TP_POLL_CRON || '*/30 * * * * *', async () => {
      try {
        const orders = await store.listPendingProviderOrders(store.db, 'toyyibpay');
        for (const order of orders) {
          await providers.pollToyyibPayOrder(store, store.db, order);
        }
      } catch (err) {
        console.error('[qris-api] toyyibPay poll gagal:', err.message);
      }
    });
    console.log('[qris-api] toyyibPay poller attached (MY orders)');
  }
}

module.exports = { buildApp, makeIpRateLimit, internalIpAllowlist };
