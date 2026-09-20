/**
 * check-arasaac-urls.js — validasi URL komunitas ARASAAC.
 *
 * Untuk setiap kata di assets/data/arasaac.json yang BELUM punya gambar lokal
 * (assets/kamus/{umum,pria,wanita}):
 *   Fase 1 — cek HTTP status semua imageUrl (harus 200).
 *   Fase 2 — validasi semantik: cari word_en via API ARASAAC dan pastikan id
 *            piktogram yang dipakai muncul di hasil teratas pencarian kata tsb.
 *
 * Output: laporan konsol (OK / gagal / mismatch + kandidat pengganti).
 * Usage: node scripts/check-arasaac-urls.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const db = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/data/arasaac.json'), 'utf8'));

const lokal = new Set(
  fs.readdirSync(path.join(ROOT, 'assets/kamus/umum')).map(f => f.replace(/\.png$/i, ''))
);
for (const d of ['pria', 'wanita']) {
  for (const f of fs.readdirSync(path.join(ROOT, 'assets/kamus/' + d))) {
    lokal.add(f.replace(/\.png$/i, ''));
  }
}
const norm = s => String(s || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
const belum = db.filter(e => !lokal.has(norm(e.word_id)));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function checkUrl(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      try { await res.arrayBuffer(); } catch {}
      return res.status;
    } catch (e) {
      if (i === retries) return 'ERR:' + (e.name === 'AbortError' ? 'timeout' : e.message);
      await sleep(1500);
    }
  }
}

async function searchWord(term, locale = 'en', retries = 2) {
  const url = 'https://api.arasaac.org/api/pictograms/' + locale + '/search/' + encodeURIComponent(term);
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === retries) return e.name === 'AbortError' ? 'timeout' : 'ERR:' + e.message;
      await sleep(1500);
    }
  }
}

(async () => {
  console.error(`=== FASE 1: cek HTTP ${belum.length} URL gambar ===`);
  const status = new Map();
  const q1 = [...belum];
  let done1 = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (q1.length) {
      const e = q1.shift();
      const s = await checkUrl(e.imageUrl);
      status.set(e.id, s);
      done1++;
      if (s !== 200) console.error(`  [${s}] ${e.word_id} -> ${e.imageUrl}`);
      if (done1 % 50 === 0) console.error(`  ...${done1}/${belum.length}`);
    }
  }));
  const fail1 = belum.filter(e => status.get(e.id) !== 200);
  console.error(`FASE 1 selesai: ${belum.length - fail1.length} OK, ${fail1.length} gagal\n`);

  console.error(`=== FASE 2: validasi semantik via API ARASAAC (${belum.length} kata) ===`);
  const results = [];
  const q2 = [...belum];
  let done2 = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (q2.length) {
      const e = q2.shift();
      const term = (e.word_en || e.word_id).trim();
      const found = await searchWord(term);
      let verdict;
      if (typeof found === 'string') verdict = 'API:' + found;
      else if (!Array.isArray(found) || !found.length) verdict = 'NORESULT';
      else {
        const id = (e.imageUrl.match(/pictograms\/(\d+)\//) || [])[1];
        const pos = found.findIndex(p => String(p._id) === id);
        if (pos === 0) verdict = 'TOP1';
        else if (pos > 0 && pos < 3) verdict = 'TOP3';
        else if (pos > 0 && pos < 10) verdict = 'TOP10';
        else verdict = 'MISMATCH';
      }
      results.push({
        id: e.id,
        word_id: e.word_id,
        word_en: e.word_en,
        categoryId: e.categoryId,
        pictogram_id: (e.imageUrl.match(/pictograms\/(\d+)\//) || [])[1],
        verdict,
        candidates: Array.isArray(found)
          ? found.slice(0, 10).map(p => ({ id: p._id, kw: (p.keywords && p.keywords[0] && p.keywords[0].keyword) || '' }))
          : [],
      });
      done2++;
      if (done2 % 25 === 0) console.error(`  ...${done2}/${belum.length}`);
      await sleep(120); // sopan ke API publik
    }
  }));

  const by = v => results.filter(r => r.verdict === v);
  console.error('\n=== RINGKASAN ===');
  console.error(`TOP1: ${by('TOP1').length} | TOP3: ${by('TOP3').length} | TOP10: ${by('TOP10').length} | MISMATCH: ${by('MISMATCH').length} | NORESULT: ${by('NORESULT').length} | API-error: ${results.filter(r => r.verdict.startsWith('API:')).length}`);

  const mism = results.filter(r => r.verdict === 'MISMATCH' || r.verdict === 'NORESULT' || r.verdict.startsWith('API:'));
  console.error(`\n=== PERLU REVIEW (${mism.length}) ===`);
  for (const r of mism) {
    console.error(`${r.verdict}\t${r.id}\t${r.word_id}\t(${r.word_en})\tgambar:${r.pictogram_id}\tkandidat:${r.candidates.map(c => c.id + '=' + c.kw).join(', ') || '-'}`);
  }
  console.error('\n=== TOP10 (aman, hanya info) ===');
  for (const r of by('TOP10')) {
    console.error(`${r.id}\t${r.word_id}\t(${r.word_en})\tgambar:${r.pictogram_id}\tkandidat:${r.candidates.map(c => c.id + '=' + c.kw).join(', ')}`);
  }

  fs.writeFileSync(
    path.join(ROOT, 'scripts', 'arasaac-url-check-report.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), httpFails: fail1.map(e => ({ id: e.id, word_id: e.word_id, url: e.imageUrl, status: status.get(e.id) })), semantic: results }, null, 2)
  );
  console.error('\nLaporan lengkap: scripts/arasaac-url-check-report.json');
})();
