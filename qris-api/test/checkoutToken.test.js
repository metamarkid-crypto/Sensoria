'use strict';

/**
 * checkoutToken.test.js — signed browser-checkout session tokens.
 * Covers: mint/verify round-trip, tamper detection (payload byte, sig length),
 * wrong secret, expiry, lang fallback, garbage inputs.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.PAY_CHECKOUT_TOKEN_SECRET = 'test-token-secret';
const { createCheckoutToken, verifyCheckoutToken } = require('../src/checkoutToken');

const UUID = '11111111-2222-4333-8444-555555555555';

test('create → verify round-trip binds device, lang and expiry', () => {
  const { token, expiresAt } = createCheckoutToken(UUID, 'ms', { now: 1_700_000_000, ttlSeconds: 600 });
  const payload = verifyCheckoutToken(token, { now: 1_700_000_500 });
  assert.ok(payload, 'token should verify');
  assert.equal(payload.d, UUID);
  assert.equal(payload.l, 'ms');
  assert.equal(payload.exp, 1_700_000_600);
  assert.equal(new Date(expiresAt).getTime(), 1_700_000_600 * 1000);
});

test('unknown lang falls back to id at mint', () => {
  const { token } = createCheckoutToken(UUID, 'xx');
  const payload = verifyCheckoutToken(token);
  assert.equal(payload.l, 'id');
});

test('tampered payload bytes break the signature', () => {
  const { token } = createCheckoutToken(UUID, 'id');
  const [payloadB64, sig] = token.split('.');
  // Flip one character of the payload (swap first two base64url chars).
  const flipped = (payloadB64[1] === 'A' ? 'B' : 'A') + payloadB64.slice(1);
  assert.equal(verifyCheckoutToken(`${flipped}.${sig}`), null);
});

test('expired tokens verify to null', () => {
  const { token } = createCheckoutToken(UUID, 'id', { now: 1_000, ttlSeconds: 10 });
  assert.equal(verifyCheckoutToken(token, { now: 1_011 }), null);
  assert.ok(verifyCheckoutToken(token, { now: 1_010 }));
});

test('wrong secret fails verification', () => {
  const { token } = createCheckoutToken(UUID, 'id', { secret: 'secret-A' });
  assert.equal(verifyCheckoutToken(token, { secret: 'secret-B' }), null);
});

test('garbage inputs never throw', () => {
  assert.equal(verifyCheckoutToken(''), null);
  assert.equal(verifyCheckoutToken('no-dot-here'), null);
  assert.equal(verifyCheckoutToken('abc.ZZnothex'), null);
  assert.equal(verifyCheckoutToken(null), null);
  assert.equal(verifyCheckoutToken(42), null);
  assert.equal(verifyCheckoutToken('aGVsbG8.' + 'a'.repeat(64)), null); // unsigned junk
});
