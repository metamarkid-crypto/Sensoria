/**
 * render-kamus-png.js — rasterize scripts/kamus-art.js SVGs to PNG.
 *
 * Uses @resvg/resvg-js (native rasterizer, prebuilt binary — no browser needed).
 * Output: 150x220 transparent PNGs in assets/kamus/{pria,wanita}/.
 * Also writes a contact sheet (via resvg) for visual review.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { renderSVG, POSES } = require('./kamus-art');

const ROOT = path.join(__dirname, '..');
const OUT_DIRS = { pria: path.join(ROOT, 'assets', 'kamus', 'pria'), wanita: path.join(ROOT, 'assets', 'kamus', 'wanita') };

const WORDS = Object.keys(POSES);

(async () => {
  const made = [];
  for (const gender of ['pria', 'wanita']) {
    fs.mkdirSync(OUT_DIRS[gender], { recursive: true });
    for (const word of WORDS) {
      const svg = renderSVG(word, gender);
      const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: 150 },
        background: 'rgba(0,0,0,0)',
        font: { loadSystemFonts: false },
      });
      const png = resvg.render().asPng();
      const out = path.join(OUT_DIRS[gender], `${word}.png`);
      fs.writeFileSync(out, png);
      made.push(`${gender}/${word}.png`);
    }
  }

  // contact sheet (compose a big SVG embedding all PNGs as data URIs, then rasterize)
  const cellW = 150, cellH = 220, cols = 10;
  const rows = Math.ceil(made.length / cols);
  const pad = 6;
  const sheetW = cols * (cellW + pad) + pad;
  const sheetH = rows * (cellH + pad) + pad;
  const cells = made.map((rel, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const dataUri = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'assets', 'kamus', rel)).toString('base64')}`;
    const x = pad + col * (cellW + pad), y = pad + row * (cellH + pad);
    return `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="#F1F5F9" stroke="#CBD5E1"/><image x="${x}" y="${y}" width="${cellW}" height="${cellH}" href="${dataUri}"/><text x="${x + 4}" y="${y + 14}" font-family="sans-serif" font-size="11" fill="#334155" font-weight="bold">${rel}</text>`;
  }).join('\n');
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${sheetW}" height="${sheetH}" viewBox="0 0 ${sheetW} ${sheetH}"><rect width="${sheetW}" height="${sheetH}" fill="#FFFFFF"/>${cells}</svg>`;
  const sheetResvg = new Resvg(sheet, { fitTo: { mode: 'width', value: sheetW }, background: 'rgba(0,0,0,0)', font: { loadSystemFonts: true } });
  fs.writeFileSync(path.join(ROOT, 'scripts', 'kamus-contact-sheet.png'), sheetResvg.render().asPng());

  console.log(`OK: rendered ${made.length} PNGs + contact sheet (scripts/kamus-contact-sheet.png)`);
})().catch((e) => { console.error(e); process.exit(1); });
