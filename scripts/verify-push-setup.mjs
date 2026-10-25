#!/usr/bin/env node
/**
 * verify-push-setup.mjs — memeriksa konfigurasi push notification di repo INI.
 *
 * Yang diuji adalah hal-hal yang tidak bisa dilihat `tsc` dan tidak akan
 * ketahuan sampai build di-upload ke Play Store:
 *
 *   1. google-services.json ada, JSON valid, dan package_name-nya SAMA dengan
 *      `android.package` (kalau beda, FCM menolak token: SENDER_ID_MISMATCH);
 *   2. `extra.eas.projectId` ada (getExpoPushTokenAsync butuh ini);
 *   3. kedua workflow build menyuntikkan GOOGLE_SERVICES_JSON SEBELUM prebuild
 *      (kalau sesudahnya, file diabaikan dan AAB/APK tanpa push);
 *   4. app.json vs app.playstore.json sinkron versi (dicek juga oleh CI);
 *   5. ikon notifikasi Android ada dan berukuran wajar;
 *   6. migrasi SQL push ada dan memuat trigger + tabel token.
 *
 * Pemakaian:
 *   node scripts/verify-push-setup.mjs          # gagal (exit 1) bila ada masalah
 *   node scripts/verify-push-setup.mjs --warn   # masalah jadi peringatan saja
 *
 * File ini TIDAK mem-print isi kunci Firebase (api_key) — hanya nama project
 * dan package, karena output ini sering ditempel ke chat/issue.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WARN_ONLY = process.argv.includes('--warn');

let failures = 0;
let warnings = 0;

const ok = (msg) => console.log(`PASS ${msg}`);
const bad = (msg, hint) => {
  failures += 1;
  console.log(`FAIL ${msg}`);
  if (hint) console.log(`     → ${hint}`);
};
const warn = (msg, hint) => {
  warnings += 1;
  console.log(`WARN ${msg}`);
  if (hint) console.log(`     → ${hint}`);
};

const readJson = (rel) => {
  try {
    return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  } catch {
    return null;
  }
};

// ── 1. app config ────────────────────────────────────────────────────────────
const appJson = readJson('app.json');
const playJson = readJson('app.playstore.json');
const expo = appJson?.expo;
if (!expo) {
  bad('app.json tidak bisa dibaca / tidak punya key "expo"');
} else {
  ok('app.json terbaca');
}

const pkg = expo?.android?.package;
const projectId = expo?.extra?.eas?.projectId;

if (projectId && /^[0-9a-f-]{36}$/i.test(projectId)) {
  ok(`extra.eas.projectId ada (${projectId})`);
} else {
  bad(
    'extra.eas.projectId tidak ada di app.json',
    'Tanpa ini getExpoPushTokenAsync() gagal dan tidak ada token yang terdaftar. ' +
      'Jalankan: npx eas init'
  );
}

// ── 2. google-services.json ──────────────────────────────────────────────────
const gsPath = join(ROOT, 'google-services.json');
if (!existsSync(gsPath)) {
  warn(
    'google-services.json tidak ada di root repo',
    'Build LOKAL tanpa file ini tetap jalan tapi push mati. Untuk CI, isi secret ' +
      'GOOGLE_SERVICES_JSON (Settings → Secrets → Actions) dengan isi file dari ' +
      'Firebase Console → Project settings → Android app → google-services.json'
  );
} else {
  let gs = null;
  try {
    gs = JSON.parse(readFileSync(gsPath, 'utf8'));
  } catch (e) {
    bad('google-services.json bukan JSON valid', String(e.message));
  }
  if (gs) {
    const clients = Array.isArray(gs.client) ? gs.client : [];
    const packages = clients
      .map((c) => c?.client_info?.android_client_info?.package_name)
      .filter(Boolean);
    const projectNumber = gs?.project_info?.project_number;
    const projectName = gs?.project_info?.project_id;

    ok(
      `google-services.json valid — project ${projectName || '?'} (${projectNumber || '?'}), ` +
        `${packages.length} app Android`
    );

    if (!packages.length) {
      bad(
        'google-services.json tidak punya app Android',
        'Tambahkan app Android dengan package id.sensoria.aac di Firebase Console'
      );
    } else if (!packages.includes(pkg)) {
      bad(
        `package_name di google-services.json (${packages.join(', ')}) ≠ android.package (${pkg})`,
        'FCM akan menolak token perangkat ini (SENDER_ID_MISMATCH). Hapus app lama di ' +
          'Firebase Console, daftarkan ulang dengan package yang PERSIS sama, unduh ulang.'
      );
    } else {
      ok(`package_name cocok dengan android.package (${pkg})`);
    }

    if (!projectNumber) {
      bad('google-services.json tanpa project_info.project_number');
    }
  }
}

// ── 3. workflow build menyuntikkan FCM sebelum prebuild ─────────────────────
const checkWorkflow = (rel) => {
  const full = join(ROOT, rel);
  if (!existsSync(full)) return warn(`${rel} tidak ada`);
  const text = readFileSync(full, 'utf8');

  if (!text.includes('GOOGLE_SERVICES_JSON')) {
    return bad(
      `${rel} tidak memasang GOOGLE_SERVICES_JSON`,
      'Artifact dari workflow ini TIDAK bisa menerima push saat app ditutup. ' +
        'Salin langkah "Pasang google-services.json (FCM)" dari workflow lain.'
    );
  }

  const idxSecret = text.indexOf('GOOGLE_SERVICES_JSON');
  const idxPrebuild = text.indexOf('expo prebuild');
  if (idxPrebuild === -1) {
    return warn(`${rel}: tidak menemukan langkah "expo prebuild" untuk dibandingkan`);
  }
  if (idxSecret > idxPrebuild) {
    return bad(
      `${rel}: google-services.json ditulis SETELAH expo prebuild`,
      'Prebuild menyalin file ke android/app/; kalau file datang sesudahnya, FCM ' +
        'tidak terkonfigurasi di build itu. Pindahkan langkahnya ke ATAS prebuild.'
    );
  }
  ok(`${rel}: FCM dipasang sebelum prebuild`);
};
checkWorkflow('.github/workflows/android-build.yml');
checkWorkflow('.github/workflows/android-aab.yml');

// ── 4. versi app.json vs app.playstore.json ─────────────────────────────────
if (expo && playJson?.expo) {
  const p = playJson.expo;
  if (expo.version === p.version && expo.android?.versionCode === p.android?.versionCode) {
    ok(`versi sinkron: ${expo.version} (versionCode ${expo.android?.versionCode})`);
  } else {
    bad(
      `versi TIDAK sinkron: app.json ${expo.version}/${expo.android?.versionCode} vs ` +
        `app.playstore.json ${p.version}/${p.android?.versionCode}`,
      'Workflow AAB akan menolak build. Bump keduanya bersamaan.'
    );
  }

  // Plugin expo-notifications harus ada di KEDUA config, kalau tidak AAB Play
  // kehilangan ikon/channel default.
  for (const [name, cfg] of [
    ['app.json', expo],
    ['app.playstore.json', p],
  ]) {
    const plugins = (cfg.plugins || []).map((x) => (Array.isArray(x) ? x[0] : x));
    if (plugins.includes('expo-notifications')) {
      ok(`${name}: plugin expo-notifications terpasang`);
    } else {
      bad(`${name}: plugin expo-notifications hilang`, 'Tambahkan ke array plugins.');
    }
  }
}

// ── 5. ikon notifikasi Android ──────────────────────────────────────────────
const iconRel = (() => {
  const entry = (expo?.plugins || []).find(
    (x) => Array.isArray(x) && x[0] === 'expo-notifications'
  );
  return entry?.[1]?.icon;
})();
if (!iconRel) {
  warn('expo-notifications tanpa opsi "icon"', 'Android memakai ikon app (kotak putih).');
} else {
  const iconFull = join(ROOT, iconRel.replace(/^\.\//, ''));
  if (!existsSync(iconFull)) {
    bad(`ikon notifikasi tidak ditemukan: ${iconRel}`);
  } else {
    const buf = readFileSync(iconFull);
    const isPng = buf.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!isPng) {
      bad(`ikon notifikasi bukan PNG: ${iconRel}`);
    } else {
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      if (w !== h) {
        warn(`ikon notifikasi tidak persegi (${w}×${h})`, 'Android memotongnya jadi lingkaran/kotak.');
      } else if (w < 96) {
        warn(`ikon notifikasi kecil (${w}×${h})`, 'Rekomendasi 96×96 atau 192×192.');
      } else {
        ok(`ikon notifikasi ${w}×${h} PNG`);
      }
    }
  }
}

// ── 6. migrasi SQL push ─────────────────────────────────────────────────────
const migrationRel = 'supabase/migrations/20261024_expo_push_notifications.sql';
const migrationFull = join(ROOT, migrationRel);
if (!existsSync(migrationFull)) {
  bad(`migrasi tidak ada: ${migrationRel}`);
} else {
  const sql = readFileSync(migrationFull, 'utf8');
  const need = [
    ['CREATE TABLE IF NOT EXISTS public.device_push_tokens', 'tabel token'],
    ['notify_message_push', 'fungsi trigger'],
    ['messages_push_notify', 'trigger pada messages'],
    ['pg_net', 'ekstensi HTTP async'],
    ['exp.host', 'endpoint Expo Push'],
  ];
  const missing = need.filter(([needle]) => !sql.includes(needle)).map(([, label]) => label);
  if (missing.length) {
    bad(`migrasi push kurang bagian: ${missing.join(', ')}`);
  } else {
    ok('migrasi push lengkap (tabel + trigger + pg_net + endpoint Expo)');
  }
}

// ── ringkasan ───────────────────────────────────────────────────────────────
console.log('');
if (failures === 0 && warnings === 0) {
  console.log('OK — konfigurasi push lengkap di repo ini.');
  console.log('Langkah berikutnya yang TIDAK bisa dicek dari sini:');
  console.log('  • service account FCM V1 sudah di-upload ke EAS (npx eas credentials)');
  console.log('  • migrasi SQL sudah dijalankan di Supabase');
  console.log('  • ada token di tabel device_push_tokens (lihat scripts/check-push-setup.sql)');
} else if (failures === 0) {
  console.log(`OK dengan ${warnings} peringatan — push tetap bisa jalan.`);
} else {
  console.log(`${failures} masalah, ${warnings} peringatan.`);
  if (WARN_ONLY) {
    console.log('(--warn: exit 0)');
    process.exit(0);
  }
  process.exit(1);
}
