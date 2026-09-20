/**
 * download-umum-500.js — siapkan gambar 500x500 TRANSPARAN untuk semua kata
 * yang belum punya gambar lokal, ke assets/kamus/umum/.
 *
 * Kenapa folder umum: getLocalImage() di src/assets/imageMap.ts mencari
 * pria/wanita sesuai gender profil, lalu fallback ke umum — jadi folder umum
 * memang tempat gambar tanpa gender (netral).
 *
 * Pipeline per gambar:
 *   1. Unduh piktogram ARASAAC ukuran 500 (URL _300 -> _500) dari
 *      assets/data/arasaac.json (URL sudah terverifikasi sesuai kata).
 *   2. Decode ke RGBA via sharp.
 *   3. Flood-fill KUMULATIF dari tepi — hasil tiap tahap bertumpuk:
 *        a. Mode putih (tangga ambang 240 -> 205): latar putih maupun
 *           nyaris-putih jadi transparan.
 *        b. Mode warna (bila tepi didominasi satu warna non-putih): menghapus
 *           BINGKAI seragam mengelilingi gambar (mis. cincin hijau tua pada
 *           "Gunung"/"Desa"). Setelah bingkai transparan, langit putih
 *           terhubung ke tepi sehingga tertangkap putih tahap c.
 *        c. Putih lagi (menangkap latar yang baru terhubung).
 *        d. Mode gelap (bila tepi gelap): scene gelap seperti "Astronot".
 *      Putih DI DALAM objek (terkurung garis — mata, gelas, swatch "Putih")
 *      tetap utuh. Tebal bingkai tak perlu seragam — flood dari tepi
 *      otomatis mengikuti bentuknya.
 *   4. Feathering: piksel anti-alias di batas objek diberi alpha bertahap.
 *   5. Encode PNG (RGBA, compressionLevel 9) + validasi: 500x500, alpha,
 *      sudut transparan, latar terhapus cukup.
 *
 * Usage:
 *   node scripts/download-umum-500.js            -> proses yang belum ada saja
 *   node scripts/download-umum-500.js --force    -> proses ulang semua
 *   node scripts/download-umum-500.js --dry-run  -> daftar saja, tanpa unduh
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'assets/data/arasaac.json');
const OUT_DIR = path.join(ROOT, 'assets/kamus/umum');

const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const fname = w => `${w.toLowerCase().replace(/\s+/g, '_')}.png`;
const to500 = u => u.replace(/_300\.png$/, '_500.png');

fs.mkdirSync(OUT_DIR, { recursive: true });

// daftar kata yang belum punya gambar di pria/wanita/umum
const missing = [];
for (const e of db) {
  const has = ['pria', 'wanita', 'umum'].some(g =>
    fs.existsSync(path.join(ROOT, 'assets/kamus', g, fname(e.word_id)))
  );
  if (!has) missing.push(e);
}

console.log(`Kata tanpa gambar lokal: ${missing.length}/${db.length}`);
if (DRY) {
  for (const e of missing) console.log(`  ${e.id}\t${e.word_id}\t${to500(e.imageUrl)}`);
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- util piksel ----------

function lum(o, data) {
  return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
}

function cornerTransparent(data, W, H) {
  const a = (x, y) => data[(y * W + x) * 4 + 3];
  return a(0, 0) === 0 && a(W - 1, 0) === 0 && a(0, H - 1) === 0 && a(W - 1, H - 1) === 0;
}

// rata-rata luminansi piksel tepi yang masih opaque
function edgeMeanLum(data, W, H) {
  let sum = 0, n = 0;
  const add = (x, y) => { const o = (y * W + x) * 4; if (data[o + 3] > 0) { sum += lum(o, data); n++; } };
  for (let x = 0; x < W; x++) { add(x, 0); add(x, H - 1); }
  for (let y = 0; y < H; y++) { add(0, y); add(W - 1, y); }
  return n ? sum / n : 255;
}

/**
 * Flood dari tepi.
 * mode 'white': bg = min(r,g,b) >= T ; 'dark': bg = max(r,g,b) <= T ;
 * mode 'color': bg = jarak manhattan ke warna ref <= T (bingkai berwarna).
 * Mengembalikan jumlah piksel yang baru jadi transparan (unit piksel).
 */
function floodFromEdges(data, W, H, T, mode, ref) {
  const total = W * H;
  const isBg = i => {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    if (mode === 'dark') return Math.max(r, g, b) <= T;
    if (mode === 'color') {
      return Math.abs(r - ref[0]) + Math.abs(g - ref[1]) + Math.abs(b - ref[2]) <= T;
    }
    return Math.min(r, g, b) >= T;
  };

  const queue = new Int32Array(total);
  let qh = 0, qt = 0;
  const seen = new Uint8Array(total);
  // Piksel yang sudah transparan selalu bisa dilalui (jalur tembus menembus
  // bingkai yang alpha-nya memang 0, mis. bingkai hijau pada "Gunung").
  const push = i => {
    if (seen[i]) return;
    if (data[i * 4 + 3] === 0) { seen[i] = 1; queue[qt++] = i; return; }
    if (isBg(i)) { seen[i] = 1; queue[qt++] = i; }
  };

  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W, y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }

  let count = 0;
  for (let i = 0; i < total; i++) {
    if (seen[i] && data[i * 4 + 3] !== 0) { data[i * 4 + 3] = 0; count++; }
  }
  return count;
}

/**
 * Deteksi warna bingkai: warna tepi non-putih yang dominan.
 * Return [r,g,b] atau null bila tidak ada indikasi bingkai berwarna.
 */
function detectFrameColor(data, W, H) {
  const c = (x, y) => { const o = (y * W + x) * 4; return [data[o], data[o + 1], data[o + 2]]; };
  let colorish = 0, n = 0;
  const hist = new Map();
  const add = (x, y) => {
    n++;
    const p = c(x, y);
    const mn = Math.min(p[0], p[1], p[2]), mx = Math.max(p[0], p[1], p[2]);
    if (mn >= 230 || mx <= 90) return; // putih atau gelap -> bukan bingkai warna
    colorish++;
    const k = p.join(',');
    hist.set(k, (hist.get(k) || 0) + 1);
  };
  for (let x = 0; x < W; x++) { add(x, 0); add(x, H - 1); }
  for (let y = 0; y < H; y++) { add(0, y); add(W - 1, y); }
  if (colorish / n < 0.2) return null;
  let best = null, bestN = 0;
  for (const [k, v] of hist) if (v > bestN) { best = k; bestN = v; }
  if (bestN / n < 0.12) return null; // harus jelas dominan
  return best.split(',').map(Number);
}

/**
 * Pipa flood kumulatif. Return { data, pct, how }.
 */
const MIN_TRANSP_PCT = 15;
const WHITE_LADDER = [240, 235, 225, 215, 205];

function floodCumulative(srcData, W, H) {
  const data = Buffer.from(srcData);
  const steps = [];

  const runWhite = T => {
    const n = floodFromEdges(data, W, H, T, 'white');
    if (n > 100) steps.push(`putih${T}(${(n * 100 / (W * H)).toFixed(1)}%)`);
  };
  const runColor = (T, ref) => {
    const n = floodFromEdges(data, W, H, T, 'color', ref);
    if (n > 100) steps.push(`warna${T}(${(n * 100 / (W * H)).toFixed(1)}%)`);
  };
  const runDark = T => {
    const n = floodFromEdges(data, W, H, T, 'dark');
    if (n > 100) steps.push(`gelap${T}(${(n * 100 / (W * H)).toFixed(1)}%)`);
  };

  for (const T of WHITE_LADDER) runWhite(T);

  const ref = detectFrameColor(data, W, H);
  if (ref) {
    for (const T of [235, 205]) runColor(T, ref);
    for (const T of WHITE_LADDER) runWhite(T);
  }

  if (!cornerTransparent(data, W, H) && edgeMeanLum(data, W, H) < 90) {
    runDark(90);
  }

  let count = 0;
  for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] === 0) count++;
  return { data, pct: count / (W * H) * 100, how: steps.join('+') || 'tidak-ada' };
}

/**
 * Feathering di atas hasil kumulatif: piksel opaque yang MENEMPEL area
 * transparan dan warnanya dekat putih (AA tepi latar putih) atau dekat warna
 * bingkai (AA tepi bingkai) diberi alpha bertahap.
 */
function feather(data, W, H, ref) {
  for (let pass = 0; pass < 2; pass++) {
    const snap = Buffer.from(data);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4;
        if (snap[o + 3] === 0) continue;
        const nearTransparent =
          (x > 0 && snap[o - 4 + 3] === 0) ||
          (x < W - 1 && snap[o + 4 + 3] === 0) ||
          (y > 0 && snap[o - W * 4 + 3] === 0) ||
          (y < H - 1 && snap[o + W * 4 + 3] === 0);
        if (!nearTransparent) continue;

        const r = snap[o], g = snap[o + 1], b = snap[o + 2];
        const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
        let a = 255;
        if (mn >= 185) {
          // dekat putih -> makin dekat putih makin transparan
          a = Math.min(a, Math.round(255 * Math.max(0, Math.min(1, (240 - mn) / 55))));
        }
        if (ref) {
          const d = Math.abs(r - ref[0]) + Math.abs(g - ref[1]) + Math.abs(b - ref[2]);
          if (d <= 140) {
            a = Math.min(a, Math.round(255 * Math.max(0, Math.min(1, d / 70))));
          }
        }
        if (mx <= 90) {
          // dekat gelap (outline hitam) -> jaga tetap solid
          a = Math.max(a, 255);
        }
        if (a < data[o + 3]) data[o + 3] = a;
      }
    }
  }
}

// ---------- validasi PNG hasil ----------

function pngInfo(buf) {
  if (!buf || buf.length < 33) return null;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colorType: buf[25] };
}

// ---------- utama ----------

(async () => {
  let ok = 0, skipped = 0, failed = 0;
  const failures = [];
  const q = [...missing];

  const worker = async () => {
    while (q.length) {
      const e = q.shift();
      const out = path.join(OUT_DIR, fname(e.word_id));
      if (!FORCE && fs.existsSync(out)) { skipped++; continue; }

      const url = to500(e.imageUrl);
      try {
        let buf = null;
        for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
          try {
            const res = await fetch(url);
            if (res.status === 200) buf = Buffer.from(await res.arrayBuffer());
            else if (attempt === 3) throw new Error(`HTTP ${res.status}`);
          } catch (err) {
            if (attempt === 3) throw err;
          }
          if (!buf) await sleep(900 * attempt);
        }

        // decode -> RGBA raw 500x500
        const { data: orig, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        if (info.width !== 500 || info.height !== 500) {
          throw new Error(`sumber bukan 500x500 (${info.width}x${info.height})`);
        }

        const { data: finalData, pct, how } = floodCumulative(orig, 500, 500);
        const ref = detectFrameColor(orig, 500, 500);
        feather(finalData, 500, 500, ref);

        // encode PNG dari raw final
        const outBuf = await sharp(finalData, { raw: { width: 500, height: 500, channels: 4 } })
          .png({ compressionLevel: 9 })
          .toBuffer();

        // validasi file jadi
        const v = pngInfo(outBuf);
        if (!v) throw new Error('hasil bukan PNG valid');
        if (v.width !== 500 || v.height !== 500) throw new Error(`hasil ${v.width}x${v.height}`);
        if (v.colorType !== 6) throw new Error(`hasil colorType ${v.colorType} (harus 6=RGBA)`);
        if (pct < MIN_TRANSP_PCT) throw new Error(`latar tak terhapus cukup (${pct.toFixed(1)}%, mode ${how})`);
        if (!cornerTransparent(finalData, 500, 500)) throw new Error('sudut tidak transparan (mode ' + how + ')');

        fs.writeFileSync(out, outBuf);
        ok++;
        if (!how.startsWith('putih240')) {
          console.log(`  [${e.word_id}] ${how} (${pct.toFixed(1)}% transparan)`);
        }
      } catch (err) {
        failed++;
        failures.push(`${e.word_id}: ${err.message}`);
      }
      await sleep(60);
    }
  };

  await Promise.all(Array.from({ length: 4 }, worker));

  console.log(`\nHasil: ${ok} dibuat, ${skipped} dilewati (sudah ada), ${failed} gagal.`);
  if (failures.length) {
    console.log('\nGAGAL:');
    failures.forEach(f => console.log('  ' + f));
  }
  console.log('\nLangkah lanjut: node scripts/sync-images.js lalu npx tsc --noEmit');
})();
