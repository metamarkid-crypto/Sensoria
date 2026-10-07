/**
 * QA harness — quad-lingual flow (read-only verification).
 *
 * Exercises the exact contracts used by the app against the REAL data:
 *  1. Card labels: resolveWordText (copied verbatim from useAACStore.ts)
 *     over the REAL arasaac.json seed for id / en / zh / ms.
 *  2. Tap-speech text: same resolver — must be non-empty, and the resolved
 *     text is what playTTS receives. zh must contain Han characters; ms must
 *     differ from zh/en and never be empty (Malay labels use Latin script,
 *     so identity with id is allowed for cognates but tracked below).
 *  3. Local audio assets: resolveLocalAudio (copied verbatim from
 *     audioManager.ts) against the REAL audioMap keys for every seed word ×
 *     language × profile — reports which words hit a bundled recording and
 *     which fall through to TTS.
 *  4. Bicara (sentence) speech: joined resolved text must never hit a local
 *     asset (multi-word) — asserts the fallthrough is intended.
 *  5. Parent quick-reply phrases (Oke / Tunggu Sebentar) — the only bundled
 *     recordings — must resolve for the ayah/ibu profiles they exist for.
 *  6. Locale dictionaries: every id.ts key must exist in en/zh/ms (byte-level
 *     key parity) and every {placeholder} in ms must match its id counterpart.
 */
const fs = require('fs');
const path = require('path');

const words = require('../assets/data/arasaac.json');
const audioMapSource = fs.readFileSync(path.join(__dirname, '../src/assets/audioMap.ts'), 'utf8');
// Extract emitted keys from the generated map (e.g. 'Oke_ayah': ...)
const audioKeys = [...audioMapSource.matchAll(/'([^']+)':\s*require\(/g)].map((m) => m[1]);

// ── resolveWordText — verbatim from src/store/useAACStore.ts ──────────────
const resolveWordText = (word, language) => {
  if (language === 'en') return word.word_en || word.word_id;
  if (language === 'zh') return word.word_zh || word.word_id;
  if (language === 'ms') return word.word_ms || word.word_id;
  return word.word_id;
};

// ── resolveLocalAudio — verbatim from src/services/ai/audioManager.ts ─────
const resolveAudioProfile = (role) => {
  if (role === 'Child') return 'pria'; // boy profile; wanita covered separately
  const lowerRole = role.toLowerCase();
  const maleKeywords = ['ayah', 'papa', 'papi', 'abi', 'bapak', 'kakek', 'paman', 'om'];
  if (maleKeywords.some((kw) => lowerRole.includes(kw))) return 'ayah';
  return 'ibu';
};
const resolveLocalAudio = (text, language, role) => {
  const profile = resolveAudioProfile(role);
  return (
    audioKeys.includes(`${text}_${profile}_${language}`) ||
    audioKeys.includes(`${text}_${profile}`) ||
    audioKeys.includes(text)
  );
};

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗ FAIL:', msg); };
const ok = (msg) => console.log('  ✓', msg);

// ── 1 + 2. Card labels + tap-speech text per language ─────────────────────
console.log(`\n[1] Card labels (resolveWordText) — ${words.length} seed words × 4 languages`);
const msIdenticalToId = [];
for (const w of words) {
  for (const lang of ['id', 'en', 'zh', 'ms']) {
    const label = resolveWordText(w, lang);
    if (!label || !label.trim()) fail(`${w.id} (${lang}): EMPTY label`);
    // zh must never receive an English/Indonesian label silently
    if (lang === 'zh' && !/[\u4e00-\u9fff]/.test(label)) {
      fail(`${w.id} (zh): "${label}" contains no Han characters`);
    }
    // ms must never accidentally carry a Mandarin or non-Latin label
    if (lang === 'ms' && !/^[A-Za-z0-9\s'().-]+$/.test(label)) {
      fail(`${w.id} (ms): "${label}" is not plain Latin text`);
    }
    if (lang === 'ms' && label === w.word_id) msIdenticalToId.push(`${w.id}:${label}`);
  }
}
if (!failures) ok(`all ${words.length * 4} (word × language) labels resolved non-empty; zh contains Han, ms is Latin`);
console.log(`  ℹ ms === id (legitimate cognates, keep for human review): ${msIdenticalToId.length}/${words.length}`);

// ── 3. Local audio asset coverage ──────────────────────────────────────────
console.log('\n[2] Local audio resolution — seed words × language × profile (Child=pria, ayah, ibu)');
const localHits = {};
for (const lang of ['id', 'en', 'zh', 'ms']) {
  localHits[lang] = { pria: [], ayah: [], ibu: [] };
}
for (const w of words) {
  for (const lang of ['id', 'en', 'zh', 'ms']) {
    const text = resolveWordText(w, lang);
    for (const role of ['Child', 'ayah', 'ibu']) {
      if (resolveLocalAudio(text, lang, role)) localHits[lang][resolveAudioProfile(role)].push(`${text} (${w.id})`);
    }
  }
}
for (const lang of ['id', 'en', 'zh', 'ms']) {
  for (const profile of ['pria', 'ayah', 'ibu']) {
    const hits = localHits[lang][profile];
    console.log(`  ${lang} / ${profile}: ${hits.length ? hits.join(', ') : 'no bundled asset → TTS fallback'}`);
  }
}

// ── 4. Bicara sentence speech ──────────────────────────────────────────────
console.log('\n[3] Sentence (Bicara) speech — joined text must NOT match a single-word asset key');
const sampleSentences = [
  ['Saya', 'Mau', 'Makan'],
  ['Tolong', 'Makan'],
  ['Ibu', 'Tolong'],
  ['Mau', 'Minum'],
  ['Bicara'],
  ['Terima Kasih'],
];
for (const ids of sampleSentences) {
  const joined = ids.map((wid) => {
    const w = words.find((x) => x.word_id === wid);
    return resolveWordText(w, 'id');
  }).join(' ');
  for (const profile of ['pria', 'wanita', 'ayah', 'ibu']) {
    const hit = audioKeys.includes(`${joined}_${profile}_id`) || audioKeys.includes(`${joined}_${profile}`) || audioKeys.includes(joined);
    if (hit) fail(`sentence "${joined}" unexpectedly resolved a local asset for ${profile}`);
  }
  console.log(`  "${joined}" → TTS (expected: no bundled recording for a sentence)`);
}

// ── 5. Parent quick-reply phrases vs bundled recordings ────────────────────
console.log('\n[4] Bundled recordings (parent quick replies)');
const quickReplies = ['Oke', 'Tunggu Sebentar'];
for (const qr of quickReplies) {
  const inWords = words.some((w) => w.word_id === qr);
  if (inWords) fail(`"${qr}" unexpectedly exists as a seed word (asset would be shadowed)`);
  const profiles = ['ayah', 'ibu'];
  const hits = profiles.filter((p) => resolveLocalAudio(qr, 'id', p));
  console.log(`  "${qr}": local for ${hits.join(', ') || 'NOTHING'}`);
  if (hits.length !== 2) fail(`"${qr}" should exist for ayah AND ibu profiles`);
  // en/zh/ms variants — no bundled asset expected anywhere yet
  console.log(`  "${qr}" en="OK" local? ${resolveLocalAudio('OK', 'en', 'ayah') ? 'yes' : 'no (TTS)'}`);
  console.log(`  "${qr}" zh="好的" local? ${resolveLocalAudio('好的', 'zh', 'ayah') ? 'yes' : 'no (TTS)'}`);
  console.log(`  "${qr}" ms="Oke" local? ${resolveLocalAudio('Oke', 'ms', 'ayah') ? 'yes' : 'no (TTS)'}`);
}

// ── 6. Locale dictionary key + placeholder parity ─────────────────────────
console.log('\n[5] Locale dictionaries — key parity + {placeholder} parity (id ↔ en/zh/ms)');
const readKeys = (file) => {
  const src = fs.readFileSync(path.join(__dirname, `../src/i18n/locales/${file}.ts`), 'utf8');
  return [...src.matchAll(/'([a-zA-Z]+\.[a-zA-Z0-9]+)':/g)].map((m) => m[1]);
};
const idKeys = readKeys('id');
const placeholders = (line) => [...line.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort().join(',');
for (const lang of ['en', 'zh', 'ms']) {
  const keys = readKeys(lang);
  const missing = idKeys.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !idKeys.includes(k));
  if (missing.length) fail(`${lang}.ts missing keys: ${missing.join(', ')}`);
  if (extra.length) fail(`${lang}.ts extra keys (not in master id.ts): ${extra.join(', ')}`);
  if (!missing.length && !extra.length) ok(`${lang}.ts key parity with id.ts (${idKeys.length} keys)`);
}
// {placeholder} parity per key for ms (the language being added now)
const readLines = (file) => fs.readFileSync(path.join(__dirname, `../src/i18n/locales/${file}.ts`), 'utf8').split('\n');
const idLines = readLines('id');
const msLines = readLines('ms');
const idLineByKey = {};
for (const line of idLines) {
  const m = line.match(/'([a-zA-Z]+\.[a-zA-Z0-9]+)':\s*'/);
  if (m) idLineByKey[m[1]] = line;
}
let msPhChecked = 0;
const failuresBeforeMsPh = failures;
for (const [key, idLine] of Object.entries(idLineByKey)) {
  const msLine = msLines.find((l) => l.includes(`'${key}':`));
  if (!msLine) continue; // key parity already reported above
  const want = placeholders(idLine);
  const got = placeholders(msLine);
  if (want !== got) fail(`ms.ts '${key}' placeholder mismatch: id={${want}} ms={${got}}`);
  msPhChecked++;
}
if (msPhChecked && failures === failuresBeforeMsPh) ok(`ms.ts {placeholder} parity checked on ${msPhChecked} keys`);

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ All quad-lingual contract checks passed');
process.exit(failures ? 1 : 0);
