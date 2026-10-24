#!/usr/bin/env node
/**
 * verify-push-payload.mjs — menguji pembaca payload push headless.
 *
 * `src/services/notifications/pushPayload.ts` sengaja PURE supaya bentuk
 * payload dari FCM (semua nilai STRING) bisa diuji tanpa device:
 *   node scripts/verify-push-payload.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'services', 'notifications', 'pushPayload.ts');

const { outputText } = ts.transpileModule(readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});
const mod = { exports: {} };
new Function('exports', 'module', outputText)(mod.exports, mod);
const { parseMessagePushData, pushDedupeKey } = mod.exports;

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` → got ${a}, want ${e}`}`);
};

const data = {
  kind: 'message',
  channelId: '123456',
  messageTs: '1750000000000',
  senderName: 'Ayah',
  text: 'Ayo makan',
  voiceRole: 'Ayah',
  language: 'id',
  childReceiver: 'true',
  speak: 'true',
};

// 1 — Android headless: nilai datang sebagai string dari FCM.
check('android task payload', parseMessagePushData({ notification: { data } }), {
  kind: 'message',
  channelId: '123456',
  messageTs: 1750000000000,
  senderName: 'Ayah',
  text: 'Ayo makan',
  voiceRole: 'Ayah',
  language: 'id',
  childReceiver: true,
  speak: true,
});

// 2 — listener foreground: data di root.
check('foreground data map', parseMessagePushData({ data: { ...data, childReceiver: false } }).childReceiver, false);

// 3 — iOS: dataString berisi JSON.
check(
  'ios dataString',
  parseMessagePushData({ data: { dataString: JSON.stringify({ ...data, language: 'en' }) } }).language,
  'en',
);

// 4 — bukan pesan: harus null (task tidak boleh bersuara).
check('non-message ignored', parseMessagePushData({ notification: { data: { kind: 'other' } } }), null);
check('garbage ignored', parseMessagePushData('nope'), null);
check('no channel ignored', parseMessagePushData({ data: { kind: 'message' } }), null);

// 5 — bahasa tak dikenal → id (tidak pernah crash di playTTS).
check('unknown language falls back to id', parseMessagePushData({ data: { ...data, language: 'fr' } }).language, 'id');

// 6 — speak absen → TIDAK bersuara (default aman).
check('missing speak means silent', parseMessagePushData({ data: { ...data, speak: undefined } }).speak, false);

// 7 — dedupe key stabil antara jalur push dan Realtime.
check('dedupe key', pushDedupeKey('123456', 1750000000000), '123456:1750000000000');

console.log(failures === 0 ? '\nOK — semua payload lolos' : `\n${failures} gagal`);
process.exit(failures === 0 ? 0 : 1);
