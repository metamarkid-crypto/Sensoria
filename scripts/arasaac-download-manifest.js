/**
 * arasaac-download-manifest.js — generates a download plan for OFFLINE images.
 *
 * The app is local-first for images: AACCard.tsx looks in `assets/kamus/{profile}`
 * BEFORE falling back to the remote ARASAAC URL in arasaac.json. To make the
 * expanded dictionary fully offline, download every pictogram into
 * `assets/kamus/umum/<filename>.png` (gender-neutral) — and optionally into
 * `pria` / `wanita` for gendered variants — then run:
 *     node scripts/sync-images.js
 * to regenerate src/assets/imageMap.ts.
 *
 * The filename convention (mirrors AACCard.tsx):
 *     `${word_id.toLowerCase().replace(/\s+/g, '_')}.png`
 *
 * Usage:
 *     node scripts/arasaac-download-manifest.js          -> prints a CSV
 *     node scripts/arasaac-download-manifest.js --json   -> prints JSON
 *     node scripts/arasaac-download-manifest.js --wget   -> prints a wget/curl script
 */
const fs = require('fs');
const path = require('path');

const words = require('../assets/data/arasaac.json');

const targetFilename = (word_id) => `${word_id.toLowerCase().replace(/\s+/g, '_')}.png`;

const rows = words.map((w) => ({
  id: w.id,
  word_id: w.word_id,
  category: w.categoryId,
  url: w.imageUrl,
  target: `assets/kamus/umum/${targetFilename(w.word_id)}`,
}));

const mode = process.argv[2] || '';

if (mode === '--json') {
  console.log(JSON.stringify(rows, null, 2));
} else if (mode === '--wget') {
  console.log('#!/usr/bin/env bash');
  console.log('# Download all ARASAAC pictograms for offline use (run from repo root).');
  console.log('mkdir -p assets/kamus/umum');
  for (const r of rows) {
    const name = targetFilename(r.word_id);
    console.log(`curl -fL -o "assets/kamus/umum/${name}" "${r.url}" || echo "FAILED ${r.id} ${r.word_id}"`);
  }
  console.log('echo "Done. Now run: node scripts/sync-images.js"');
} else {
  console.log('id,word_id,category,url,target');
  for (const r of rows) {
    console.log(`${r.id},"${r.word_id}",${r.category},${r.url},${r.target}`);
  }
}

console.error(`\n[manifest] ${rows.length} pictograms across ${new Set(rows.map(r => r.category)).size} categories.`);
console.error('[manifest] Download into assets/kamus/{pria,wanita,umum}, then run node scripts/sync-images.js');
