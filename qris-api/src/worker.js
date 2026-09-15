'use strict';

/**
 * worker.js — payment-detector cron (port of go-merchant worker.service.js).
 *
 * Every WORKER_CRON (default: 30 s; blueprint target is 60 s) one sweep runs:
 *
 *   1. EXPIRE — pending orders past expires_at → order 'expired' + ledger
 *      'failed' (store.expireOrder; guarded, replay-safe, bounded batch).
 *   2. SMART SELECTION — poll ONLY merchants that currently hold unexpired
 *      pending orders (go-merchant's saving grace against GoBiz rate flags;
 *      blueprint §5.1 "hindari polling tanpa PENDING").
 *   3. POLL + SETTLE — per merchant: getJournals (settlement/capture filter,
 *      sen→IDR normalized) → FIFO match → atomic journal claim → kind-aware
 *      settle_transaction → order mirror (settle.pollAndSettle).
 *
 * A 401 mid-poll triggers the refresh-retry with the merchant's PERSISTENT
 * device id (store.withAccessToken); a hard refresh failure flags the
 * merchant token_expired and polling moves on to the next merchant.
 *
 * OVERLAP GUARD: a sweep that outlives WORKER_CRON must never run twice —
 * GoBiz journals + FIFO claims are safe under concurrency but pointless and
 * rate-flag bait. `sweeping` skips re-entry.
 *
 * PROCESS MODEL: the HTTP service (app.js) and this cron live in the SAME
 * process by default (aaPanel/PM2 runs one app; keep the memory footprint
 * and deployment surface small). WORKER_DISABLED=1 splits it out when the
 * deployment outgrows that.
 */

const cron = require('node-cron');
const { createStore } = require('./store');
const { pollAndSettle } = require('./settle');

const DEFAULT_CRON = '*/30 * * * * *'; // every 30 s
const DEFAULT_EXPIRE_BATCH = 200;

function parseIntEnv(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * One sweep. Exported for tests and the /internal/worker/run trigger.
 * Never throws — a sweep is a best-effort batch; failures are logged with
 * enough context (merchant id, error code) for an ops pass.
 *
 * @returns {Promise<{expired: number, polled: number, settled: number}>}
 */
async function runSweep(store, { log = console } = {}) {
  const out = { expired: 0, polled: 0, settled: 0 };

  // ---- 1) expiry pass ------------------------------------------------------
  try {
    const stale = await store.listStalePendingOrders(store.db, parseIntEnv('WORKER_EXPIRE_BATCH', DEFAULT_EXPIRE_BATCH));
    for (const order of stale) {
      try {
        const done = await store.expireOrder(store.db, order.id);
        if (done) out.expired += 1;
      } catch (err) {
        log.error('[worker] expire gagal untuk', order.transaction_ref, err.code || err.message);
      }
    }
    if (out.expired > 0) log.log('[worker] expired', out.expired, 'order(s)');
  } catch (err) {
    log.error('[worker] expiry pass gagal:', err.code || err.message);
    // Expiry failed — settlement can still proceed; don't abort the sweep.
  }

  // ---- 2) smart selection --------------------------------------------------
  let merchants = [];
  try {
    merchants = await store.listMerchantsWithPendingOrders(store.db);
  } catch (err) {
    log.error('[worker] smart selection gagal:', err.code || err.message);
    return out;
  }
  // Default (production) posture: only merchants with live PENDING orders.
  // WORKER_POLL_ALL_MERCHANTS is a debug escape hatch that widens the set to
  // every active merchant — polling without PENDING invites rate flags.
  if (/^(1|true|yes)$/i.test(process.env.WORKER_POLL_ALL_MERCHANTS || '')) {
    try {
      merchants = await store.listActiveMerchants(store.db);
    } catch (err) {
      log.error('[worker] listActiveMerchants gagal:', err.code || err.message);
    }
  }
  if (merchants.length === 0) return out;

  // ---- 3) poll + settle per merchant --------------------------------------
  for (const merchant of merchants) {
    if (merchant.status === 'disabled') continue;
    out.polled += 1;
    try {
      const settled = await pollAndSettle(store, merchant);
      out.settled += settled;
      await store.touchMerchantSync(store.db, merchant.id);
      if (settled > 0) log.log('[worker] merchant', merchant.merchant_id, 'settled', settled, 'order(s)');
    } catch (err) {
      // pollAndSettle already swallows per-merchant token failures; anything
      // reaching here is a programming/store error — log and keep going.
      log.error('[worker] poll gagal untuk merchant', merchant.merchant_id, err.code || err.message);
    }
  }

  return out;
}

/**
 * Create (but don't start) the worker. `opts.store` injects a store (tests);
 * `opts.cron` overrides the pattern; `opts.log` swaps the logger.
 */
function createWorker(opts = {}) {
  const store = opts.store || createStore();
  const log = opts.log || console;
  const pattern = opts.cron || process.env.WORKER_CRON || DEFAULT_CRON;

  let sweeping = false;
  let task = null;

  async function guardedSweep() {
    if (sweeping) {
      log.log('[worker] sweep masih berjalan — dilewati');
      return null;
    }
    sweeping = true;
    const started = Date.now();
    try {
      const result = await runSweep(store, { log });
      log.log(
        `[worker] sweep selesai dalam ${Date.now() - started}ms: ` +
          `expired=${result.expired} polled=${result.polled} settled=${result.settled}`,
      );
      return result;
    } finally {
      sweeping = false;
    }
  }

  return {
    store,
    /** Run one sweep right now (tests, manual trigger). */
    runOnce: guardedSweep,
    /** Start the cron. Returns the scheduled task. */
    start() {
      if (task) return task;
      if (!cron.validate(pattern)) {
        throw new Error(`worker: WORKER_CRON tidak valid: "${pattern}"`);
      }
      task = cron.schedule(pattern, () => {
        guardedSweep().catch((err) => log.error('[worker] sweep error:', err.message));
      });
      log.log(`[worker] cron started (${pattern})`);
      return task;
    },
    /** Stop the cron (tests teardown, graceful shutdown). */
    stop() {
      if (task) {
        task.stop();
        task = null;
        log.log('[worker] cron stopped');
      }
    },
    get isSweeping() {
      return sweeping;
    },
  };
}

/** Standalone entry: node src/worker.js */
if (require.main === module) {
  require('dotenv').config();
  const worker = createWorker();
  worker.start();
  const shutdown = () => {
    worker.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createWorker, runSweep };
