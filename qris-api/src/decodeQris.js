'use strict';

/**
 * decodeQris.js — server-side QR-image → EMV payload decoder.
 *
 * Port of go-merchant's browser pipeline (public/app_v6.js: FileReader →
 * canvas → jsQR), moved server-side (blueprint §2.1) so an admin can upload
 * the OFFICIAL static QRIS image ("Gojek Merchant → QRIS Saya") from any
 * device and the API extracts the original payload string:
 *
 *   PNG  → pngjs  (sync decode)
 *   JPEG → jpeg-js (sync decode)
 *   both → RGBA Uint8ClampedArray → jsQR → payload string
 *
 * Pure JS, zero native deps — runs on the aaPanel VPS as-is.
 *
 * What comes back is the RAW payload; callers MUST validate it with
 * emv.validateStaticQRIS before storing (screenshots of transaction QRs are
 * DYNAMIC payloads and get rejected with a clear Indonesian message).
 */

const jsQR = require('jsqr');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — official QRIS exports are ~10–50 KB

/**
 * Decode a QR code image into its payload string.
 *
 * @param {Buffer|Uint8Array} input  raw image bytes (PNG or JPEG)
 * @param {{ maxBytes?: number }} [opts]
 * @returns {string} the decoded payload
 * @throws {Error} with .code:
 *   IMAGE_TOO_LARGE  — input over the byte budget
 *   UNSUPPORTED_TYPE — not a PNG/JPEG (sniffed from magic bytes, not the
 *                      client-supplied filename/content-type)
 *   DECODE_FAILED    — image parsed but no QR code found
 *   IMAGE_CORRUPT    — decoder could not parse the container
 */
function decodeQrImage(input, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length === 0) {
    return fail('IMAGE_CORRUPT', 'Gambar kosong.');
  }
  if (buf.length > maxBytes) {
    return fail('IMAGE_TOO_LARGE', `Gambar terlalu besar (maks ${Math.floor(maxBytes / 1024)} KB).`);
  }

  // Magic-byte sniffing — never trust client headers/filenames.
  const isPng = buf.length > 8 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
  const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (!isPng && !isJpeg) {
    return fail('UNSUPPORTED_TYPE', 'Hanya gambar PNG atau JPEG yang didukung.');
  }

  let rgba;
  let width;
  let height;
  try {
    if (isPng) {
      const png = PNG.sync.read(buf);
      rgba = png.data;
      width = png.width;
      height = png.height;
    } else {
      const jpg = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
      rgba = jpg.data;
      width = jpg.width;
      height = jpg.height;
    }
  } catch (err) {
    return fail('IMAGE_CORRUPT', `Gambar tidak dapat dibaca: ${err.message}`);
  }

  // jsQR needs Uint8ClampedArray RGBA.
  const clamped = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  let result = null;
  try {
    result = jsQR(clamped, width, height);
  } catch (err) {
    return fail('DECODE_FAILED', `QR tidak dapat dibaca: ${err.message}`);
  }
  if (!result || !result.data) {
    return fail('DECODE_FAILED', 'Tidak ada QR code yang ditemukan di gambar. Gunakan gambar QRIS resmi (Gojek Merchant → QRIS Saya), bukan tangkapan layar buram.');
  }
  return result.data;
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

module.exports = { decodeQrImage, DEFAULT_MAX_BYTES };
