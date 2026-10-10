'use strict';

/**
 * routes/web.js — BROWSER-facing checkout (no HMAC: the APK secret can never
 * reach a web page). Authority comes from the signed checkout TOKEN the app
 * obtained via POST /api/checkout-session.
 *
 *   GET  /pay/:token            → checkout page (plan list; IDR plans for
 *                                 BOTH regions — QRIS global covers MY too)
 *   GET  /pay/:token/plan/:planId?provider=qris-gobiz
 *                               → creates the order server-side and shows the
 *                                 dynamic QRIS with a status poll (the only
 *                                 ACTIVE rail — Malaysia pays the same IDR
 *                                 QRIS via QRIS-global cross-border scanning;
 *                                 provider=toyyibpay remains as a DORMANT
 *                                 rollback path through its hosted bill page)
 *   GET  /pay/:token/status/:ref → JSON order status for the page's poller
 *   POST /api/webhook/toyyibpay → dormant gateway callback (MD5-hash verified)
 *
 * SECURITY:
 *   • Token: tamper-proof HMAC binding to ONE child device uuid + expiry
 *     (checkoutToken.js). No secret in the page; the token only authorizes
 *     buying plans for that device.
 *   • Amounts/plans resolved SERVER-SIDE only (never from query params).
 *   • Webhook: MD5(userSecretKey + status + order_id + refno + 'ok') verified
 *     constant-time; a replay is a no-op (guarded claim + idempotent RPC).
 *   • XSS: every dynamic value is HTML-escaped; no inline template injection.
 *   • CSRF: order creation requires a fresh GET (token link) — money writes
 *     only happen from our own rendered page or the verified webhook.
 *
 * The pages render from plain HTML template files in qris-checkout/ (via
 * src/templates.js — no view-engine dependency): they must render even when
 * node_modules is minimal and load fast on mobile data in both ID and MY.
 */

const express = require('express');
const path = require('path');
const QRCode = require('qrcode');
const { verifyCheckoutToken } = require('../checkoutToken');
const providers = require('../providers');
const toyyibpay = require('../toyyibpay');
const { render, esc } = require('../templates');

const router = express.Router();

// Static checkout assets (QRIS frame, success/expired art) from the
// qris-checkout folder. Immutable-ish cache — art changes only on deploy.
router.use(
  '/pay-assets',
  express.static(path.join(__dirname, '..', '..', 'qris-checkout', 'images'), {
    maxAge: '1d',
    fallthrough: false,
  }),
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Checkout-page security headers (helmet-lite already sets the globals in
 * app.js; these are page-specific):
 *   • CSP — everything is inline by design (zero external JS/CSS, pages must
 *     render on flaky mobile data), so the policy pins the SAME inline
 *     sources: no external script/style/img/connect origin can ever load,
 *     which kills exfil-via-network even if an injection ever slipped past
 *     the esc() renderer. data: is needed for the QR image + Download QRIS.
 *     form-action 'self' (NOT 'none'): the plan list orders via a plain
 *     same-origin GET <form> — 'none' silently killed every Pay button.
 *   • no-store — a QR page is a live money view; a cached page would show a
 *     spent QR after Back-navigation (users re-pay an expired code).
 */
function checkoutPageHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "script-src 'unsafe-inline'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
    ].join('; '),
  );
  res.setHeader('Cache-Control', 'no-store');
}

/** Locale strings for the checkout page (id/en/zh/ms — matches the app). */
const PAGE_STRINGS = {
  id: {
    title: 'Sensoria Premium — Checkout',
    subtitle: 'Pilih paket langganan Combo (1 Anak + semua Orang Tua terhubung).',
    month: 'Bulan',
    months: 'Bulan',
    perMonth: '/bln',

    choose: 'Bayar Sekarang',
    secure: 'Pembayaran diproses oleh penyedia pembayaran resmi. Sensoria tidak menyimpan data kartu Anda.',
    loading: 'Memproses…',
    errorGeneric: 'Terjadi kesalahan. Silakan coba lagi.',
    orderRef: 'Ref',
    scanQris: 'Scan QRIS ini dengan aplikasi bank / e-wallet Anda',
    scanTitle: 'Scan QRIS',
    statusLabel: 'Status Pembayaran',
    timeLeft: 'Sisa Waktu',
    checkStatus: 'Cek Status',
    downloadQris: 'Unduh QRIS',
    pendingLabel: 'Menunggu',
    expiredBadge: 'Kedaluwarsa',
    waiting: 'Menunggu pembayaran…',
    paid: 'Pembayaran Berhasil!',
    paidDesc: 'Premium telah aktif untuk perangkat anak Anda. Kembali ke aplikasi untuk melanjutkan.',
    expired: 'Tautan Kedaluwarsa',
    expiredDesc: 'Sesi checkout tidak valid atau sudah kedaluwarsa. Buka kembali dari aplikasi Sensoria.',
    backToApp: 'Kembali ke Aplikasi',
  },
  en: {
    title: 'Sensoria Premium — Checkout',
    subtitle: 'Choose a Combo subscription (1 Child + all linked Parents).',
    month: 'Month',
    months: 'Months',
    perMonth: '/mo',

    choose: 'Pay Now',
    secure: 'Payment is processed by official payment providers. Sensoria never stores your card data.',
    loading: 'Processing…',
    errorGeneric: 'Something went wrong. Please try again.',
    orderRef: 'Ref',
    scanQris: 'Scan this QRIS code with your bank / e-wallet app',
    scanTitle: 'Scan QRIS',
    statusLabel: 'Payment Status',
    timeLeft: 'Time Left',
    checkStatus: 'Check Status',
    downloadQris: 'Download QRIS',
    pendingLabel: 'Pending',
    expiredBadge: 'Expired',
    waiting: 'Waiting for payment…',
    paid: 'Payment Successful!',
    paidDesc: 'Premium is now active for your child\u2019s device. Return to the Sensoria app to continue.',
    expired: 'Link Expired',
    expiredDesc: 'This checkout session is invalid or has expired. Reopen it from the Sensoria app.',
    backToApp: 'Back to App',
  },
  zh: {
    title: 'Sensoria 高级版 — 结账',
    subtitle: '选择 Combo 订阅套餐（1 个儿童设备 + 所有已关联的家长）。',
    month: '个月',
    months: '个月',
    perMonth: '/月',

    choose: '立即支付',
    secure: '支付由官方支付服务商处理。Sensoria 不会存储您的银行卡信息。',
    loading: '处理中…',
    errorGeneric: '发生错误，请重试。',
    orderRef: '编号',
    scanQris: '使用您的银行 / 电子钱包应用扫描此 QRIS 码',
    scanTitle: '扫描 QRIS',
    statusLabel: '支付状态',
    timeLeft: '剩余时间',
    checkStatus: '检查状态',
    downloadQris: '下载二维码',
    pendingLabel: '待支付',
    expiredBadge: '已过期',
    waiting: '等待支付…',
    paid: '支付成功！',
    paidDesc: '高级版已在您孩子的设备上激活。请返回 Sensoria 应用继续使用。',
    expired: '链接已过期',
    expiredDesc: '结账会话无效或已过期。请从 Sensoria 应用重新打开。',
    backToApp: '返回应用',
  },
  ms: {
    title: 'Sensoria Premium — Checkout',
    subtitle: 'Pilih langganan Combo (1 Peranti Anak + semua Ibubapa yang dipautkan).',
    month: 'Bulan',
    months: 'Bulan',
    perMonth: '/bln',

    choose: 'Bayar Sekarang',
    secure: 'Pembayaran diproses oleh penyedia pembayaran rasmi. Sensoria tidak menyimpan data kad anda.',
    loading: 'Memproses…',
    errorGeneric: 'Masalah berlaku. Sila cuba lagi.',
    orderRef: 'Rujukan',
    scanQris: 'Imbas kod QRIS ini dengan aplikasi bank / e-dompet anda',
    scanTitle: 'Imbas QRIS',
    statusLabel: 'Status Pembayaran',
    timeLeft: 'Masa Berbaki',
    checkStatus: 'Semak Status',
    downloadQris: 'Muat Turun QRIS',
    pendingLabel: 'Menunggu',
    expiredBadge: 'Tamat Tempoh',
    waiting: 'Menunggu pembayaran…',
    paid: 'Pembayaran Berjaya!',
    paidDesc: 'Premium kini aktif untuk peranti anak anda. Kembali ke aplikasi Sensoria untuk teruskan.',
    expired: 'Pautan Tamat Tempoh',
    expiredDesc: 'Sesi checkout tidak sah atau telah tamat tempoh. Buka semula dari aplikasi Sensoria.',
    backToApp: 'Kembali ke Aplikasi',
  },
};

/** Format prices: whole amounts grouped, cent amounts with 2 decimals. */
function formatPrice(amount, currency) {
  const n = Number(amount);
  const symbol = currency === 'MYR' ? 'RM' : 'Rp';
  if (!Number.isInteger(n)) {
    return `${symbol}${n.toFixed(2)}`;
  }
  const grouped = Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${symbol}${grouped}`;
}

function pageShell(lang, title, bodyHtml) {
  return render('layout', { lang, title, body: bodyHtml });
}

function renderExpiredPage(lang) {
  const s = PAGE_STRINGS[lang] || PAGE_STRINGS.en;
  return render('expired', { expired: s.expired, expiredDesc: s.expiredDesc });
}

/** GET /pay/:token — plan list (IDR plans for BOTH regions — QRIS global). */
async function checkoutPage(req, res, next) {
  try {
    const { token } = req.params;
    const payload = verifyCheckoutToken(token);
    if (!payload) {
      return res.status(403).send(renderExpiredPage('en'));
    }
    const lang = payload.l;
    const s = PAGE_STRINGS[lang] || PAGE_STRINGS.en;
    const store = req.app.get('store');
    const db = store.db;

    // The device must still exist (uninstalled/cleaned-up devices 403 here).
    const device = await store.getChildDevice(db, payload.d);
    if (!device || device.role !== 'Child') {
      return res.status(403).send(renderExpiredPage(lang));
    }

    // QRIS global: Malaysia pays the SAME IDR plans — the payer's DuitNow
    // app converts IDR→MYR at scan time, so there is no region switch and
    // no MYR plan list. (A ?region=MY link from an older page still works:
    // it simply renders this same single-rail page.)
    const plans = await providers.listPlansForCurrency(db, 'IDR');
    const provider = providers.resolveProvider('ID');

    const planCards = plans
      .map((p) => {
        const perMonth = Math.round(Number(p.price) / Math.max(1, p.duration_months));
        return render('plan-card', {
          name: p.name,
          monthsLine: `${p.duration_months} ${p.duration_months > 1 ? s.months : s.month}`,
          descSuffix: p.description ? ` — ${p.description}` : '',
          price: formatPrice(p.price, p.currency),
          perMonth: formatPrice(perMonth, p.currency),
          perMonthSuffix: s.perMonth,
          action: `/pay/${encodeURIComponent(token)}/plan/${encodeURIComponent(p.id)}`,
          provider: provider.id,
          buttonLabel: `${s.choose} — ${formatPrice(p.price, p.currency)}`,
        });
      })
      .join('');

    checkoutPageHeaders(res);
    const body = render('checkout', {
      subtitle: s.subtitle,
      plansError: plans.length === 0 ? `<div class="err">${esc(s.errorGeneric)}</div>` : '',
      planCards,
      secure: s.secure,
    });
    return res.send(pageShell(lang, s.title, body));
  } catch (err) {
    return next(err);
  }
}

/** GET /pay/:token/plan/:planId?provider=… — create order → redirect/QR. */
async function createOrderAndRedirect(req, res, next) {
  try {
    const { token, planId } = req.params;
    const payload = verifyCheckoutToken(token);
    if (!payload) return res.status(403).send(renderExpiredPage('en'));
    if (!UUID_RE.test(String(planId))) {
      return res.status(400).send(renderExpiredPage(payload.l));
    }
    const lang = payload.l;
    const s = PAGE_STRINGS[lang] || PAGE_STRINGS.en;
    const store = req.app.get('store');
    const db = store.db;

    const device = await store.getChildDevice(db, payload.d);
    if (!device || device.role !== 'Child') return res.status(403).send(renderExpiredPage(lang));

    // Plan is resolved server-side; its currency selects the provider —
    // a plan row can never be paid through the wrong currency's provider.
    const plan = await store.getPlan(db, planId);
    if (!plan || !plan.is_active) return res.status(404).send(renderExpiredPage(lang));
    const provider = providers.resolveProvider(plan.currency === 'MYR' ? 'MY' : 'ID', req.query.provider);

    // Currency discipline: a plan can never be paid through a provider whose
    // currency mismatches the plan (e.g. an MYR plan forced onto the IDR
    // QRIS rail would print a WRONG-AMOUNT QR). With MY defaulted to
    // qris-gobiz (IDR), this also refuses MYR plans without an explicit
    // toyyibpay hint — the dormant rollback path.
    if (provider.currency !== (plan.currency || 'IDR')) {
      return res.status(400).send(renderExpiredPage(lang));
    }

    const expiresAt = store.orderExpiresAt();
    const { order, qrString } = await providers.createOrderForProvider(store, db, {
      provider,
      device,
      plan,
      expiresAt,
    });

    if (qrString) {
      // Active rail: render the invoice-style QRIS page + status poller.
      checkoutPageHeaders(res);
      const dataUrl = await QRCode.toBuffer(qrString, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
      const qrSrc = `data:image/png;base64,${dataUrl.toString('base64')}`;
      return res.send(
        render('qris', {
          lang,
          title: s.scanTitle,
          scanTitle: s.scanTitle,
          qrDataUrl: qrSrc,
          statusLabel: s.statusLabel,
          timeLeft: s.timeLeft,
          pendingLabel: s.pendingLabel,
          expiredBadge: s.expiredBadge,
          checkStatus: s.checkStatus,
          downloadQris: s.downloadQris,
          downloadUrl: qrSrc,
          orderRef: s.orderRef,
          ref: order.transaction_ref,
          expiresAtMs: Date.parse(order.expires_at || new Date(Date.now() + 15 * 60 * 1000).toISOString()),
          statusUrl: `/pay/${encodeURIComponent(token)}/status/${encodeURIComponent(order.transaction_ref)}`,
          paidText: s.paid,
          doneUrl: `/pay/${encodeURIComponent(token)}/done`,
        }),
      );
    }

    // Dormant rollback path: hand off to the gateway's hosted bill page
    // (FPX / card / DuitNow QR). No region reaches this by default anymore.
    const raw = order.raw_journal || {};
    if (raw.payUrl) return res.redirect(302, raw.payUrl);
    return res.status(502).send(renderExpiredPage(lang));
  } catch (err) {
    return next(err);
  }
}

/** GET /pay/:token/status/:ref — JSON poll source for the page. */
async function orderStatusForPage(req, res, next) {
  try {
    const payload = verifyCheckoutToken(req.params.token);
    if (!payload) return res.status(403).json({ error: 'TOKEN_EXPIRED' });
    const ref = String(req.params.ref || '');
    if (!/^AAC-\d{8}-[0-9A-F]{6}$/i.test(ref)) {
      return res.status(400).json({ error: 'BAD_REF' });
    }
    const store = req.app.get('store');
    const db = store.db;
    const order = await store.getOrderByRef(db, ref);
    if (!order || order.child_device_id !== payload.d) {
      return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ status: order.status, paid_at: order.paid_at, amount: Number(order.amount), currency: order.currency });
  } catch (err) {
    return next(err);
  }
}

/** GET /pay/:token/done — friendly terminal page (QR path success). */
function donePage(req, res) {
  const payload = verifyCheckoutToken(req.params.token);
  const lang = payload ? payload.l : 'en';
  const s = PAGE_STRINGS[lang] || PAGE_STRINGS.en;
  checkoutPageHeaders(res);
  return res.send(
    pageShell(
      lang,
      s.paid,
      render('done', { paid: s.paid, paidDesc: s.paidDesc, backToApp: s.backToApp }),
    ),
  );
}

/**
 * POST /api/webhook/toyyibpay — server-to-server payment notification.
 * form-encoded: refno, status(1/2/3), reason, billcode, order_id(=transaction_ref),
 * amount, transaction_time, hash = MD5(secret+status+order_id+refno+'ok').
 * ALWAYS 200 (except config errors) so the gateway does not retry-storm;
 * invalid hashes get 403.
 */
async function toyyibpayWebhook(req, res) {
  try {
    const secretKey = process.env.TOYYIBPAY_SECRET_KEY;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const status = String(b.status ?? '');
    const orderId = String(b.order_id ?? '');
    const refno = String(b.refno ?? '');
    const billCode = String(b.billcode ?? b.billCode ?? '');
    const hash = String(b.hash ?? '');

    if (!secretKey) return res.status(503).json({ error: 'NOT_CONFIGURED' });
    if (!orderId || !toyyibpay.verifyCallbackHash({ secretKey, status, orderId, refno, hash })) {
      return res.status(403).json({ error: 'BAD_HASH' });
    }
    if (status !== '1') return res.status(200).json({ ok: true, ignored: status }); // 2=pending, 3=fail

    const store = req.app.get('store');
    const outcome = await providers.settleToyyibPayOrder(store, store.db, {
      transactionRef: orderId,
      billCode,
      rawPayload: { provider: 'toyyibpay', callback: b },
    });
    return res.status(200).json({ ok: true, outcome });
  } catch (err) {
    console.error('[webhook/toyyibpay] gagal:', err.message);
    return res.status(200).json({ ok: false, error: 'INTERNAL' }); // never retry-storm
  }
}

router.get('/pay/:token', checkoutPage);
router.get('/pay/:token/plan/:planId', createOrderAndRedirect);
router.get('/pay/:token/status/:ref', orderStatusForPage);
router.get('/pay/:token/done', donePage);
router.post('/api/webhook/toyyibpay', express.urlencoded({ extended: false, limit: '64kb' }), toyyibpayWebhook);

module.exports = { router, renderExpiredPage, PAGE_STRINGS, formatPrice };
