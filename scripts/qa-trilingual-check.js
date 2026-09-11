/**
 * QA harness — trilingual flow (read-only verification).
 *
 * Exercises the exact contracts used by the app against the REAL data:
 *  1. Card labels: resolveWordText (copied verbatim from useAACStore.ts)
 *     over the REAL arasaac.json seed for id / en / zh.
 *  2. Tap-speech text: same resolver — must be non-empty, and the resolved
 *     text is what playTTS receives.
 *  3. Local audio assets: resolveLocalAudio (copied verbatim from
 *     audioManager.ts) against the REAL audioMap keys for every seed word ×
 *     language × profile — reports which words hit a bundled recording and
 *     which fall through to TTS.
 *  4. Bicara (sentence) speech: joined resolved text must never hit a local
 *     asset (multi-word) — asserts the fallthrough is intended.
 *  5. Parent quick-reply phrases (Oke / Tunggu Sebentar) — the only bundled
 *     recordings — must resolve for the ayah/ibu profiles they exist for.
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
console.log('\n[1] Card labels (resolveWordText) — 57 seed words × 3 languages');
for (const w of words) {
  for (const lang of ['id', 'en', 'zh']) {
    const label = resolveWordText(w, lang);
    if (!label || !label.trim()) fail(`${w.id} (${lang}): EMPTY label`);
    // zh must never receive an English/Indonesian label silently
    if (lang === 'zh' && !/[\u4e00-\u9fff]/.test(label)) {
      fail(`${w.id} (zh): "${label}" contains no Han characters`);
    }
  }
}
if (!failures) ok('all 171 (word × language) labels resolved non-empty; zh labels contain Han characters');

// ── 3. Local audio asset coverage ──────────────────────────────────────────
console.log('\n[2] Local audio resolution — seed words × language × profile (Child=pria, ayah, ibu)');
const localHits = {};
for (const lang of ['id', 'en', 'zh']) {
  localHits[lang] = { pria: [], ayah: [], ibu: [] };
}
for (const w of words) {
  for (const lang of ['id', 'en', 'zh']) {
    const text = resolveWordText(w, lang);
    for (const role of ['Child', 'ayah', 'ibu']) {
      if (resolveLocalAudio(text, lang, role)) localHits[lang][resolveAudioProfile(role)].push(`${text} (${w.id})`);
    }
  }
}
for (const lang of ['id', 'en', 'zh']) {
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
  // en/zh variants: 'OK' / '好的' — no bundled asset expected
  console.log(`  "${qr}" en="OK" local? ${resolveLocalAudio('OK', 'en', 'ayah') ? 'yes' : 'no (TTS)'}`);
  console.log(`  "${qr}" zh="好的" local? ${resolveLocalAudio('好的', 'zh', 'ayah') ? 'yes' : 'no (TTS)'}`);
}

console.log(failures ? `\n✗ ${failures} failure(s)` : '\n✓ All trilingual contract checks passed');
process.exit(failures ? 1 : 0);