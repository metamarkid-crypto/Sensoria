'use strict';

/**
 * routes/web.js — BROWSER-facing checkout (no HMAC: the APK secret can never
 * reach a web page). Authority comes from the signed checkout TOKEN the app
 * obtained via POST /api/checkout-session.
 *
 *   GET  /pay/:token            → checkout page (plan list + provider select)
 *   GET  /pay/:token/plan/:planId?provider=toyyibpay|qris-gobiz
 *                               → creates the order server-side, redirects to
 *                                 the provider (toyyibPay bill) or shows the
 *                                 dynamic QRIS (ID) with a status poll
 *   GET  /pay/:token/status/:ref → JSON order status for the page's poller
 *   POST /api/webhook/toyyibpay → gateway callback (MD5-hash verified)
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
 * The page is intentionally dependency-free inline HTML (no view engine) —
 * it must render even when node_modules is minimal and load fast on mobile
 * data in both ID and MY.
 */

const express = require('express');
const QRCode = require('qrcode');
const { verifyCheckoutToken } = require('../checkoutToken');
const providers = require('../providers');
const toyyibpay = require('../toyyibpay');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Minimal HTML escaping for every interpolated value. */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Locale strings for the checkout page (id/en/zh/ms — matches the app). */
const PAGE_STRINGS = {
  id: {
    title: 'Sensoria Premium — Checkout',
    subtitle: 'Pilih paket langganan Combo (1 Anak + semua Orang Tua terhubung).',
    month: 'Bulan',
    months: 'Bulan',
    perMonth: '/bln',
    payWith: 'Bayar dengan',
    region: 'Wilayah',
    regionID: 'Indonesia (QRIS)',
    regionMY: 'Malaysia (DuitNow QR / FPX / Kad)',
    choose: 'Bayar Sekarang',
    secure: 'Pembayaran diproses oleh penyedia pembayaran resmi. Sensoria tidak menyimpan data kartu Anda.',
    loading: 'Memproses…',
    errorGeneric: 'Terjadi kesalahan. Silakan coba lagi.',
    orderRef: 'Ref',
    scanQris: 'Scan QRIS ini dengan aplikasi bank / e-wallet Anda',
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
    payWith: 'Pay with',
    region: 'Region',
    regionID: 'Indonesia (QRIS)',
    regionMY: 'Malaysia (DuitNow QR / FPX / Card)',
    choose: 'Pay Now',
    secure: 'Payment is processed by official payment providers. Sensoria never stores your card data.',
    loading: 'Processing…',
    errorGeneric: 'Something went wrong. Please try again.',
    orderRef: 'Ref',
    scanQris: 'Scan this QRIS code with your bank / e-wallet app',
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
    payWith: '支付方式',
    region: '地区',
    regionID: '印度尼西亚（QRIS）',
    regionMY: '马来西亚（DuitNow QR / FPX / 银行卡）',
    choose: '立即支付',
    secure: '支付由官方支付服务商处理。Sensoria 不会存储您的银行卡信息。',
    loading: '处理中…',
    errorGeneric: '发生错误，请重试。',
    orderRef: '编号',
    scanQris: '使用您的银行 / 电子钱包应用扫描此 QRIS 码',
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
    payWith: 'Bayar dengan',
    region: 'Wilayah',
    regionID: 'Indonesia (QRIS)',
    regionMY: 'Malaysia (DuitNow QR / FPX / Kad)',
    choose: 'Bayar Sekarang',
    secure: 'Pembayaran diproses oleh penyedia pembayaran rasmi. Sensoria tidak menyimpan data kad anda.',
    loading: 'Memproses…',
    errorGeneric: 'Masalah berlaku. Sila cuba lagi.',
    orderRef: 'Rujukan',
    scanQris: 'Imbas kod QRIS ini dengan aplikasi bank / e-dompet anda',
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
  const s = PAGE_STRINGS[lang] || PAGE_STRINGS.en;
  return `<!DOCTYPE html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #F8FAFC; color: #1E293B; min-height: 100vh; }
  .wrap { max-width: 460px; margin: 0 auto; padding: 24px 16px 48px; }
  .logo { font-size: 20px; font-weight: 900; color: #11427B; margin-bottom: 2px; }
  .sub { font-size: 13px; color: #64748B; margin-bottom: 18px; line-height: 1.45; }
  .card { background: #FFF; border-radius: 16px; padding: 16px; margin-bottom: 12px;
          box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
  .plan { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .plan-name { font-size: 15px; font-weight: 800; }
  .plan-desc { font-size: 12px; color: #94A3B8; margin-top: 2px; }
  .plan-price { text-align: right; }
  .price { font-size: 17px; font-weight: 900; color: #11427B; }
  .permo { font-size: 11px; color: #94A3B8; }
  .btn { display: block; width: 100%; border: 0; border-radius: 12px; padding: 14px;
         font-size: 15px; font-weight: 800; color: #FFF; background: #00B5B8;
         margin-top: 14px; cursor: pointer; }
  .btn:active { opacity: 0.85; }
  .region { font-size: 12px; color: #64748B; margin: 14px 0 6px; font-weight: 700; }
  .radio-row { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
               background: #FFF; border-radius: 12px; margin-bottom: 8px;
               box-shadow: 0 2px 6px rgba(0,0,0,0.06); cursor: pointer; }
  .note { font-size: 11px; color: #94A3B8; text-align: center; line-height: 1.5; margin-top: 14px; }
  .qr-img { width: 240px; height: 240px; display: block; margin: 12px auto; }
  .center { text-align: center; }
  .ok { color: #059669; font-weight: 900; font-size: 18px; }
  .ref { font-size: 11px; color: #94A3B8; margin-top: 6px; }
  .err { background: #FFF0F5; color: #BE185D; border-radius: 12px; padding: 12px;
         font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body><div class="wrap">${bodyHtml}</div></body>
</html>`;
}

function renderExpiredPage(lang) {
  const s = PAGE_STRINGS[lang] || PAGE_STRINGS.en;
  return pageShell(
    lang,
    s.expired,
    `<div class="card center"><div style="font-size:34px;margin-bottom:8px">⏳</div>
     <div class="plan-name">${esc(s.expired)}</div>
     <div class="sub" style="margin-top:6px">${esc(s.expiredDesc)}</div></div>`,
  );
}

/** GET /pay/:token — plan list + region/provider choice. */
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

    const region = String(req.query.region || 'ID').toUpperCase() === 'MY' ? 'MY' : 'ID';
    const currency = region === 'MY' ? 'MYR' : 'IDR';
    const plans = await providers.listPlansForCurrency(db, currency);
    const provider = providers.resolveProvider(region);

    const planCards = plans
      .map((p) => {
        const perMonth = Math.round(Number(p.price) / Math.max(1, p.duration_months));
        const monthsLabel = p.duration_months > 1 ? s.months : s.month;
        return `<div class="card plan">
          <div>
            <div class="plan-name">${esc(p.name)}</div>
            <div class="plan-desc">${esc(p.duration_months)} ${esc(monthsLabel)}${p.description ? ' — ' + esc(p.description) : ''}</div>
          </div>
          <div class="plan-price">
            <div class="price">${esc(formatPrice(p.price, p.currency))}</div>
            <div class="permo">${esc(formatPrice(perMonth, p.currency))}${esc(s.perMonth)}</div>
          </div>
        </div>
        <form method="get" action="/pay/${encodeURIComponent(token)}/plan/${encodeURIComponent(p.id)}">
          <input type="hidden" name="provider" value="${esc(provider.id)}">
          <button class="btn" type="submit">${esc(s.choose)} — ${esc(formatPrice(p.price, p.currency))}</button>
        </form>`;
      })
      .join('');

    const regionSwitch =
      region === 'ID'
        ? `<a class="btn" style="background:#E2E8F0;color:#334155;text-decoration:none;text-align:center" href="/pay/${encodeURIComponent(token)}?region=MY">${esc(s.regionMY)} →</a>`
        : `<a class="btn" style="background:#E2E8F0;color:#334155;text-decoration:none;text-align:center" href="/pay/${encodeURIComponent(token)}?region=ID">${esc(s.regionID)} →</a>`;

    const body = `
      <div class="logo">Sensoria Premium</div>
      <div class="sub">${esc(s.subtitle)}</div>
      ${plans.length === 0 ? `<div class="err">${esc(s.errorGeneric)}</div>` : ''}
      ${planCards}
      <div class="region">${esc(s.region)}</div>
      ${regionSwitch}
      <div class="note">${esc(s.secure)}</div>`;
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

    const expiresAt = store.orderExpiresAt();
    const { order, qrString } = await providers.createOrderForProvider(store, db, {
      provider,
      device,
      plan,
      expiresAt,
    });

    if (qrString) {
      // ID path: render the dynamic QRIS + a status poller.
      const dataUrl = await QRCode.toBuffer(qrString, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
      const body = `
        <div class="card center">
          <div class="plan-name">QRIS</div>
          <img class="qr-img" src="data:image/png;base64,${dataUrl.toString('base64')}" alt="QRIS">
          <div class="sub">${esc(s.scanQris)}</div>
          <div id="st" class="sub">${esc(s.waiting)}</div>
          <div class="ref">${esc(s.orderRef)}: ${esc(order.transaction_ref)}</div>
        </div>
        <script>
          (function poll() {
            fetch('/pay/${encodeURIComponent(token)}/status/${encodeURIComponent(order.transaction_ref)}')
              .then(function (r) { return r.json(); })
              .then(function (j) {
                if (j.status === 'paid') {
                  document.getElementById('st').innerHTML = '<span class="ok">✓ ${esc(s.paid)}</span>';
                  setTimeout(function () { location.href = '/pay/${encodeURIComponent(token)}/done'; }, 1800);
                  return;
                }
                if (j.status === 'expired' || j.status === 'failed') { location.reload(); return; }
                setTimeout(poll, 4000);
              })
              .catch(function () { setTimeout(poll, 6000); });
          })();
        </script>`;
      return res.send(pageShell(lang, 'QRIS', body));
    }

    // MY path: hand off to the gateway's hosted bill page (FPX / card / DuitNow QR).
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
    const store = req.app.get('store');
    const db = store.db;
    const order = await store.getOrderByRef(db, ref);
    if (!order || order.child_device_id !== payload.d) {
      return res.status(404).json({ error: 'ORDER_NOT_FOUND' });
    }
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
  return res.send(
    pageShell(
      lang,
      s.paid,
      `<div class="card center"><div style="font-size:36px;margin-bottom:8px">🎉</div>
       <div class="ok">${esc(s.paid)}</div>
       <div class="sub" style="margin-top:6px">${esc(s.paidDesc)}</div></div>`,
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
