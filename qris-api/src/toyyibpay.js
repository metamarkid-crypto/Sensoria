'use strict';

/**
 * toyyibpay.js — client for toyyibPay (Malaysian payment gateway).
 *
 * WHY toyyibPay: one account covers the channels Sensoria needs in Malaysia —
 * FPX (online banking), credit/debit card, and DuitNow QR (enableDuitNowQR=1)
 * — with server-side callbacks + a transactions API for AUTO settlement
 * (static DuitNow QR alone cannot be auto-detected).
 *
 * API facts (https://toyyibpay.com/apireference/):
 *   • All calls POST x-www-form-urlencoded to {base}/index.php/api/<method>.
 *   • createBill responds HTTP 200 for SUCCESS *and* FAILURE — the body is
 *     [ { BillCode } ] on success, { status:'error', msg } (JSON) or a
 *     plain-text code ([KEY-DID-NOT-EXIST]…) on failure. ALWAYS inspect body.
 *   • Amounts are in SEN (100 = RM1.00).
 *   • billName: max 30 chars, alphanumeric + space + '_' only.
 *   • Callback (POST): refno, status (1=success, 2=pending, 3=fail), reason,
 *     billcode, order_id, amount, transaction_time,
 *     hash = MD5(userSecretKey + status + order_id + refno + 'ok').
 *   • getBillTransactions: billpaymentStatus 1=success, 2/4=pending, 3=fail.
 *
 * Sandbox: set TOYYIBPAY_BASE_URL=https://dev.toyyibpay.com (same endpoints).
 */

const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://toyyibpay.com';

/** billName/description charset: alphanumeric + space + '_' only, length-capped. */
function sanitizeBillText(raw, maxLen) {
  const cleaned = String(raw || '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLen) || 'Sensoria';
}

function formEncode(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** Parse ANY createBill/getBillTransactions response into { ok, code|body }. */
function parseGatewayResponse(text, what) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error(`toyyibpay ${what}: respons kosong.`);
  try {
    return JSON.parse(trimmed);
  } catch {
    // Plain-text failure codes ([KEY-DID-NOT-EXIST], [FALSE], …).
    throw new Error(`toyyibpay ${what}: ${trimmed.slice(0, 120)}`);
  }
}

/**
 * Create a bill. Resolves { billCode, payUrl } or throws Error('TOYYIBPAY:<msg>').
 * @param {object} p
 * @param {string} p.secretKey   userSecretKey from the toyyibPay dashboard.
 * @param {string} p.categoryCode
 * @param {number} p.amountCents  integer ≥ 1 (100 = RM1.00).
 * @param {string} p.externalRef  billExternalReferenceNo — we send transaction_ref.
 * @param {string} p.billName
 * @param {string} p.description
 * @param {string} p.payerName
 * @param {string} p.payerEmail   REQUIRED by toyyibPay when billPayorInfo=1.
 * @param {string} p.payerPhone
 * @param {string} p.returnUrl    browser redirect after payment.
 * @param {string} p.callbackUrl  server-to-server payment notification.
 * @param {Date}   p.expiresAt    bill goes inactive shortly BEFORE the order expires.
 * @param {boolean} [p.duitNow]   enable DuitNow QR channel (default true).
 * @param {string} [p.baseUrl]
 */
async function createBill(p) {
  const base = (p.baseUrl || process.env.TOYYIBPAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const expires = p.expiresAt instanceof Date ? p.expiresAt : new Date(Date.now() + 15 * 60 * 1000);
  // 'DD-MM-YYYY HH:mm:ss' (toyyibPay's own sample format).
  const pad = (n) => String(n).padStart(2, '0');
  const expiryStr =
    `${pad(expires.getDate())}-${pad(expires.getMonth() + 1)}-${expires.getFullYear()} ` +
    `${pad(expires.getHours())}:${pad(expires.getMinutes())}:${pad(expires.getSeconds())}`;

  const fields = {
    userSecretKey: p.secretKey,
    categoryCode: p.categoryCode,
    billName: sanitizeBillText(p.billName, 30),
    billDescription: sanitizeBillText(p.description, 100),
    billPriceSetting: '1', // fixed amount
    billPayorInfo: '1',
    billAmount: String(Math.round(p.amountCents)),
    billReturnUrl: p.returnUrl,
    billCallbackUrl: p.callbackUrl,
    billExternalReferenceNo: p.externalRef,
    billTo: sanitizeBillText(p.payerName, 60) || 'Sensoria Parent',
    billEmail: p.payerEmail || 'parent@aacsensoria.id',
    billPhone: p.payerPhone || '0123456789',
    billPaymentChannel: '2', // 0=FPX only, 1=card only, 2=both
    billExpiryDate: expiryStr,
  };
  if (p.duitNow !== false) {
    fields.enableDuitNowQR = '1'; // PayNet DuitNow QR channel (needs account activation)
    fields.chargeDuitNowQR = '0'; // charge on bill owner
  }

  let res;
  try {
    res = await fetch(`${base}/index.php/api/createBill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formEncode(fields),
    });
  } catch (e) {
    throw new Error(`TOYYIBPAY_UNREACHABLE: ${e.message}`);
  }
  const body = parseGatewayResponse(await res.text(), 'createBill');

  // Success shape: [{ BillCode: '…' }]. Failure shapes: {status:'error',msg} /
  // plain-text (already thrown). HTTP is always 200 — body is the truth.
  const code = Array.isArray(body) && body[0] && typeof body[0].BillCode === 'string' ? body[0].BillCode : null;
  if (!code) {
    const msg = body && body.msg ? body.msg : JSON.stringify(body).slice(0, 120);
    throw new Error(`TOYYIBPAY_CREATE_FAILED: ${msg}`);
  }
  return { billCode: code, payUrl: `${base}/${code}` };
}

/**
 * Fetch transactions for one bill. Resolves an array of
 * { billpaymentStatus: 1|2|3|4, billpaymentAmount, billpaymentInvoiceNo,
 *   billpaymentChannel, billPaymentDate, billExternalReferenceNo }.
 * Network/API hiccups THROW — callers decide policy (status endpoints must
 * swallow; settlement paths may retry).
 */
async function getBillTransactions(p) {
  const base = (p.baseUrl || process.env.TOYYIBPAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fields = {
    userSecretKey: p.secretKey,
    billCode: p.billCode,
  };
  if (p.billpaymentStatus !== undefined) fields.billpaymentStatus = String(p.billpaymentStatus);

  const res = await fetch(`${base}/index.php/api/getBillTransactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formEncode(fields),
  });
  const body = parseGatewayResponse(await res.text(), 'getBillTransactions');
  if (!Array.isArray(body)) {
    throw new Error(`TOYYIBPAY_TX_FAILED: ${JSON.stringify(body).slice(0, 120)}`);
  }
  return body;
}

/** True when any transaction on the bill reports billpaymentStatus === 1. */
function findPaidTransaction(txs) {
  if (!Array.isArray(txs)) return null;
  return txs.find((t) => t && String(t.billpaymentStatus) === '1') || null;
}

/**
 * Verify a callback hash: MD5(userSecretKey + status + order_id + refno + 'ok').
 * Constant-time compare. status/order_id/refno must be the EXACT strings
 * toyyibPay sent (their formula concatenates raw values).
 */
function verifyCallbackHash(p) {
  const { secretKey, status, orderId, refno, hash } = p;
  if (!hash || typeof hash !== 'string') return false;
  const expected = crypto
    .createHash('md5')
    .update(`${secretKey}${status}${orderId}${refno}ok`)
    .digest('hex');
  const a = Buffer.from(String(hash).toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  DEFAULT_BASE_URL,
  createBill,
  getBillTransactions,
  findPaidTransaction,
  verifyCallbackHash,
  sanitizeBillText,
};
