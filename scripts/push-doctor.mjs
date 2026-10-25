#!/usr/bin/env node
/**
 * push-doctor — diagnosis rantai push notification langsung ke Supabase.
 *
 * Berbeda dari `verify-push-setup.mjs` (yang hanya membaca file repo), skrip ini
 * masuk ke database produksi dan memeriksa hal yang TIDAK bisa dilihat dari
 * source code:
 *
 *   1. tabel + kolom + RLS + policy token benar-benar ada di database;
 *   2. grant `anon` sesuai niat (INSERT/UPDATE/DELETE saja);
 *   3. trigger `messages_push_notify` terpasang pada public.messages;
 *   4. pg_net terpasang dan benar-benar bisa POST ke Expo Push API;
 *   5. ada/tidak token perangkat, dan berapa yang masih segar;
 *   6. balasan Expo terakhir (DeviceNotRegistered = token mati, dll).
 *
 * Pemakaian:
 *   node scripts/push-doctor.mjs              # periksa saja
 *   node scripts/push-doctor.mjs --send-test  # + kirim 1 push uji ke token nyata
 *
 * Membaca kredensial dari .env (EXPO_PUBLIC_SUPABASE_URL + DB_PASS).
 * Tidak pernah mencetak password maupun isi token.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

const SEND_TEST = process.argv.includes('--send-test');
const ROOT = process.cwd();

// ── util keluaran ──────────────────────────────────────────────────────────
let problems = 0;
const ok = (label, detail = '') => console.log(`  ✔ ${label}${detail ? ' — ' + detail : ''}`);
const bad = (label, detail = '') => {
  problems++;
  console.log(`  ✖ ${label}${detail ? ' — ' + detail : ''}`);
};
const warn = (label, detail = '') => console.log(`  ! ${label}${detail ? ' — ' + detail : ''}`);
const section = (t) => console.log(`\n${t}`);

const die = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

// ── konfigurasi ────────────────────────────────────────────────────────────
const readEnv = () => {
  let raw;
  try {
    raw = readFileSync(`${ROOT}/.env`, 'utf8');
  } catch {
    die('.env tidak ditemukan. Jalankan dari root repo.');
  }
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
      })
  );
};

const env = readEnv();
const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL || '';
const ref = (supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/) || [])[1];
if (!ref) die('EXPO_PUBLIC_SUPABASE_URL di .env bukan URL project Supabase.');
if (!env.DB_PASS) die('DB_PASS tidak ada di .env — skrip ini butuh password database.');

/**
 * Supabase memindahkan project ke region tertentu; host pooler berubah dan
 * tidak diekspos lewat API. Coba region yang umum, berhenti di yang berhasil.
 */
const REGIONS = [
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-south-1',
  'ap-northeast-1',
  'ap-northeast-2',
  'us-east-1',
  'us-west-1',
  'eu-central-1',
  'eu-west-1',
  'ca-central-1',
  'sa-east-1',
];

const connect = async () => {
  for (const region of REGIONS) {
    const c = new Client({
      host: `aws-0-${region}.pooler.supabase.com`,
      port: 6543,
      user: `postgres.${ref}`,
      password: env.DB_PASS,
      database: 'postgres',
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
      statement_timeout: 40000,
    });
    try {
      await c.connect();
      return c;
    } catch (e) {
      const msg = String(e.message);
      // "tenant/user not found" = region salah, lanjut. Selain itu = masalah nyata.
      if (!/not found|ENOTFOUND|ETIMEDOUT|ECONNREFUSED/.test(msg)) die(msg);
      try {
        await c.end();
      } catch {}
    }
  }
  die('Tidak bisa terhubung ke database Supabase (semua region pooler gagal).');
};

const db = await connect();

// ── 1. tabel & kolom ───────────────────────────────────────────────────────
section('1. Skema tabel token');
const tabel = await db.query(
  `select column_name from information_schema.columns
    where table_schema='public' and table_name='device_push_tokens'`
);
if (tabel.rows.length === 0) {
  bad('tabel device_push_tokens TIDAK ADA', 'jalankan migrasi 20261024_expo_push_notifications.sql');
} else {
  const cols = tabel.rows.map((r) => r.column_name);
  const wajib = ['token', 'device_id', 'role', 'platform', 'speak', 'language', 'updated_at'];
  const hilang = wajib.filter((c) => !cols.includes(c));
  if (hilang.length) bad('kolom kurang', hilang.join(', '));
  else ok('tabel + semua kolom ada');
}

// ── 2. RLS & grant ─────────────────────────────────────────────────────────
section('2. Keamanan (RLS + grant anon)');
const rls = await db.query(
  `select relrowsecurity from pg_class where oid = to_regclass('public.device_push_tokens')`
);
if (!rls.rows[0]?.relrowsecurity) bad('RLS tidak aktif', 'token perangkat bisa dibaca siapa pun');
else ok('RLS aktif');

const grant = await db.query(
  `select string_agg(privilege_type, ',' order by privilege_type) p
     from information_schema.role_table_grants
    where grantee='anon' and table_name='device_push_tokens'`
);
const privs = (grant.rows[0]?.p || '').split(',').filter(Boolean);
const berlebih = privs.filter((p) => !['INSERT', 'UPDATE', 'DELETE'].includes(p));
if (berlebih.length) {
  warn('anon punya hak ekstra', `${berlebih.join(', ')} — jalankan migrasi 20261025_push_hardening.sql`);
} else if (privs.length === 0) {
  bad('anon tidak punya hak apa pun', 'app tidak akan bisa mendaftarkan token');
} else {
  ok('grant anon minimal', privs.join(', '));
}

// Uji FUNGSIONAL, bukan sekadar membaca katalog: grant yang terlihat benar di
// information_schema bisa tetap gagal karena PostgreSQL mewajibkan SELECT pada
// kolom yang dibaca di WHERE. Inilah yang pernah mematahkan UPDATE/DELETE token.
const devUji = await db.query('select id from public.devices limit 1');
if (devUji.rows.length === 0) {
  warn('uji tulis dilewati', 'tabel devices kosong');
} else {
  const devId = devUji.rows[0].id;
  const asAnon = async (label, sql, params) => {
    await db.query('begin');
    try {
      await db.query('set local role anon');
      await db.query(sql, params);
      return { label, ok: true };
    } catch (e) {
      return { label, ok: false, err: e.message };
    } finally {
      await db.query('rollback');
    }
  };
  const cek = [
    await asAnon(
      'INSERT token',
      `insert into public.device_push_tokens (token,device_id,role,platform,speak,language,updated_at)
       values ('ExponentPushToken[doctor-probe-000]',$1,'Child','android',true,'id',now())`,
      [devId]
    ),
    await asAnon(
      'UPDATE speak',
      `update public.device_push_tokens set speak=false where token='ExponentPushToken[doctor-probe-000]'`
    ),
    await asAnon(
      'DELETE token',
      `delete from public.device_push_tokens where device_id=$1`,
      [devId]
    ),
  ];
  const gagal = cek.filter((r) => !r.ok);
  if (gagal.length) {
    for (const g of gagal) bad(`anon GAGAL ${g.label}`, g.err);
    console.log('    → app tidak bisa mendaftar/mematikan notifikasi. Jalankan migrasi hardening.');
  } else {
    ok('anon bisa insert/update/delete token (diuji nyata, di-rollback)');
  }
}

const policy = await db.query(
  `select polcmd from pg_policy where polrelid = to_regclass('public.device_push_tokens')`
);
const cmds = policy.rows.map((r) => r.polcmd).sort().join('');
if (cmds.includes('a') && cmds.includes('w') && cmds.includes('d')) ok('policy insert/update/delete ada');
else bad('policy tidak lengkap', `hanya: ${cmds || '(kosong)'}`);

// ── 3. trigger ─────────────────────────────────────────────────────────────
section('3. Trigger pengirim push');
const trig = await db.query(
  `select t.tgenabled, p.proname
     from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgname = 'messages_push_notify' and not t.tgisinternal`
);
if (trig.rows.length === 0) {
  bad('trigger messages_push_notify TIDAK ADA', 'tidak ada push sama sekali walau konfigurasi lain benar');
} else if (trig.rows[0].tgenabled === 'D') {
  bad('trigger ada tapi NONAKTIF', 'aktifkan dengan ALTER TRIGGER ... ENABLE');
} else {
  ok('trigger aktif', `memanggil ${trig.rows[0].proname}()`);
}

// ── 4. pg_net ──────────────────────────────────────────────────────────────
section('4. pg_net (HTTP dari SQL)');
const net = await db.query(`select 1 from pg_extension where extname='pg_net'`);
if (net.rows.length === 0) {
  bad('ekstensi pg_net tidak terpasang', 'trigger tidak bisa memanggil Expo');
} else {
  ok('pg_net terpasang');
  // Bukti nyata: POST ke Expo dengan token dummy. Tidak membangunkan perangkat
  // siapa pun; hanya memastikan jalur keluar + DNS + TLS hidup.
  const t0 = Date.now();
  const req = await db.query(
    `select net.http_post(
       url := 'https://exp.host/--/api/v2/push/send',
       body := $1::jsonb,
       headers := '{"Content-Type":"application/json","Accept":"application/json"}'::jsonb,
       timeout_milliseconds := 8000) as id`,
    [
      JSON.stringify([
        { to: 'ExponentPushToken[push-doctor-probe]', data: { kind: 'message', channelId: 'probe' } },
      ]),
    ]
  );
  const id = req.rows[0].id;
  let resp = null;
  for (let i = 0; i < 20 && !resp; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const q = await db.query(`select status_code, content::text c from net._http_response where id=$1`, [id]);
    if (q.rows.length) resp = q.rows[0];
  }
  if (!resp) bad('tidak ada balasan dari Expo dalam 20 detik');
  else if (resp.status_code !== 200) bad(`Expo membalas HTTP ${resp.status_code}`, resp.c.slice(0, 200));
  else ok('Expo Push API terjangkau', `HTTP 200 dalam ${Math.round((Date.now() - t0) / 1000)}s`);
}

// ── 5. token perangkat ─────────────────────────────────────────────────────
section('5. Token perangkat terdaftar');
const tokens = await db.query(
  `select role, speak, count(*)::int n,
          count(*) filter (where updated_at > now() - interval '7 days')::int segar
     from public.device_push_tokens group by role, speak order by role`
);
const total = tokens.rows.reduce((a, r) => a + r.n, 0);
if (total === 0) {
  bad('belum ada token', 'buka app versi baru di HP, izinkan notifikasi, lalu ulangi');
} else {
  for (const r of tokens.rows) {
    console.log(`    ${r.role.padEnd(7)} speak=${String(r.speak).padEnd(5)} ${r.n} token (${r.segar} segar 7 hari)`);
  }
  const anak = tokens.rows.filter((r) => r.role === 'Child').reduce((a, r) => a + r.n, 0);
  const ortu = tokens.rows.filter((r) => r.role === 'Parent').reduce((a, r) => a + r.n, 0);
  if (!anak) warn('tidak ada token perangkat ANAK', 'pesan orang tua tidak akan membangunkan HP anak');
  if (!ortu) warn('tidak ada token perangkat ORANG TUA', 'pesan anak tidak akan membangunkan HP orang tua');
  const basi = await db.query(
    `select count(*)::int n from public.device_push_tokens where updated_at < now() - interval '60 days'`
  );
  if (basi.rows[0].n > 0) warn(`${basi.rows[0].n} token tidak diperbarui >60 hari`, 'kemungkinan app sudah di-uninstall');
}

// ── 6. riwayat balasan Expo ────────────────────────────────────────────────
section('6. Riwayat pengiriman terakhir');
const hist = await db.query(
  `select status_code, left(content::text, 240) c, created
     from net._http_response order by id desc limit 5`
);
if (hist.rows.length === 0) {
  warn('belum ada riwayat', 'trigger belum pernah mengirim push');
} else {
  for (const r of hist.rows) {
    const waktu = new Date(r.created).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`    ${waktu} HTTP ${r.status_code} ${r.c.slice(0, 160)}`);
  }
}

// ── 7. kirim push uji nyata ────────────────────────────────────────────────
if (SEND_TEST) {
  section('7. Kirim push uji ke perangkat nyata');
  const target = await db.query(
    `select token, role, language from public.device_push_tokens
      where speak order by updated_at desc limit 2`
  );
  if (target.rows.length === 0) {
    bad('tidak ada token bersuara untuk diuji');
  } else {
    const payload = target.rows.map((t) => ({
      to: t.token,
      priority: 'high',
      _contentAvailable: true,
      data: {
        kind: 'message',
        channelId: 'doctor-test',
        messageTs: Date.now(),
        senderName: 'Sensoria Doctor',
        text: 'Ini pesan uji dari push-doctor.',
        voiceRole: t.role === 'Child' ? 'Parent' : 'Child',
        childReceiver: t.role === 'Child',
        speak: true,
        language: t.language,
      },
    }));
    const req = await db.query(
      `select net.http_post(
         url := 'https://exp.host/--/api/v2/push/send',
         body := $1::jsonb,
         headers := '{"Content-Type":"application/json","Accept":"application/json"}'::jsonb,
         timeout_milliseconds := 8000) as id`,
      [JSON.stringify(payload)]
    );
    let resp = null;
    for (let i = 0; i < 20 && !resp; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const q = await db.query(`select status_code, content::text c from net._http_response where id=$1`, [
        req.rows[0].id,
      ]);
      if (q.rows.length) resp = q.rows[0];
    }
    if (!resp) bad('tidak ada balasan Expo');
    else {
      const body = JSON.parse(resp.c);
      const tickets = body.data || [];
      tickets.forEach((t, i) => {
        if (t.status === 'ok') ok(`tiket ${i + 1} diterima Expo`, 'perangkat akan dibangunkan');
        else bad(`tiket ${i + 1} ditolak`, `${t.details?.error || t.message}`);
      });
      if (tickets.some((t) => t.details?.error === 'DeviceNotRegistered')) {
        console.log('\n  → DeviceNotRegistered: token itu sudah mati (app di-uninstall / data app dihapus).');
        console.log('    Buka app di perangkat tersebut; token baru akan didaftarkan otomatis.');
      }
    }
  }
}

// ── ringkasan ──────────────────────────────────────────────────────────────
console.log('');
if (problems === 0) {
  console.log('✔ Rantai push di sisi database SIAP.');
  console.log('  Yang masih di luar jangkauan skrip ini: kredensial FCM V1 di EAS');
  console.log('  (node scripts/upload-fcm-key.mjs --check) dan google-services.json di build.');
} else {
  console.log(`✖ ${problems} masalah ditemukan — lihat baris ✖ di atas.`);
}
await db.end();
process.exitCode = problems === 0 ? 0 : 1;
