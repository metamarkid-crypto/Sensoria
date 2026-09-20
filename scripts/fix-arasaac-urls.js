/**
 * fix-arasaac-urls.js — perbaiki imageUrl yang salah di assets/data/arasaac.json.
 *
 * Hanya menyentuh entri dengan verdict WRONG/NOMETA dari laporan
 * scripts/arasaac-verify-report.json (id 1-57 yang MATCH tidak diganggu).
 *
 * Metode per entri:
 *   1. Cari kandidat via API pencarian ARASAAC (word_en).
 *   2. Pilih kandidat dengan keyword paling mirip (skor kemiripan token),
 *      dengan preferensi pictogram sederhana (tanpa sex/violence context).
 *   3. Verifikasi HTTP 200 URL gambar kandidat.
 *   4. Tulis imageUrl baru ke arasaac.json (backup di arasaac.json.bak).
 *
 * Usage: node scripts/fix-arasaac-urls.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'assets/data/arasaac.json');
const REPORT = path.join(ROOT, 'scripts', 'arasaac-verify-report.json');

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
const badEntries = new Map(
  report.results.filter(r => r.verdict === 'WRONG' || r.verdict === 'NOMETA').map(r => [String(r.id), r])
);

// id yang punya gambar lokal (verdict catatan: biarkan URL-nya, tapi tetap perbaiki kalau 404/mismatch)
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function searchWord(term, retries = 2) {
  const url = 'https://api.arasaac.org/api/pictograms/en/search/' + encodeURIComponent(term);
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

// skor kemiripan keyword kandidat vs kata target (EN) + kata Indonesia sebagai bonus kecil
function score(picto, en, idn) {
  const kws = (picto.keywords || []).map(k => String(k.keyword || '').toLowerCase());
  const enT = norm(en), idT = norm(idn);
  let best = 0;
  for (const kw of kws) {
    const kwT = norm(kw);
    let s = 0;
    if (kwT === enT) s = 100;
    else if (kwT.includes(enT) || enT.includes(kwT)) s = 60 + Math.min(kwT.length, 20) / 10;
    else {
      // token match parsial (multi-kata)
      const kt = kwT.split(/[^a-z]+/).filter(Boolean);
      if (kt.some(x => x === enT)) s = 80;
      else if (kt.some(x => enT.length >= 4 && (x.includes(enT) || enT.includes(x)))) s = 50;
    }
    if (idT && !s) {
      // kemiripan kata Indonesia dengan keyword (jarang cocok karena keyword EN, tapi coba)
      if (kwT.includes(idT) || idT.includes(kwT)) s = 40;
    }
    if (s > best) best = s;
  }
  // bonus kecil: pictogram "sederhana" (bukan konteks violent/sex)
  const tags = (picto.tags || []).map(t => String(t).toLowerCase());
  if (tags.some(t => /violen|sex|weapon/.test(t))) best -= 10;
  return best;
}

function norm(s) { return String(s || '').toLowerCase().trim(); }

// kata-kata yang butuh query khusus (word_en terlalu ambigu/kontekstual)
const QUERY_OVERRIDES = {
  '240': 'help',        // Bantu (Help me)
  '56': null,           // (tidak ada di daftar salah, contoh aman)
  '243': 'myself',
  '241': 'this',
  '242': 'that one',
  '244': 'all',
  '157': 'now',
  '158': 'later',
  '163': 'when',
  '192': 'wristwatch',
  '231': 'television',
  '177': 'rooster',
  '186': 'formal shirt',
  '186b': null,
};

(async () => {
  const plan = [];
  for (const e of db) {
    const r = badEntries.get(String(e.id));
    if (!r) continue;
    const term = QUERY_OVERRIDES[String(e.id)] !== undefined && QUERY_OVERRIDES[String(e.id)] !== null
      ? QUERY_OVERRIDES[String(e.id)]
      : (e.word_en || e.word_id).trim();
    plan.push({ e, term });
  }

  console.error(`Memperbaiki ${plan.length} entri...\n`);
  const chosen = new Map(); // id -> {pid, url, kw, score}
  const queue = [...plan];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const { e, term } = queue.shift();
      const found = await searchWord(term);
      if (!Array.isArray(found) || !found.length) {
        // fallback: coba kata pertama word_en (mis. "Careful" -> "care")
        const alt = String(term).split(/\s+/)[0];
        if (alt !== term) {
          const found2 = await searchWord(alt);
          if (Array.isArray(found2) && found2.length) {
            found.push(...found2.slice(0, 20));
          }
        }
      }
      if (Array.isArray(found) && found.length) {
        const scored = found
          .map(p => ({ p, s: score(p, e.word_en, e.word_id) }))
          .sort((a, b) => b.s - a.s);
        const top = scored[0];
        if (top && top.s >= 50) {
          const pid = top.p._id;
          chosen.set(String(e.id), {
            pid,
            url: `https://static.arasaac.org/pictograms/${pid}/${pid}_300.png`,
            kw: (top.p.keywords && top.p.keywords[0] && top.p.keywords[0].keyword) || '',
            s: Math.round(top.s),
          });
        } else {
          console.error(`  ?? id:${e.id} ${e.word_id} (${term}) -> tidak ada kandidat skor>=50 (best=${top ? top.s : '-'})`);
        }
      } else {
        console.error(`  ?? id:${e.id} ${e.word_id} (${term}) -> pencarian gagal/kosong`);
      }
      await sleep(120);
    }
  }));

  console.error(`\nKandidat terpilih: ${chosen.size}/${plan.length}\n`);

  // verifikasi HTTP semua URL terpilih sebelum menulis
  console.error('Verifikasi HTTP URL terpilih...');
  const ok = new Map();
  const vq = [...chosen.entries()];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (vq.length) {
      const [id, c] = vq.shift();
      let good = false;
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch(c.url);
          if (res.status === 200) { good = true; break; }
        } catch {}
        await sleep(1000);
      }
      if (good) ok.set(id, c); else console.error(`  HTTP gagal terus: id:${id} ${c.url}`);
      await sleep(60);
    }
  }));
  console.error(`HTTP OK: ${ok.size}/${chosen.size}\n`);

  // tulis perubahan
  let changed = 0;
  for (const e of db) {
    const c = ok.get(String(e.id));
    if (c && e.imageUrl !== c.url) {
      console.error(`  fix id:${e.id} ${e.word_id}: ${e.imageUrl} -> ${c.url}  [${c.kw}]`);
      e.imageUrl = c.url;
      changed++;
    }
  }

  if (changed) {
    fs.copyFileSync(DB_PATH, DB_PATH + '.bak.orig'); // kondisi SEBELUM perubahan
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n');
  }
  console.error(`\nSelesai. ${changed} imageUrl diperbaiki. Backup: arasaac.json.bak.orig`);
})();
