#!/usr/bin/env node
/**
 * verify-core-logic.mjs — Pure unit test suite for Sensoria AAC core logic:
 *   1. Entitlement & Access Gate (`evaluateAccess`, `evaluateParentGate`, `computeRenewalPreview`)
 *   2. HMAC-SHA256 Signing (`sha256Hex`, `hmacSha256Hex`, `sensoriaSignatureHeaders`)
 *   3. Date, Time & Currency Formatting (`formatDate`, `toTimestampMs`, `formatRupiah`)
 *   4. Child Profile & Gender SSOT Normalization (`normalizeChildGender`, `buildChildProfileFromRow`)
 *   5. Parent Activity Analytics (`computeActivity`, `rangeStartMs`)
 *
 * Runs in plain Node without Metro or React Native dependencies.
 * Usage: node scripts/verify-core-logic.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadTsModule(relPath, mocks = {}) {
  const fullPath = join(ROOT, relPath);
  const source = readFileSync(fullPath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: fullPath,
  });
  const mod = { exports: {} };
  const customRequire = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`Unexpected require('${id}') in ${relPath}`);
  };
  new Function('exports', 'require', 'module', outputText)(mod.exports, customRequire, mod);
  return mod.exports;
}

let failures = 0;
let passed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name} → got ${a}, want ${e}`);
  } else {
    passed += 1;
    console.log(`PASS ${name}`);
  }
};

// ── 1. Format Utilities ──────────────────────────────────────────────────────
const formatMod = loadTsModule('src/utils/format.ts');
check('formatRupiah: 25000 → Rp25.000', formatMod.formatRupiah(25000), 'Rp25.000');
check('formatRupiah: 1500000 → Rp1.500.000', formatMod.formatRupiah(1500000), 'Rp1.500.000');
check('formatDate: valid ISO', formatMod.formatDate('2026-02-12T00:00:00.000Z').includes('Februari 2026'), true);
check('formatDate: null → empty', formatMod.formatDate(null), '');
check('toTimestampMs: PostgREST bigint string', formatMod.toTimestampMs('1750000000000'), 1750000000000);
check('toTimestampMs: number', formatMod.toTimestampMs(1750000000000), 1750000000000);
check('toTimestampMs: invalid → NaN', Number.isNaN(formatMod.toTimestampMs('not-a-date')), true);

// ── 2. Child Profile & Gender SSOT Helpers ──────────────────────────────────
const profileMod = loadTsModule('src/utils/childProfileHelpers.ts');
check('normalizeChildGender: lowercase girl', profileMod.normalizeChildGender('girl'), 'Girl');
check('normalizeChildGender: settings.childProfileGender', profileMod.normalizeChildGender(undefined, { childProfileGender: 'Girl' }), 'Girl');
check('normalizeChildGender: legacy settings.childVoiceGender', profileMod.normalizeChildGender(undefined, { childVoiceGender: 'girl' }), 'Girl');
check('normalizeChildGender: fallback Boy', profileMod.normalizeChildGender(undefined, {}), 'Boy');

const builtProfile = profileMod.buildChildProfileFromRow(
  { full_name: 'Siti Aminah', nickname: 'Siti', settings: { childVoiceGender: 'girl', speechRate: 1.2 } },
  null,
  'dev-123',
);
check('buildChildProfileFromRow: normalizes gender & dual name fields', {
  device_id: builtProfile.device_id,
  fullName: builtProfile.fullName,
  full_name: builtProfile.full_name,
  nickname: builtProfile.nickname,
  gender: builtProfile.gender,
  settingGender: builtProfile.settings.childProfileGender,
}, {
  device_id: 'dev-123',
  fullName: 'Siti Aminah',
  full_name: 'Siti Aminah',
  nickname: 'Siti',
  gender: 'Girl',
  settingGender: 'Girl',
});

// ── 3. HMAC-SHA256 Signing ───────────────────────────────────────────────────
const hmacMod = loadTsModule('src/services/db/hmac.ts');
// NIST SHA-256 test vector for "abc"
check(
  'sha256Hex: NIST "abc" vector',
  hmacMod.sha256Hex('abc'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
);
// RFC 4231 HMAC-SHA256 test case 2 ("Jefe", "what do ya want for nothing?")
check(
  'hmacSha256Hex: RFC 4231 test vector',
  hmacMod.hmacSha256Hex('Jefe', 'what do ya want for nothing?'),
  '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
);
const headers = hmacMod.sensoriaSignatureHeaders('{"device_id":"123"}', 'secret-key', 1700000000);
check('sensoriaSignatureHeaders: includes timestamp & sign', {
  ts: headers['X-Sensoria-Timestamp'],
  hasSign: typeof headers['X-Sensoria-Sign'] === 'string' && headers['X-Sensoria-Sign'].length === 64,
}, { ts: '1700000000', hasSign: true });

// ── 4. Entitlement & Compassionate Child / Strict Parent Gate ────────────────
const entitlementMod = loadTsModule('src/services/db/entitlement.ts', {
  './supabase': { supabase: {} },
});
const NOW = new Date('2026-09-10T12:00:00.000Z').getTime();
const FUTURE = new Date(NOW + 2 * 86400000).toISOString();
const PAST_1D = new Date(NOW - 1 * 86400000).toISOString();
const PAST_5D = new Date(NOW - 5 * 86400000).toISOString();

check(
  'evaluateAccess: future active → premium',
  entitlementMod.evaluateAccess(
    { loaded: true, status: 'active', trialEndsAt: null, expiresAt: FUTURE, childGracePeriodDays: 3 },
    'Parent',
    NOW,
  ).phase,
  'premium',
);
check(
  'evaluateAccess: expired 1d ago on Parent → locked immediately (zero grace)',
  entitlementMod.evaluateAccess(
    { loaded: true, status: 'active', trialEndsAt: null, expiresAt: PAST_1D, childGracePeriodDays: 3 },
    'Parent',
    NOW,
  ).phase,
  'locked',
);
check(
  'evaluateAccess: expired 1d ago on Child (3d grace) → grace phase',
  entitlementMod.evaluateAccess(
    { loaded: true, status: 'active', trialEndsAt: null, expiresAt: PAST_1D, childGracePeriodDays: 3 },
    'Child',
    NOW,
  ).phase,
  'grace',
);
check(
  'evaluateAccess: expired 5d ago on Child (3d grace) → locked phase',
  entitlementMod.evaluateAccess(
    { loaded: true, status: 'active', trialEndsAt: null, expiresAt: PAST_5D, childGracePeriodDays: 3 },
    'Child',
    NOW,
  ).phase,
  'locked',
);
check(
  'evaluateParentGate: fresh install unloaded → verifying',
  entitlementMod.evaluateParentGate({ loaded: false, status: null, trialEndsAt: null, expiresAt: null }, NOW),
  'verifying',
);
check(
  'computeRenewalPreview: active future subscription stacks',
  entitlementMod.computeRenewalPreview({ status: 'active', trialEndsAt: null, expiresAt: FUTURE }, 1, NOW).stacks,
  true,
);

// ── 5. Activity Analytics Engine ─────────────────────────────────────────────
const analyticsMod = loadTsModule('src/services/db/analytics.ts', {
  '../../utils/format': formatMod,
});
const sampleRows = [
  { sender_role: 'Child', text_content: 'Saya mau makan', timestamp: String(NOW - 3600000) },
  { sender_role: 'Child', text_content: 'Saya mau minum', timestamp: String(NOW - 1800000) },
  { sender_role: 'Parent', text_content: 'Oke', timestamp: String(NOW - 1200000) },
];
const stats = analyticsMod.computeActivity(sampleRows, 'today', NOW);
check('computeActivity: counts messages, requests, responses, uniqueWords', {
  messages: stats.messages,
  requests: stats.requests,
  responses: stats.responses,
  uniqueWords: stats.uniqueWords,
}, {
  messages: 3,
  requests: 2,
  responses: 1,
  uniqueWords: 4, // saya, mau, makan, minum
});

// ── 6. Visual Reply Assets (ID / EN / ZH / MS) ───────────────────────────────
const replyAssetsMod = loadTsModule('src/assets/replyAssets.ts', {
  '../../assets/replies/oke.png': 'ASSET_OKE',
  '../../assets/replies/tidak.png': 'ASSET_TIDAK',
  '../../assets/replies/tunggu.png': 'ASSET_TUNGGU',
  '../../assets/replies/default.png': 'ASSET_DEFAULT',
});
check('resolveVisualReply: Indonesian "Oke"', replyAssetsMod.resolveVisualReply('Oke'), 'oke');
check('resolveVisualReply: English "No"', replyAssetsMod.resolveVisualReply('No'), 'tidak');
check('resolveVisualReply: Mandarin "稍等"', replyAssetsMod.resolveVisualReply('稍等'), 'tunggu');
check('resolveVisualReply: Malay "Tunggu sekejap"', replyAssetsMod.resolveVisualReply('Tunggu sekejap'), 'tunggu');
check('resolveVisualReply: Malay "Tak Boleh" (safety-first negation wins)', replyAssetsMod.resolveVisualReply('Tak Boleh'), 'tidak');
check('resolveVisualReply + getVisualReplyImage: custom text → default asset', replyAssetsMod.getVisualReplyImage(replyAssetsMod.resolveVisualReply('Ayah sedang rapat')), 'ASSET_DEFAULT');

// ── 7. AAC Dictionary Seed & Local Image / Audio Integrity (All 260 Cards) ───
import { existsSync } from 'node:fs';

const arasaacWords = JSON.parse(readFileSync(join(ROOT, 'assets/data/arasaac.json'), 'utf8'));
check('arasaac.json: exact 260 cards', arasaacWords.length, 260);

const ids = arasaacWords.map((w) => w.id);
const uniqueIds = new Set(ids);
check('arasaac.json: all 260 IDs unique & contiguous 1..260', {
  uniqueCount: uniqueIds.size,
  firstId: ids[0],
  lastId: ids[ids.length - 1],
}, {
  uniqueCount: 260,
  firstId: '1',
  lastId: '260',
});

const wordIds = arasaacWords.map((w) => w.word_id);
const duplicateWordIds = wordIds.filter((w, i) => wordIds.indexOf(w) !== i);
check('arasaac.json: zero duplicate word_id entries', duplicateWordIds, []);

const imageUrls = arasaacWords.map((w) => w.imageUrl);
const duplicateImageUrls = imageUrls.filter((u, i) => imageUrls.indexOf(u) !== i);
check('arasaac.json: zero duplicate imageUrl entries', duplicateImageUrls, []);

// Verify imageMap.ts and audioMap.ts every require() path exists on disk
const imageMapSrc = readFileSync(join(ROOT, 'src/assets/imageMap.ts'), 'utf8');
const imageEntries = [...imageMapSrc.matchAll(/'([^']+)':\s*require\('([^']+)'\)/g)];
const missingImageFiles = [];
const imageKeySet = new Set();
for (const [, key, relReq] of imageEntries) {
  imageKeySet.add(key);
  const resolved = join(ROOT, 'src/assets', relReq);
  if (!existsSync(resolved)) missingImageFiles.push(relReq);
}
check('imageMap.ts: all required PNG files exist on disk', missingImageFiles, []);

const audioMapSrc = readFileSync(join(ROOT, 'src/assets/audioMap.ts'), 'utf8');
const audioEntries = [...audioMapSrc.matchAll(/'([^']+)':\s*require\('([^']+)'\)/g)];
const missingAudioFiles = [];
const audioKeySet = new Set();
for (const [, key, relReq] of audioEntries) {
  audioKeySet.add(key);
  const resolved = join(ROOT, 'src/assets', relReq);
  if (!existsSync(resolved)) missingAudioFiles.push(relReq);
}
check('audioMap.ts: all required MP3 files exist on disk', missingAudioFiles, []);

// Simulate getLocalImage(expectedFilename, gender) for all 260 words across Boy & Girl
const resolveImageKey = (wordId, gender) => {
  const filename = `${wordId.toLowerCase().replace(/\s+/g, '_')}.png`;
  const prefix = gender === 'Girl' ? 'wanita' : 'pria';
  if (imageKeySet.has(`${prefix}_${filename}`)) return `${prefix}_${filename}`;
  if (imageKeySet.has(`umum_${filename}`)) return `umum_${filename}`;
  return null;
};

const unmappedWordsBoy = [];
const unmappedWordsGirl = [];
for (const w of arasaacWords) {
  if (!resolveImageKey(w.word_id, 'Boy')) unmappedWordsBoy.push(`${w.id}:${w.word_id}`);
  if (!resolveImageKey(w.word_id, 'Girl')) unmappedWordsGirl.push(`${w.id}:${w.word_id}`);
}
check('getLocalImage: 100% of 260 cards resolve local PNG for Boy', unmappedWordsBoy, []);
check('getLocalImage: 100% of 260 cards resolve local PNG for Girl', unmappedWordsGirl, []);

// Verify specific revised & newly added cards
const byId = Object.fromEntries(arasaacWords.map((w) => [w.id, w]));
check('Revised card id 7 (Tolong - Verb) vs id 8 (Mohon - Social)', {
  id7: byId['7']?.word_id,
  id7BoyImg: resolveImageKey(byId['7']?.word_id, 'Boy'),
  id8: byId['8']?.word_id,
  id8BoyImg: resolveImageKey(byId['8']?.word_id, 'Boy'),
  id8AudioPria: audioKeySet.has('Mohon_pria'),
  id8AudioWanita: audioKeySet.has('Mohon_wanita'),
}, {
  id7: 'Tolong',
  id7BoyImg: 'pria_tolong.png',
  id8: 'Mohon',
  id8BoyImg: 'pria_mohon.png',
  id8AudioPria: true,
  id8AudioWanita: true,
});

check('Revised card id 138 (Jalan - Place) vs id 208 (Berjalan - Verb)', {
  id138: byId['138']?.word_id,
  id138BoyImg: resolveImageKey(byId['138']?.word_id, 'Boy'),
  id138GirlImg: resolveImageKey(byId['138']?.word_id, 'Girl'),
  id208: byId['208']?.word_id,
  id208BoyImg: resolveImageKey(byId['208']?.word_id, 'Boy'),
  id208GirlImg: resolveImageKey(byId['208']?.word_id, 'Girl'),
  id208AudioPria: audioKeySet.has('Berjalan_pria'),
  id208AudioWanita: audioKeySet.has('Berjalan_wanita'),
}, {
  id138: 'Jalan',
  id138BoyImg: 'umum_jalan.png',
  id138GirlImg: 'umum_jalan.png',
  id208: 'Berjalan',
  id208BoyImg: 'pria_berjalan.png',
  id208GirlImg: 'wanita_berjalan.png',
  id208AudioPria: true,
  id208AudioWanita: true,
});

check('New cards 245..260 (11-19, Puluh/Ratus/Ribu/Juta, Tambah/Kurang/Sama Dengan)', {
  countNew: arasaacWords.filter((w) => Number(w.id) >= 245).length,
  allNumberCategory: arasaacWords.filter((w) => Number(w.id) >= 245).every((w) => w.categoryId === 'number'),
  id245: byId['245']?.word_id,
  id253: byId['253']?.word_id,
  id254: byId['254']?.word_id,
  id255: byId['255']?.word_id,
  id256: byId['256']?.word_id,
  id257: byId['257']?.word_id,
  id258: byId['258']?.word_id,
  id259: byId['259']?.word_id,
  id260: byId['260']?.word_id,
}, {
  countNew: 16,
  allNumberCategory: true,
  id245: 'Sebelas',
  id253: 'Sembilan Belas',
  id254: 'Puluh',
  id255: 'Ratus',
  id256: 'Ribu',
  id257: 'Juta',
  id258: 'Tambah',
  id259: 'Kurang',
  id260: 'Sama Dengan',
});

// ── 8. AboutScreen Social Media Links Verification ───────────────────────────
const aboutSrc = readFileSync(join(ROOT, 'src/screens/AboutScreen.tsx'), 'utf8');
check('AboutScreen: contains official Sensoria Facebook, Instagram, TikTok, YouTube links', {
  facebook: aboutSrc.includes('https://www.facebook.com/aacsensoria'),
  instagram: aboutSrc.includes('https://www.instagram.com/aacsensoria'),
  tiktok: aboutSrc.includes('https://www.tiktok.com/@aacsensoria'),
  youtube: aboutSrc.includes('https://www.youtube.com/@aacsensoria'),
}, {
  facebook: true,
  instagram: true,
  tiktok: true,
  youtube: true,
});

console.log(
  failures === 0
    ? `\nALL ${passed} CORE LOGIC & PRE-RELEASE ASSET CHECKS PASS`
    : `\n${failures} CHECK(S) FAILED (${passed} passed)`,
);
process.exit(failures === 0 ? 0 : 1);

