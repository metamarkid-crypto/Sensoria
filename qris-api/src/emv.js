'use strict';

/**
 * emv.js — EMVCo QRIS payload toolkit for the Sensoria QRIS API.
 *
 * Ported from go-merchant/src/services/goMerchant.service.js (convertCRC16 +
 * createDynamicQRIS) and hardened into a full TLV parser/builder.
 *
 * Why full TLV instead of the original string tricks:
 *   • The original `slice/replace/split("5802ID")` transform breaks on
 *     payloads whose merchant name/address contains "5802ID" or that already
 *     carry a tag 54 (dynamic), and it cannot VALIDATE a payload at all.
 *   • TLV parsing is deterministic: every field is `tag(2) + len(2) + value`,
 *     so we can rebuild the exact payload with only the tags we intend to
 *     change — mode (tag 01), amount (tag 54) — and recompute the CRC16.
 *
 * EMVCo background (merchant-presented QR):
 *   Tag 00 = Payload Format Indicator ("01")
 *   Tag 01 = Point of Initiation Method: "11" static (reusable), "12" dynamic
 *   Tag 26–51 = merchant account info (GoPay/QRIS: ID.CO.QRIS.WWW + PAN +
 *               merchant criteria + terminal label …)
 *   Tag 52 = MCC, Tag 53 = currency ("360" = IDR), Tag 54 = transaction amount
 *   Tag 58 = country ("ID"), Tag 59/60 = merchant name/city,
 *   Tag 63 = CRC16-CCITT (FALSE) over everything before it, including "6304".
 */

/** CRC16-CCITT (poly 0x1021, init 0xFFFF) — the EMVCo/QRIS checksum. */
function crc16(str) {
  let crc = 0xffff;
  for (let c = 0; c < str.length; c++) {
    crc ^= str.charCodeAt(c) << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    }
  }
  return ('000' + (crc & 0xffff).toString(16).toUpperCase()).slice(-4);
}

/**
 * Parse a TLV string into an ordered list of { tag, length, value }.
 * Lengths are decimal, two digits, as per EMVCo.
 */
function parseTLV(payload) {
  if (typeof payload !== 'string') throw new Error('Payload must be a string');
  const out = [];
  let i = 0;
  while (i < payload.length) {
    if (i + 4 > payload.length) throw new Error(`Truncated tag at offset ${i}`);
    const tag = payload.slice(i, i + 2);
    if (!/^[0-9A-Z]{2}$/.test(tag)) throw new Error(`Invalid tag "${tag}" at offset ${i}`);
    const lenStr = payload.slice(i + 2, i + 4);
    const len = parseInt(lenStr, 10);
    if (Number.isNaN(len)) throw new Error(`Invalid length "${lenStr}" for tag ${tag}`);
    const valueStart = i + 4;
    if (valueStart + len > payload.length) {
      throw new Error(`Tag ${tag} declares ${len} chars but payload has ${payload.length - valueStart}`);
    }
    out.push({ tag, length: len, value: payload.slice(valueStart, valueStart + len) });
    i = valueStart + len;
  }
  return out;
}

/** Serialize ordered TLV entries back into a payload string (no CRC). */
function buildTLV(entries) {
  return entries.map((e) => `${e.tag}${String(e.value.length).padStart(2, '0')}${e.value}`).join('');
}

/**
 * Strip the trailing CRC16 (tag 63) from a payload, returning the body.
 * The CRC covers the body INCLUDING the leading "6304".
 *
 * Structurally walked (not lastIndexOf) so a "6304" inside a value — e.g.
 * tag 62 additional-data containing those chars — can never be mistaken for
 * the CRC tag: only a tag 63 with length 04 that ends EXACTLY at the payload
 * end is accepted.
 */
function stripCRC(payload) {
  let i = 0;
  while (i < payload.length) {
    const tag = payload.slice(i, i + 2);
    const len = parseInt(payload.slice(i + 2, i + 4), 10);
    if (Number.isNaN(len) || len < 0) {
      throw new Error(`Invalid length for tag "${tag}" at offset ${i}`);
    }
    if (tag === '63' && len === 4 && i + 8 === payload.length) {
      const body = payload.slice(0, i + 4); // includes the leading "6304"
      const given = payload.slice(i + 4);
      if (crc16(body) !== given.toUpperCase()) {
        throw new Error(`CRC mismatch: expected ${crc16(body)}, got ${given.toUpperCase()}`);
      }
      return body;
    }
    i += 4 + len;
    if (i > payload.length) throw new Error('Truncated payload — declared length overruns the string');
  }
  throw new Error('Missing CRC tag (6304)');
}

/**
 * Parse the TLV ENTRIES of a payload's body with the CRC tag removed.
 * stripCRC intentionally returns the body INCLUDING "6304" (the CRC covers
 * it), but tag 63 has no value to parse — so consumers that inspect or
 * mutate merchant fields go through this helper instead of raw parseTLV.
 */
function bodyEntries(payload) {
  const body = stripCRC(payload);
  return parseTLV(body.slice(0, -4));
}

/** Verify the trailing CRC16 of a payload. Returns true/false (never throws). */
function verifyCRC(payload) {
  try {
    stripCRC(payload);
    return true;
  } catch (e) {
    if (e.message.startsWith('CRC mismatch')) return false;
    throw e;
  }
}

/**
 * Transform a STATIC QRIS payload into a DYNAMIC one for a given amount.
 * Replaces the old slice/replace/split approach: parse → mutate → rebuild.
 *
 *   • tag 01 value "11" → "12" (point of initiation: single-use)
 *   • tag 54 (amount) removed wherever it sits, re-inserted before tag 58
 *     (country) — the EMVCo-recommended position
 *   • CRC16 recomputed over the new body
 *
 * Amount must be a positive integer rupiah value (IDR has no minor units in
 * QRIS practice; decimals would need tag 55/56 which GoPay does not honour).
 */
function staticToDynamic(staticPayload, amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('Amount must be a positive integer (rupiah)');
  }
  const entries = bodyEntries(staticPayload); // validates the source CRC too

  const mode = entries.find((e) => e.tag === '01');
  if (!mode || mode.value !== '11') {
    throw new Error('Payload is not a STATIC QRIS (tag 01 must be "11")');
  }

  const out = [];
  let amountInserted = false;
  for (const e of entries) {
    if (e.tag === '01') {
      out.push({ tag: '01', value: '12' });
      continue;
    }
    if (e.tag === '54') continue; // drop any existing amount
    if (e.tag === '58' && !amountInserted) {
      out.push({ tag: '54', value: String(amount) });
      amountInserted = true;
    }
    out.push({ tag: e.tag, value: e.value });
  }
  if (!amountInserted) throw new Error('Payload missing tag 58 (country code) — cannot place amount');

  const newBody = buildTLV(out);
  return newBody + '6304' + crc16(newBody + '6304');
}

/** Backwards-compatible alias matching go-merchant's method name. */
const createDynamicQRIS = (staticPayload, amount) => staticToDynamic(staticPayload, amount);

/**
 * Validate a candidate STATIC QRIS payload before storing it in qris_merchants.
 * Returns { ok: true, merchantPan, merchantName, city } or { ok: false, reason }.
 *
 * Rules enforced (mirrors the blueprint):
 *   • parses as TLV and the trailing CRC16 verifies
 *   • tag 01 = "11" (static) — dynamic/one-time QRs are rejected loudly
 *   • tag 00 = "01" (payload format indicator)
 *   • tag 52 (MCC) and tag 53 (currency) present
 *   • tag 58 = "ID"
 *   • tag 59 (merchant name) present and non-empty
 *   • a merchant PAN exists: tag 26 (or 51) value containing "ID.CO.QRIS"
 */
function validateStaticQRIS(payload) {
  try {
    if (typeof payload !== 'string' || payload.length < 30) {
      return { ok: false, reason: 'Payload terlalu pendek — bukan string QRIS.' };
    }
    // EMVCo charset: printable ASCII; `%` is an escape prefix (%XX for reserved
    // chars) so a bare `%` (or malformed escape) means the payload is not a
    // genuine QRIS string — e.g. a screenshot of some other QR content.
    if (/[\x00-\x1F\x7F]/.test(payload)) {
      return { ok: false, reason: 'Payload mengandung karakter kontrol yang tidak diizinkan.' };
    }
    if (/%(?![0-9A-Fa-f]{2})/.test(payload)) {
      return { ok: false, reason: 'Payload mengandung karakter "%" yang tidak di-escape (%XX).' };
    }
    const entries = bodyEntries(payload);
    const get = (tag) => entries.find((e) => e.tag === tag);

    const fmt = get('00');
    if (!fmt || fmt.value !== '01') {
      return { ok: false, reason: 'Tag 00 (Payload Format Indicator) hilang atau bukan "01".' };
    }
    const mode = get('01');
    if (!mode || mode.value !== '11') {
      return {
        ok: false,
        reason:
          'Ini QRIS DINAMIS (sekali pakai). Upload QRIS STATIS dari menu Gojek Merchant → QRIS Saya, bukan QR dari transaksi.',
      };
    }
    const mcc = get('52');
    if (!mcc || !/^\d{4}$/.test(mcc.value)) {
      return { ok: false, reason: 'Tag 52 (MCC) hilang atau tidak valid.' };
    }
    const cur = get('53');
    if (!cur || cur.value !== '360') {
      return { ok: false, reason: 'Tag 53 (mata uang) harus "360" (IDR).' };
    }
    const country = get('58');
    if (!country || country.value !== 'ID') {
      return { ok: false, reason: 'Tag 58 (negara) harus "ID".' };
    }
    const name = get('59');
    if (!name || !name.value.trim()) {
      return { ok: false, reason: 'Tag 59 (nama merchant) hilang.' };
    }
    const acct = entries.find(
      (e) => ['26', '27', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', '45', '46', '47', '48', '49', '50', '51'].includes(e.tag) &&
        e.value.includes('ID.CO.QRIS'),
    );
    if (!acct) {
      return { ok: false, reason: 'Informasi merchant QRIS (tag 26, ID.CO.QRIS) tidak ditemukan.' };
    }

    // Merchant PAN lives inside the account template as sub-TLVs:
    //   ID.CO.QRIS.WWW | subtag(2)="01" | len(2) | PAN(len chars) …
    let pan = null;
    const panIdx = acct.value.indexOf('ID.CO.QRIS.WWW');
    if (panIdx !== -1) {
      const rest = acct.value.slice(panIdx + 'ID.CO.QRIS.WWW'.length);
      const subLen = parseInt(rest.slice(2, 4), 10);
      if (!Number.isNaN(subLen) && rest.length >= 4 + subLen) {
        pan = rest.slice(4, 4 + subLen);
      }
    }

    return { ok: true, merchantPan: pan, merchantName: name.value, city: (get('60') || {}).value ?? null };
  } catch (e) {
    return { ok: false, reason: `Payload tidak dapat dibaca: ${e.message}` };
  }
}

module.exports = {
  crc16,
  parseTLV,
  buildTLV,
  stripCRC,
  bodyEntries,
  verifyCRC,
  staticToDynamic,
  createDynamicQRIS,
  validateStaticQRIS,
};
