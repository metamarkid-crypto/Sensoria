'use strict';

/**
 * routes/mobile.js — mobile-facing checkout endpoints (HMAC-gated).
 *
 *   POST /api/qris-checkout  {device_id, plan_id}
 *     → { order_id, qris_image_base64, qris_expires_at }  (createQrisCheckout contract)
 *   POST /api/qris-status    {order_id}
 *     → { status, paid_at, transaction_ref, amount, expires_at }
 *
 * SECURITY invariants (blueprint §4.5):
 *   • The AMOUNT never comes from the client — it is resolved from
 *     plans.price server-side and copied into ledger + order.
 *   • device_id must exist and be a Child device; plan must be active.
 *   • Rate limits: express-rate-limit per IP (app.js) PLUS a per-device
 *     pending-order cap here (QRIS_MAX_OPEN_ORDERS, default 3).
 *   • Dynamic QR = static_qris transformed with emv.staticToDynamic —
 *     one QR per order, amount embedded, CRC recomputed.
 *   • /qris-status never 500s on GoBiz trouble — the row's own state is
 *     the source of truth the client can re-poll.
 */

const express = require('express');
const QRCode = require('qrcode');
const { staticToDynamic } = require('../emv');
const { instantVerify } = require('../settle');

const router = express.Router();

/** Per-device open-order cap (checkout abuse brake). */
const MAX_OPEN_ORDERS = parseInt(process.env.QRIS_MAX_OPEN_ORDERS || '3', 10);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// POST /api/qris-checkout
// ---------------------------------------------------------------------------

/**
 * Create a payment intent and render its dynamic QRIS.
 * Amount comes from plans.price ONLY. Ledger row (pending) + order row are
 * created together (store.createOrderWithLedger), the QR image is generated
 * from the linked merchant's static payload.
 */
async function qrisCheckout(req, res, next) {
  try {
    const { device_id: deviceId, plan_id: planId } = req.body || {};
    const store = req.app.get('store');

    if (!deviceId || !planId) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'device_id dan plan_id wajib diisi.' });
    }
    if (!UUID_RE.test(String(deviceId)) || !UUID_RE.test(String(planId))) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'Format id tidak valid.' });
    }

    // 1) Device must exist and be a Child (payments belong to children).
    const device = await store.getChildDevice(store.db, deviceId);
    if (!device) {
      return res.status(404).json({ error: 'DEVICE_NOT_FOUND', message: 'Perangkat tidak ditemukan.' });
    }
    if (device.role !== 'Child') {
      return res.status(403).json({ error: 'NOT_A_CHILD_DEVICE', message: 'Pembayaran hanya untuk perangkat anak.' });
    }

    // 2) Plan must exist and be active — pricing is resolved HERE.
    const plan = await store.getPlan(store.db, planId);
    if (!plan) {
      return res.status(404).json({ error: 'PLAN_NOT_FOUND', message: 'Paket tidak ditemukan.' });
    }
    if (!plan.is_active) {
      return res.status(403).json({ error: 'PLAN_INACTIVE', message: 'Paket tidak tersedia.' });
    }

    // 3) A linked merchant with a static QRIS payload is required to render.
    const merchant = await store.pickMerchantForCheckout(store.db);
    if (!merchant || !merchant.static_qris) {
      return res.status(503).json({
        error: 'NO_MERCHANT',
        message: 'Sistem pembayaran sedang tidak tersedia. Coba lagi nanti.',
      });
    }

    // 4) Per-device abuse brake: at most MAX_OPEN_ORDERS orders per 10 min.
    const recent = await store.countRecentOrdersForDevice(store.db, deviceId);
    if (recent >= MAX_OPEN_ORDERS) {
      return res.status(429).json({
        error: 'TOO_MANY_ORDERS',
        message: 'Terlalu banyak transaksi berjalan. Selesaikan atau tunggu sebelumnya.',
      });
    }

    const amount = Number(plan.price);
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(amount)) {
      // Price rows are editable in the dashboard — guard against bad data
      // before it becomes an unmatchable QR.
      return res.status(500).json({ error: 'PLAN_PRICE_INVALID', message: 'Harga paket tidak valid.' });
    }

    // 5) Dynamic QR FIRST (dry run): a rotted stored payload (merchant
    // re-issued their QR?) must refuse with NOTHING written — otherwise we
    // would orphan a pending ledger row with no QR behind a 503.
    let qrString;
    try {
      qrString = staticToDynamic(merchant.static_qris, amount);
    } catch (err) {
      console.error('[checkout] staticToDynamic gagal:', err.message);
      return res.status(503).json({
        error: 'MERCHANT_QRIS_INVALID',
        message: 'Sistem pembayaran sedang tidak tersedia. Coba lagi nanti.',
      });
    }

    // 6) Ledger (pending) + order row — one transaction_ref joins them.
    const order = await store.createOrderWithLedger(store.db, {
      childDeviceId: device.id,
      planId: plan.id,
      planKind: plan.kind || 'combo',
      amount,
      merchantDbId: merchant.id,
    });
    await store.attachQrToOrder(store.db, order.id, qrString, merchant.id);

    const qrisImageBase64 = await QRCode.toBuffer(qrString, {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 6,
    });

    return res.status(201).json({
      order_id: order.id,
      transaction_ref: order.transaction_ref,
      qris_image_base64: qrisImageBase64.toString('base64'),
      qris_expires_at: order.expires_at,
      amount,
      plan_name: plan.name,
    });
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/qris-status
// ---------------------------------------------------------------------------

/**
 * Status + instant verify: on "Saya Sudah Membayar" the endpoint polls the
 * merchant's GoBiz journals on demand (go-merchant's checkTransactionStatus
 * pattern) and settles on a match, then returns the row's fresh state.
 * Tap-frequency abuse is capped by the IP rate limit mounted in app.js; a
 * GoBiz failure never 500s — instantVerify swallows it and the row's own
 * state is returned unchanged.
 */
async function qrisStatus(req, res, next) {
  try {
    const { order_id: orderId } = req.body || {};
    const store = req.app.get('store');

    if (!orderId || !UUID_RE.test(String(orderId))) {
      return res.status(400).json({ error: 'BAD_REQUEST', message: 'order_id wajib diisi.' });
    }

    const order = await store.getOrderById(store.db, orderId);
    if (!order) {
      return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: 'Transaksi tidak ditemukan.' });
    }

    if (order.status === 'pending') {
      const fresh = await instantVerify(store, order);
      return res.json(toStatusBody(fresh || order));
    }

    return res.json(toStatusBody(order));
  } catch (err) {
    return next(err);
  }
}

function toStatusBody(order) {
  return {
    status: order.status,
    paid_at: order.paid_at,
    transaction_ref: order.transaction_ref,
    amount: Number(order.amount),
    expires_at: order.expires_at,
    order_id: order.id,
  };
}

router.post('/qris-checkout', qrisCheckout);
router.post('/qris-status', qrisStatus);

module.exports = { router, qrisCheckout, qrisStatus, toStatusBody };
