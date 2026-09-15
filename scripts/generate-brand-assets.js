#!/usr/bin/env node
/**
 * generate-brand-assets.js — Sensoria brand pipeline (single source of truth).
 *
 * WHY: the launcher/splash assets shipped before the brand scene redesign, so
 * devices showed a stale glyph (fills only ~43% of the canvas → "default icon"
 * look) and the splash duplicated a full-square scene. Everything below is
 * DERIVED from assets/icon.png (the official brand scene), so re-running this
 * script after a rebrand refreshes the whole set deterministically:
 *
 *   assets/android-icon-foreground.png  512²  scene tile @64.8% (Android 66% safe zone)
 *   assets/android-icon-background.png  512²  flat sky sampled from the scene
 *   assets/android-icon-monochrome.png  432²  white alpha mask (Android 13 themed icon)
 *   assets/splash-icon.png             1024²  transparent hero glyph @72% (Android 12+ circle mask)
 *   assets/favicon.png                   48²  web favicon
 *
 * The app.json expo-splash-screen plugin consumes the hero glyph on a brand
 * color (light sky / dark navy) for BOTH platforms — a glyph-in-circle native
 * splash hands off seamlessly to the in-app SplashGate overlay, which a
 * full-canvas image could never do (Android 12+ always masks the splash art
 * into a circle anyway).
 *
 * Layer sizing follows the Android Adaptive Icon guideline (content inside the
 * 66/108 diameter circle) — the previous stale glyph sat at ~43%, which read as
 * a tiny/default icon on the launcher.
 *
 * Usage: node scripts/generate-brand-assets.js
 */
const path = require('path');
const Jimp = require('jimp-compact');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'icon.png');

// Palette sampled from the brand scene itself (icon.png center sky).
const SKY = 0xe1f2fdff;

async function main() {
  const scene = await Jimp.read(SRC);
  if (scene.bitmap.width !== scene.bitmap.height) throw new Error('icon.png must be square');
  console.log(`source: assets/icon.png ${scene.bitmap.width}x${scene.bitmap.height}`);

  // 1 ── Android adaptive FOREGROUND (512², content 332 = 64.8% of canvas)
  const fg = new Jimp(512, 512, 0x0);
  fg.composite(scene.clone().resize(332, 332, Jimp.RESIZE_BICUBIC), (512 - 332) >> 1, (512 - 332) >> 1);
  await fg.writeAsync(path.join(ROOT, 'assets', 'android-icon-foreground.png'));

  // 2 ── Android adaptive BACKGROUND (512² flat sky — same dims as foreground)
  const bg = new Jimp(512, 512, SKY);
  await bg.writeAsync(path.join(ROOT, 'assets', 'android-icon-background.png'));

  // 3 ── Android 13+ THEMED (monochrome) icon: white alpha mask from luminance.
  //      Light pixels (sky/clouds/white banner text) become the glyph; dark
  //      elements are knocked out → a "sky & clouds" silhouette of the scene.
  const MONO = 432, M_CONTENT = 279; // 64.6% of canvas
  const src = scene.clone().resize(M_CONTENT, M_CONTENT, Jimp.RESIZE_BICUBIC).bitmap.data;
  const mono = new Jimp(MONO, MONO, 0x0);
  const od = mono.bitmap.data;
  const ox = (MONO - M_CONTENT) >> 1, oy = (MONO - M_CONTENT) >> 1;
  for (let y = 0; y < M_CONTENT; y++) {
    for (let x = 0; x < M_CONTENT; x++) {
      const si = (y * M_CONTENT + x) * 4;
      const sa = src[si + 3];
      if (sa < 10) continue;
      const lum = 0.299 * src[si] + 0.587 * src[si + 1] + 0.114 * src[si + 2];
      // smooth ramp: 0 below 154, 1 above 178 (soft edges, no jaggies)
      const mask = lum >= 178 ? 255 : lum <= 154 ? 0 : Math.round(((lum - 154) / 24) * 255);
      if (mask <= 0) continue;
      const di = ((y + oy) * MONO + (x + ox)) * 4;
      od[di] = 255; od[di + 1] = 255; od[di + 2] = 255;
      od[di + 3] = Math.min(255, Math.round((sa * mask) / 255));
    }
  }
  await mono.writeAsync(path.join(ROOT, 'assets', 'android-icon-monochrome.png'));

  // 4 ── Splash HERO glyph (1024² transparent, scene @72% → fills ~80% of the
  //      Android 12+ circular mask with breathing room; safe on iOS too).
  const hero = new Jimp(1024, 1024, 0x0);
  const heroSize = Math.round(1024 * 0.72);
  hero.composite(scene.clone().resize(heroSize, heroSize, Jimp.RESIZE_BICUBIC), (1024 - heroSize) >> 1, (1024 - heroSize) >> 1);
  await hero.writeAsync(path.join(ROOT, 'assets', 'splash-icon.png'));

  // 5 ── Web favicon (48² from the full scene)
  const fav = scene.clone().resize(48, 48, Jimp.RESIZE_BICUBIC);
  await fav.writeAsync(path.join(ROOT, 'assets', 'favicon.png'));

  console.log('✔ generated: android-icon-{foreground,background,monochrome}.png, splash-icon.png, favicon.png');
}

main().catch((e) => { console.error(e); process.exit(1); });
