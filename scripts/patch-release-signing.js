#!/usr/bin/env node
'use strict';
/**
 * patch-release-signing.js — wire the release buildType to the production
 * keystore provided via android/keystore.properties.
 *
 * WHY: Expo prebuild's template signs the RELEASE buildType with the DEBUG
 * keystore ("signingConfig signingConfigs.debug" inside release {}), which
 * Google Play rejects. Both CI pipelines (android-build.yml APK and
 * android-aab.yml AAB) run this script right after `expo prebuild` and after
 * android/keystore.properties + android/app/upload-keystore.keystore have
 * been written by the workflow.
 *
 * Strategy (idempotent, line-oriented — no cross-block regex):
 *   1. Prepend a keystore.properties loader before `android {` (script scope,
 *      so every nested closure can read it).
 *   2. Inject a balanced `signingConfigs { release { … } }` block right after
 *      `android {`. Gradle merges repeated signingConfigs blocks with the
 *      template's existing debug one, so this is valid.
 *   3. Switch ONLY the `signingConfig signingConfigs.debug` line inside
 *      buildTypes → release, tracked by brace depth (the template puts the
 *      debug buildType between buildTypes { and release {, which is exactly
 *      what breaks naive regexes).
 *   4. Self-verify the result and fail loudly on unexpected structure.
 *
 * Exit codes: 0 = patched (or already patched), 1 = structure unexpected.
 */
const fs = require('fs');
const path = require('path');

const GRADLE = path.join('android', 'app', 'build.gradle');
const PROPS = path.join('android', 'keystore.properties');

if (!fs.existsSync(PROPS)) {
  console.error('❌ android/keystore.properties tidak ditemukan — jalankan setelah step keystore setup.');
  process.exit(1);
}
if (!fs.existsSync(GRADLE)) {
  console.error('❌ android/app/build.gradle tidak ditemukan — prebuild belum jalan?');
  process.exit(1);
}

let g = fs.readFileSync(GRADLE, 'utf8');
let changed = false;

// ── 1) Properties loader (before `android {`, in script scope) ─────────────
if (!g.includes('keystorePropertiesFile')) {
  const loader = [
    '',
    '// Production signing — injected by CI (scripts/patch-release-signing.js).',
    'def keystoreProperties = new java.util.Properties()',
    'def keystorePropertiesFile = rootProject.file("keystore.properties")',
    'if (keystorePropertiesFile.exists()) {',
    '    keystoreProperties.load(new java.io.FileInputStream(keystorePropertiesFile))',
    '}',
    '',
  ].join('\n');
  if (!/android\s*\{/.test(g)) {
    console.error('❌ Blok "android {" tidak ditemukan di build.gradle.');
    process.exit(1);
  }
  g = g.replace(/android\s*\{/, loader + 'android {');
  changed = true;
}

// ── 2) signingConfigs.release (balanced block; Gradle merges with debug's) ─
// Marker: the storeFile mapping line only exists once the release config is
// defined (the dotted name `signingConfigs.release` appears only as a
// REFERENCE, which the template does not contain yet).
if (!g.includes("keystoreProperties['storeFile']")) {
  const sig = [
    'android {',
    '',
    '    signingConfigs {',
    '        release {',
    '            if (keystorePropertiesFile.exists()) {',
    "                storeFile file(keystoreProperties['storeFile'])",
    "                storePassword keystoreProperties['storePassword']",
    "                keyAlias keystoreProperties['keyAlias']",
    "                keyPassword keystoreProperties['keyPassword']",
    '            }',
    '        }',
    '    }',
    '',
  ].join('\n');
  if (!/android\s*\{/.test(g)) {
    console.error('❌ Blok "android {" hilang — tidak wajar.');
    process.exit(1);
  }
  g = g.replace(/android\s*\{/, sig);
  if (!g.includes("keystoreProperties['storeFile']")) {
    console.error('❌ Gagal menyisipkan signingConfigs.release.');
    process.exit(1);
  }
  changed = true;
}

// ── 3) Switch the release buildType's signingConfig (brace-depth tracking) ─
const lines = g.split('\n');
let depth = 0;
let btDepth = -1;  // nesting depth at which `buildTypes {` opened
let relDepth = -1; // nesting depth at which its `release {` opened
let releasePatched = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;

  if (btDepth === -1 && /^\s*buildTypes\s*\{/.test(line)) btDepth = depth;
  if (btDepth !== -1 && relDepth === -1 && btDepth !== -1 && depth === btDepth + 1 && /^\s*release\s*\{/.test(line)) relDepth = depth;

  if (relDepth !== -1 && /\bsigningConfig\s+signingConfigs\.debug\b/.test(line)) {
    lines[i] = line.replace(/signingConfig\s+signingConfigs\.debug/, 'signingConfig signingConfigs.release');
    releasePatched++;
  }

  depth += opens - closes;
  if (relDepth !== -1 && depth <= relDepth) relDepth = -1; // release block closed
  if (btDepth !== -1 && relDepth === -1 && depth <= btDepth) btDepth = -1; // buildTypes closed
}

if (releasePatched === 0 && !/\bsigningConfig\s+signingConfigs\.release\b/.test(g)) {
  console.error('❌ Tidak menemukan "signingConfig signingConfigs.debug" di dalam buildTypes.release.');
  console.error('   Struktur template berubah? Periksa android/app/build.gradle secara manual.');
  process.exit(1);
}

fs.writeFileSync(GRADLE, lines.join('\n'));

// ── 4) Self-verify: release buildType now references signingConfigs.release ─
const text = lines.join('\n');
const btIdx = text.search(/^\s*buildTypes\s*\{/m);
let ok = false;
if (btIdx !== -1) {
  const relIdx = text.indexOf('release {', btIdx);
  if (relIdx !== -1) {
    const after = text.slice(relIdx, relIdx + 400);
    ok = /signingConfig\s+signingConfigs\.release/.test(after);
  }
}
if (ok) {
  console.log(`✅ build.gradle dipatch: release → signingConfigs.release (keystore.properties), ${releasePatched} baris diganti${changed ? '' : ' (idempotent re-run)'}`);
  process.exit(0);
}
console.error('⚠️ Patch diterapkan tetapi verifikasi blok release tidak konklusif — periksa android/app/build.gradle');
process.exit(1);
