#!/usr/bin/env node
/**
 * verify-alert-policy.mjs — mengeksekusi aturan notifikasi pesan masuk.
 *
 * `src/services/notifications/alertPolicy.ts` sengaja PURE (tanpa React, tanpa
 * expo-notifications, tanpa store) supaya aturan produk bisa diuji di Node
 * biasa, tanpa menambah test runner.
 *
 * Usage: node scripts/verify-alert-policy.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'services', 'notifications', 'alertPolicy.ts');

const { planIncomingAlert } = (() => {
  const { outputText } = ts.transpileModule(readFileSync(SRC, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const mod = { exports: {} };
  new Function('exports', 'module', outputText)(mod.exports, mod);
  return mod.exports;
})();

let failures = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` → got ${a}, want ${e}`}`);
};

const base = { appActive: false, notificationsEnabled: true, childReceiver: false, visualRepliesEnabled: false };

// 1 — app TERBUKA: tanpa banner OS, suara tetap dari app
check('foreground: no OS banner, still speaks', planIncomingAlert({ ...base, appActive: true }), {
  showBanner: false,
  speak: true,
  reason: 'foreground',
});

// 2 — app di background: banner senyap + TTS
check('background: silent banner + TTS', planIncomingAlert(base), {
  showBanner: true,
  speak: true,
  reason: 'background',
});

// 3 — notifikasi dimatikan: banner tetap, suara bungkam (di foreground & background)
check('disabled (background): banner, no sound', planIncomingAlert({ ...base, notificationsEnabled: false }), {
  showBanner: true,
  speak: false,
  reason: 'disabled',
});
check('disabled (foreground): no banner, no sound', planIncomingAlert({ ...base, appActive: true, notificationsEnabled: false }), {
  showBanner: false,
  speak: false,
  reason: 'disabled',
});

// 4 — Balasan Visual hanya memblokir suara di perangkat ANAK
check('child + visual replies: silent', planIncomingAlert({ ...base, childReceiver: true, visualRepliesEnabled: true }), {
  showBanner: true,
  speak: false,
  reason: 'visual-reply',
});
check('parent + mirrored visual flag: still speaks', planIncomingAlert({ ...base, childReceiver: false, visualRepliesEnabled: true }), {
  showBanner: true,
  speak: true,
  reason: 'background',
});

console.log(failures === 0 ? '\nALL ALERT POLICY CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
