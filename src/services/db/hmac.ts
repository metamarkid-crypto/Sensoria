/**
 * hmac.ts — request signing for the Sensoria web backend (qris-api).
 *
 * WHY PURE TS (no expo-crypto / react-native-quick-crypto):
 *   • The dependency set of this app deliberately carries NO crypto SDK —
 *     the blueprint's "mobile stays SDK-free" rule extends to signing.
 *   • expo-crypto's digestStringAsync supports SHA-256 but not HMAC keys;
 *     building HMAC over raw digests needs manual ipad/opad handling and a
 *     block-size path that expo-crypto does not expose. A compact, audited
 *     implementation is simpler and Hermes-safe.
 *
 * WHAT: SHA-256 (FIPS 180-4) + HMAC-SHA256 (RFC 2104), then
 *
 *   X-Sensoria-Timestamp : unix seconds
 *   X-Sensoria-Sign      = HEX HMAC-SHA256(`${timestamp}.${rawBody}`, QRIS_API_SECRET)
 *
 * which is exactly what qris-api's src/hmac.js verifies (± skew window).
 *
 * SECURITY honesty (blueprint §4.5): the secret ships in the APK — this is a
 * SCANNER FILTER, not strong auth. Real security is server-side pricing and
 * ledger append-only writes; keep the secret in EXPO_PUBLIC_QRIS_API_SECRET.
 */

// ─── SHA-256 (FIPS 180-4) ───────────────────────────────────────────────────

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Bytes(str: string): Uint8Array {
  // TextEncoder exists in Hermes ≥ RN 0.72; keep a tiny fallback for safety.
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(str);
  }
  const out = new Uint8Array(str.length * 4);
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out[n++] = c;
    else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 63);
    } else if (c < 0x10000) {
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 63);
      out[n++] = 0x80 | (c & 63);
    } else {
      out[n++] = 0xf0 | (c >> 18);
      out[n++] = 0x80 | ((c >> 12) & 63);
      out[n++] = 0x80 | ((c >> 6) & 63);
      out[n++] = 0x80 | (c & 63);
    }
  }
  return out.subarray(0, n);
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Raw SHA-256 over bytes → 32-byte digest. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  // padded = data || 0x80 || zeros || 8-byte big-endian bit length
  const withPad = ((data.length + 9 + 63) & ~63);
  const buf = new Uint8Array(withPad);
  buf.set(data);
  buf[data.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(withPad - 4, bitLen >>> 0);
  dv.setUint32(withPad - 8, Math.floor(bitLen / 0x100000000));

  const w = new Uint32Array(64);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(off + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
  return out;
}

export function sha256Hex(input: string): string {
  const digest = sha256Bytes(utf8Bytes(input));
  let hex = "";
  for (let i = 0; i < digest.length; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex;
}

// ─── HMAC-SHA256 (RFC 2104) ────────────────────────────────────────────────

/** HMAC-SHA256(key, message) → hex digest. Both inputs are UTF-8 strings. */
export function hmacSha256Hex(key: string, message: string): string {
  let keyBytes = utf8Bytes(key);
  const BLOCK = 64;
  if (keyBytes.length > BLOCK) keyBytes = sha256Bytes(keyBytes);
  const padded = new Uint8Array(BLOCK);
  padded.set(keyBytes);

  const ipad = new Uint8Array(BLOCK);
  const opad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) {
    ipad[i] = padded[i] ^ 0x36;
    opad[i] = padded[i] ^ 0x5c;
  }
  const inner = sha256Bytes(concat(ipad, utf8Bytes(message)));
  const outer = sha256Bytes(concat(opad, inner));
  let hex = "";
  for (let i = 0; i < outer.length; i++) hex += outer[i].toString(16).padStart(2, "0");
  return hex;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ─── Signing + fetch plumbing ──────────────────────────────────────────────

export const QRIS_API_SECRET = process.env.EXPO_PUBLIC_QRIS_API_SECRET || "";

/**
 * The signature headers for `rawBody` at `timestamp` — exported so tests (and
 * any future native module swap) reuse the exact wire format.
 */
export function sensoriaSignatureHeaders(
  rawBody: string,
  secret: string = QRIS_API_SECRET,
  timestamp: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  if (!secret) throw new Error("QRIS_API_SECRET_MISSING");
  return {
    "X-Sensoria-Timestamp": String(timestamp),
    "X-Sensoria-Sign": hmacSha256Hex(secret, `${timestamp}.${rawBody}`),
  };
}

/** Stable error code for a missing/blank secret — callers map it to a toast. */
export const QRIS_API_SECRET_MISSING = "QRIS_API_SECRET_MISSING";
