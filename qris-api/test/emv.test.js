'use strict';

/**
 * emv.test.js — unit tests for the QRIS EMV toolkit (node:test, zero deps).
 * Run: npm test  (from qris-api/)  →  node --test test/
 *
 * Fixtures are internally consistent TLV strings (every declared length
 * matches its value) so structural assertions are exact, and mutations are
 * either length-preserving (to hit the CRC path) or re-signed (to hit the
 * intended semantic branch).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  crc16,
  parseTLV,
  buildTLV,
  stripCRC,
  bodyEntries,
  verifyCRC,
  staticToDynamic,
  createDynamicQRIS,
  validateStaticQRIS,
} = require('../src/emv');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// tag-26 account template: 0014 + ID.CO.QRIS.WWW (14) + 0118 + PAN(18) +
// 0210 + 1234567890 + 0303 + UMI  = 61 chars exactly.
const ACCOUNT_TEMPLATE = '0014ID.CO.QRIS.WWW0118990009992901234567021012345678900303UMI';
const STATIC_BODY =
  '000201010211' + // 00=PFI 01, 01=static(11)
  '2661' + ACCOUNT_TEMPLATE +
  '52045412' +     // MCC (grocery) — required by the validator
  '54042000' +     // pre-existing amount "2000" (dropped on rebuild)
  '53033605802ID' + // currency IDR, country ID
  '5908SENSORIA6007JAKARTA'; // merchant name (8 chars → len 08) + city (7 → 07)

/** A canonical GoPay STATIC QRIS payload with a VALID trailing CRC16. */
const STATIC_QRIS_VALID = STATIC_BODY + '6304' + crc16(STATIC_BODY + '6304');

/** Same payload but with a tag-62 additional-data value containing "6304" —
 *  the decoy that fools lastIndexOf-based CRC strippers. */
const DECOY_BODY =
  STATIC_BODY.slice(0, STATIC_BODY.length - 0) // full body
    .replace('6007JAKARTA', '6007JAKARTA621305116304DECOY');
const DECOY_VALID = DECOY_BODY + '6304' + crc16(DECOY_BODY + '6304');

/** Re-sign a valid payload after REBUILDING a tag value (handles length
 *  changes correctly): parse body → set tag value → rebuild → re-CRC. */
const resign = (validPayload, mutateBody) => {
  const body = stripCRC(validPayload);
  const mutated = mutateBody(body);
  return mutated + crc16(mutated);
};

/** Replace the value of `tag` inside a valid payload with correct re-encoding
 *  (recomputes the tag length) and a fresh CRC. */
const setTagValue = (validPayload, tag, newValue) => {
  const entries = bodyEntries(validPayload).map((e) => (e.tag === tag ? { ...e, value: newValue } : e));
  const rebuilt = buildTLV(entries);
  return rebuilt + '6304' + crc16(rebuilt + '6304');
};

/** The original go-merchant convertCRC16 — the reference implementation. */
function referenceCrc16(str) {
  let crc = 0xffff;
  for (let c = 0; c < str.length; c++) {
    crc ^= str.charCodeAt(c) << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
      else crc = crc << 1;
    }
  }
  return ('000' + (crc & 0xffff).toString(16).toUpperCase()).slice(-4);
}

// ---------------------------------------------------------------------------
// crc16
// ---------------------------------------------------------------------------

test('crc16 is deterministic, hex, 4 chars, FFFF for empty input', () => {
  assert.equal(crc16(''), 'FFFF');
  assert.match(crc16('6304'), /^[0-9A-F]{4}$/);
  assert.equal(crc16('6304'), crc16('6304'));
});

test('crc16 matches the original go-merchant implementation byte-for-byte', () => {
  for (const s of [STATIC_BODY, DECOY_BODY, '000201', 'hello world', 'A']) {
    assert.equal(crc16(s), referenceCrc16(s), `mismatch for ${s}`);
  }
});

// ---------------------------------------------------------------------------
// TLV parse/build round-trip
// ---------------------------------------------------------------------------

test('parseTLV walks tag/length/value correctly', () => {
  const entries = parseTLV('0002010102115802ID');
  assert.deepEqual(
    entries.map((e) => [e.tag, e.value]),
    [
      ['00', '01'],
      ['01', '11'],
      ['58', 'ID'],
    ],
  );
});

test('parseTLV rejects truncated and malformed payloads', () => {
  // 3 chars: no room for a full tag+length header.
  assert.throws(() => parseTLV('000'), /Truncated tag at offset 0/);
  // '00' + len '30' + only '1234' left → declares 30 chars, payload has 4.
  assert.throws(() => parseTLV('00301234'), /Tag 00 declares 30 chars but payload has 4/);
  // lowercase 'x' is not a valid tag character.
  assert.throws(() => parseTLV('0x0201'), /Invalid tag/);
});

test('buildTLV(parseTLV(x)) === x for every fixture', () => {
  for (const p of [STATIC_QRIS_VALID, DECOY_VALID, '000201010211']) {
    assert.equal(buildTLV(parseTLV(p)), p);
  }
});

// ---------------------------------------------------------------------------
// stripCRC / verifyCRC
// ---------------------------------------------------------------------------

test('stripCRC returns the body including the leading 6304', () => {
  const body = stripCRC(STATIC_QRIS_VALID);
  assert.ok(body.endsWith('6304'));
  assert.equal(body + crc16(body), STATIC_QRIS_VALID);
});

test('stripCRC is NOT fooled by a 6304 decoy inside tag 62', () => {
  // A lastIndexOf implementation would treat "DECOY" as the CRC and fail.
  const body = stripCRC(DECOY_VALID);
  assert.ok(body.endsWith('6304'));
  assert.equal(body + crc16(body), DECOY_VALID);
});

test('verifyCRC: true on valid, false on stale CRC, true after re-sign', () => {
  assert.equal(verifyCRC(STATIC_QRIS_VALID), true);
  assert.equal(verifyCRC(DECOY_VALID), true);

  // Same-length tamper with a stale CRC → CRC path fires (no throw).
  const stale = STATIC_QRIS_VALID.replace('SENSORIA', 'SENSORIB');
  assert.equal(verifyCRC(stale), false);

  // Re-signing the tampered body makes it valid again — proves the CRC
  // actually covers content (and that tamper detection needs the CRC check).
  const resigned = resign(STATIC_QRIS_VALID, (b) => b.replace('SENSORIA', 'SENSORIB'));
  assert.equal(verifyCRC(resigned), true);
});

// ---------------------------------------------------------------------------
// staticToDynamic
// ---------------------------------------------------------------------------

test('staticToDynamic flips mode to 12 and inserts tag 54 before 58', () => {
  const dyn = staticToDynamic(STATIC_QRIS_VALID, 49000);
  const entries = bodyEntries(dyn);

  assert.equal(entries.find((e) => e.tag === '01').value, '12');
  const idx54 = entries.findIndex((e) => e.tag === '54');
  const idx58 = entries.findIndex((e) => e.tag === '58');
  assert.ok(idx54 !== -1, 'tag 54 inserted');
  assert.ok(idx58 !== -1);
  assert.ok(idx54 < idx58, 'tag 54 sits before tag 58');
  assert.equal(entries.find((e) => e.tag === '54').value, '49000');

  // Exactly ONE amount tag; original payload untouched.
  assert.equal(entries.filter((e) => e.tag === '54').length, 1);
  assert.equal(verifyCRC(dyn), true);
  // Merchant identity preserved verbatim:
  assert.equal(entries.find((e) => e.tag === '59').value, 'SENSORIA');
  assert.equal(entries.find((e) => e.tag === '26').value.length, 61);
});

test('staticToDynamic drops the pre-existing tag 54 (no duplicate amounts)', () => {
  const dyn = staticToDynamic(STATIC_QRIS_VALID, 49000);
  const amounts = bodyEntries(dyn).filter((e) => e.tag === '54');
  assert.equal(amounts.length, 1);
  assert.equal(amounts[0].value, '49000');
});

test('staticToDynamic preserves the 6304 decoy inside tag 62 and stays valid', () => {
  const dyn = staticToDynamic(DECOY_VALID, 25000);
  assert.ok(bodyEntries(dyn).find((e) => e.tag === '62').value.includes('6304'));
  assert.equal(verifyCRC(dyn), true);
});

test('staticToDynamic rejects dynamic payloads and bad amounts', () => {
  const dynValid = resign(STATIC_QRIS_VALID, (b) => b.replace('010211', '010212'));
  assert.throws(() => staticToDynamic(dynValid, 1000), /not a STATIC QRIS/);

  assert.throws(() => staticToDynamic(STATIC_QRIS_VALID, 0), /positive integer/);
  assert.throws(() => staticToDynamic(STATIC_QRIS_VALID, 49000.5), /positive integer/);
  assert.throws(() => staticToDynamic(STATIC_QRIS_VALID, -1), /positive integer/);
  assert.throws(() => staticToDynamic('garbage', 1000), /Invalid length|CRC/);
});

test('createDynamicQRIS alias behaves identically (go-merchant compat)', () => {
  assert.equal(createDynamicQRIS(STATIC_QRIS_VALID, 49000), staticToDynamic(STATIC_QRIS_VALID, 49000));
});

// ---------------------------------------------------------------------------
// validateStaticQRIS
// ---------------------------------------------------------------------------

test('validateStaticQRIS accepts the canonical static payload and extracts PAN', () => {
  const res = validateStaticQRIS(STATIC_QRIS_VALID);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.merchantPan, '990009992901234567');
  assert.equal(res.merchantName, 'SENSORIA');
  assert.equal(res.city, 'JAKARTA');
});

test('validateStaticQRIS rejects non-strings, short blobs, and tampered CRC', () => {
  assert.equal(validateStaticQRIS(null).ok, false);
  assert.equal(validateStaticQRIS(12345).ok, false);
  assert.equal(validateStaticQRIS('000201').ok, false);
  const res = validateStaticQRIS(STATIC_QRIS_VALID.replace('SENSORIA', 'SENSORIB'));
  assert.equal(res.ok, false);
  assert.match(res.reason, /CRC/);
});

test('validateStaticQRIS rejects DYNAMIC QR with a clear Indonesian message', () => {
  const dynValid = resign(STATIC_QRIS_VALID, (b) => b.replace('010211', '010212'));
  const res = validateStaticQRIS(dynValid);
  assert.equal(res.ok, false);
  assert.match(res.reason, /DINAMIS/);
});

test('validateStaticQRIS rejects wrong currency, missing name, foreign country', () => {
  const badCurrency = resign(STATIC_QRIS_VALID, (b) => b.replace('5303360', '5303840'));
  const resCur = validateStaticQRIS(badCurrency);
  assert.equal(resCur.ok, false);
  assert.match(resCur.reason, /mata uang/);

  const noName = setTagValue(STATIC_QRIS_VALID, '59', '');
  const resName = validateStaticQRIS(noName);
  assert.equal(resName.ok, false);
  assert.match(resName.reason, /nama merchant/);

  const noCountry = resign(STATIC_QRIS_VALID, (b) => b.replace('5802ID', '5802SG'));
  const resCountry = validateStaticQRIS(noCountry);
  assert.equal(resCountry.ok, false);
  assert.match(resCountry.reason, /negara/);
});

test('validateStaticQRIS rejects payloads without QRIS merchant account info', () => {
  const body = '000201010211520454125404200053033605802ID5908SENSORIA6007JAKARTA';
  const payload = body + '6304' + crc16(body + '6304');
  const res = validateStaticQRIS(payload);
  assert.equal(res.ok, false);
  assert.match(res.reason, /ID\.CO\.QRIS/);
});

test('validateStaticQRIS rejects control chars and malformed % escapes', () => {
  const withCtrl = setTagValue(STATIC_QRIS_VALID, '59', 'SENSO\u0001RIA');
  const resCtrl = validateStaticQRIS(withCtrl);
  assert.equal(resCtrl.ok, false);
  assert.match(resCtrl.reason, /kontrol/);

  const badEscape = setTagValue(STATIC_QRIS_VALID, '59', 'SENSO%ZZRIA');
  const resEsc = validateStaticQRIS(badEscape);
  assert.equal(resEsc.ok, false);
  assert.match(resEsc.reason, /escape/);
});

test('validateStaticQRIS accepts %XX-escaped characters per EMVCo', () => {
  const escaped = setTagValue(STATIC_QRIS_VALID, '59', 'SENSE%25RIA');
  const res = validateStaticQRIS(escaped);
  assert.equal(res.ok, true, res.reason);
});
