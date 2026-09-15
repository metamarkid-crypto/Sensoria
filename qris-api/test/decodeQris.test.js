'use strict';

/**
 * decodeQris.test.js — direct unit tests for the server-side QR decoder.
 * Covers both container formats (PNG via pngjs, JPEG via jpeg-js) and every
 * guard-rail error code the route maps to 400s.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const { decodeQrImage, DEFAULT_MAX_BYTES } = require('../src/decodeQris');

const PAYLOAD =
  '00020101021126610014ID.CO.QRIS.WWW0118A01B02C03D04E05F0652045812530336' +
  '05802ID5915Warung Sensoria6007Jakarta6304ABCD';

async function pngOf(text) {
  return QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 2, scale: 6 });
}

test('decodes a PNG QR back to the exact payload', async () => {
  const png = await pngOf(PAYLOAD);
  assert.equal(decodeQrImage(png), PAYLOAD);
});

test('decodes a JPEG QR back to the exact payload (jpeg-js path)', async () => {
  const png = await pngOf(PAYLOAD);
  const rgba = PNG.sync.read(png);
  const jpg = jpeg.encode({ data: rgba.data, width: rgba.width, height: rgba.height }, 90);
  assert.equal(decodeQrImage(jpg.data), PAYLOAD);
});

test('non-QR image → DECODE_FAILED', () => {
  const png = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < png.data.length; i++) png.data[i] = 255;
  assert.throws(() => decodeQrImage(PNG.sync.write(png)), (e) => e.code === 'DECODE_FAILED');
});

test('unsupported container → UNSUPPORTED_TYPE (magic bytes, not headers)', () => {
  const gif = Buffer.from('GIF89a' + 'x'.repeat(64));
  assert.throws(() => decodeQrImage(gif), (e) => e.code === 'UNSUPPORTED_TYPE');
});

test('oversized input → IMAGE_TOO_LARGE; empty input → IMAGE_CORRUPT', () => {
  assert.throws(
    () => decodeQrImage(Buffer.alloc(DEFAULT_MAX_BYTES + 1, 0x89)),
    (e) => e.code === 'IMAGE_TOO_LARGE',
  );
  assert.throws(() => decodeQrImage(Buffer.alloc(0)), (e) => e.code === 'IMAGE_CORRUPT');
  // Corrupt PNG magic → IMAGE_CORRUPT from the decoder itself.
  assert.throws(
    () => decodeQrImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)])),
    (e) => e.code === 'IMAGE_CORRUPT',
  );
});
