/**
 * verify-arasaac-ids.js — verdict final MATCH/WRONG untuk SEMUA 244 kata
 * di assets/data/arasaac.json.
 *
 * Metode: fetch metadata resmi per ID piktogram
 *   GET https://api.arasaac.org/api/pictograms/id/{pictogramId}
 * lalu bandingkan keywords metadata dengan word_en/word_id.
 *
 * Output:
 *   - console: ringkasan + daftar WRONG/NOMETA
 *   - scripts/arasaac-verify-report.json: laporan lengkap
 * Usage: node scripts/verify-arasaac-ids.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/arasaac.json'), 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getMeta(pictoId, retries = 2) {
  const url = 'https://api.arasaac.org/api/pictograms/en/' + pictoId;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === retries) return e.name === 'AbortError' ? 'timeout' : 'ERR:' + e.message;
      await sleep(1500);
    }
  }
}

function norm(s) {
  return String(s || '').toLowerCase().trim();
}

// token umum yang terlalu generik untuk jadi bukti kecocokan sendirian
const STOP_TOKENS = new Set(['me', 'my', 'the', 'a', 'an', 'of']);

// sinonim yang sah: word_en -> keyword alternatif yang dianggap cocok
const SYNONYMS = {
  'noon': ['midday'],
  'midday': ['noon'],
};

function tokenOverlap(needle, haystack) {
  // pecah needle jadi token ("help me" -> [help, me]; "train driver" -> [train, driver])
  // lalu MATCH bila ada satu token pun yang muncul di keywords.
  // Token pendek (<=2 huruf, mis. "i") diwajibkan match token UTUH di haystack
  // supaya substring liar ("i" di dalam "sit") tidak dianggap cocok.
  const hayTokens = new Set(norm(haystack).split(/[^a-z0-9]+/).filter(Boolean));
  const tokens = norm(needle).split(/[^a-z0-9]+/).filter(t => t && !STOP_TOKENS.has(t));
  return tokens.some(t => {
    if (t.length <= 2) return hayTokens.has(t);
    if (haystack.includes(t)) return true;
    if (t.length >= 4 && t.endsWith('s') && haystack.includes(t.slice(0, -1))) return true; // cat/cats
    return false;
  });
}

(async () => {
  const q = [...db];
  const results = [];
  let done = 0;
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (q.length) {
      const e = q.shift();
      const pid = (e.imageUrl.match(/pictograms\/(\d+)\//) || [])[1];
      const meta = await getMeta(pid);
      let verdict;
      if (meta === 'timeout' || (typeof meta === 'string' && meta.startsWith('ERR:'))) {
        verdict = 'API:' + meta;
      } else if (meta === null) {
        verdict = 'NOMETA'; // ID tidak ada di database ARASAAC
      } else {
        // kumpulkan semua keywords EN dari metadata
        const kws = (meta.keywords || [])
          .map(k => k.keyword || '')
          .join('|')
          .toLowerCase();
        const en = e.word_en || '';
        const idn = e.word_id || '';
        const hitEn = tokenOverlap(en, kws) || (SYNONYMS[norm(en)] || []).some(s => tokenOverlap(s, kws));
        const hitId = tokenOverlap(idn, kws);
        verdict = hitEn || hitId ? 'MATCH' : 'WRONG';
        results.push({
          id: e.id, word_id: idn, word_en: en, categoryId: e.categoryId,
          pictogram_id: pid, verdict, keywords: kws.slice(0, 200),
        });
      }
      if (verdict.startsWith('API:') || verdict === 'NOMETA') {
        results.push({
          id: e.id, word_id: e.word_id, word_en: e.word_en, categoryId: e.categoryId,
          pictogram_id: pid, verdict, keywords: '',
        });
      }
      done++;
      if (done % 50 === 0) console.error(`  ...${done}/${db.length}`);
      await sleep(100);
    }
  }));

  const by = v => results.filter(r => r.verdict === v);
  console.error('\n=== VERDICT (metadata resmi per ID) ===');
  console.error(`MATCH: ${by('MATCH').length} | WRONG: ${by('WRONG').length} | NOMETA: ${by('NOMETA').length} | API-error: ${results.filter(r => r.verdict.startsWith('API:')).length} | total: ${results.length}`);

  const bad = results.filter(r => r.verdict === 'WRONG' || r.verdict === 'NOMETA');
  console.error(`\n=== TIDAK SESUAI (${bad.length}) ===`);
  for (const r of bad.sort((a, b) => Number(a.id) - Number(b.id))) {
    console.error(`${r.verdict}\tid:${r.id}\t${r.word_id}\t(${r.word_en})\tpicto:${r.pictogram_id}\tkeywords:${r.keywords || '-'}`);
  }

  fs.writeFileSync(
    path.join(ROOT, 'scripts', 'arasaac-verify-report.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)
  );
  console.error('\nLaporan: scripts/arasaac-verify-report.json');
})();
