/**
 * generate-audio-batch.js — batch-generate kamus audio (offline voice assets)
 * via Fish Audio TTS, one mp3 per (word × profile).
 *
 * Layout:  assets/audio/{profile}/{word_id}.mp3   (profile: pria|wanita|ayah|ibu)
 *          → key "{word}_{profile}" (implicit Indonesian), read by sync-audio.js.
 *
 * Behavior:
 *  • Skips words whose mp3 already exists (idempotent / resumable).
 *  • --limit N / --only "Word1,Word2" for a dry run slice.
 *  • Sequential with small delay to respect rate limits; on 429 waits & retries.
 *  • Failures are logged to scripts/audio-generate-report.json, never crash the run.
 *  • spoken text = word_id ( voz Fish Audio reference = EXPO_PUBLIC_VOICE_* env ).
 *
 * Usage:
 *   node scripts/generate-audio-batch.js --limit 3        # test slice
 *   node scripts/generate-audio-batch.js                  # full run (resumable)
 *   node scripts/generate-audio-batch.js --only "Saya,Makan"
 */
// Minimal .env loader (dotenv is not a repo dependency)
const fs = require('fs');
const path = require('path');
try {
  const envFile = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, '');
  }
} catch { /* no .env */ }
const AUDIO_DIR = path.join(__dirname, '../assets/audio');
const WORD_LIST = require('../assets/data/arasaac.json');
const REPORT = path.join(__dirname, 'audio-generate-report.json');

const API_KEY = process.env.EXPO_PUBLIC_FISH_AUDIO_API_KEY;
const PROFILES = [
  { dir: 'pria',   ref: process.env.EXPO_PUBLIC_VOICE_BOY,  male: true },
  { dir: 'wanita', ref: process.env.EXPO_PUBLIC_VOICE_GIRL, male: false },
  { dir: 'ayah',   ref: process.env.EXPO_PUBLIC_VOICE_DAD,  male: true },
  { dir: 'ibu',    ref: process.env.EXPO_PUBLIC_VOICE_MOM,  male: false },
];

// CLI flags
const args = process.argv.slice(2);
const getFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const LIMIT = parseInt(getFlag('--limit') || '0', 10);
const ONLY = getFlag('--only') ? getFlag('--only').split(',').map(s => s.trim()) : null;
const SPEED = parseFloat(getFlag('--speed') || '1.0', 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tts(text, referenceId, speed) {
  const res = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      model: 's2.1-pro-free',
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId,
      format: 'mp3',
      latency: 'normal',
      prosody: { speed, volume: 0, normalize_loudness: true },
    }),
  });
  if (!res.ok) {
    const err = new Error(`Fish Audio ${res.status} ${res.statusText}`);
    err.retryAfter = res.status === 429 ? 10 : res.status >= 500 ? 5 : 0;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`suspiciously small mp3 (${buf.length}B)`);
  return buf;
}

async function main() {
  if (!API_KEY) { console.error('EXPO_PUBLIC_FISH_AUDIO_API_KEY missing'); process.exit(2); }

  const words = ONLY
    ? WORD_LIST.filter(w => ONLY.includes(w.word_id))
    : WORD_LIST.map(w => ({ word_id: w.word_id }));
  const limited = LIMIT ? words.slice(0, LIMIT) : words;

  let done = 0, skipped = 0, failed = 0;
  const failures = [];
  const t0 = Date.now();

  for (const { word_id } of limited) {
    for (const prof of PROFILES) {
      if (!prof.ref) { console.error(`!! missing voice ref for ${prof.dir}`); process.exit(2); }
      const dir = path.join(AUDIO_DIR, prof.dir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${word_id}.mp3`);
      if (fs.existsSync(file) && fs.statSync(file).size > 1000) { skipped++; continue; }

      let buf = null, attempt = 0;
      while (!buf && attempt < 4) {
        attempt++;
        try { buf = await tts(word_id, prof.ref, SPEED); }
        catch (e) {
          const wait = (e.retryAfter || 5) * 1000 * attempt;
          console.warn(`retry ${attempt} for "${word_id}" (${prof.dir}) in ${wait / 1000}s: ${e.message}`);
          await sleep(wait);
        }
      }
      if (!buf) {
        failed++;
        failures.push({ word: word_id, profile: prof.dir });
        continue;
      }
      fs.writeFileSync(file, buf);
      done++;
      process.stdout.write(`\r✓ ${done} generated, ${skipped} skipped, ${failed} failed  `);
      await sleep(300); // polite pacing
    }
  }

  const report = {
    generated: done, skipped, failed,
    failures,
    duration_s: Math.round((Date.now() - t0) / 1000),
    date: new Date().toISOString(),
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\n📄 report → ${REPORT}`);
  if (failures.length) { console.log('FAILED items:', failures.map(f => `${f.word}/${f.profile}`).join(', ')); process.exit(1); }
}

main();
