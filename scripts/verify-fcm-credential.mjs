#!/usr/bin/env node
/**
 * verify-fcm-credential.mjs — buktikan service account Firebase benar-benar
 * berwenang mengirim lewat FCM HTTP v1.
 *
 * KENAPA ADA: `upload-fcm-key.mjs --check` hanya membuktikan EAS *menyimpan*
 * kunci. Ia tidak membuktikan Google menerima kunci itu. Kalau service account
 * tidak punya peran `firebase.messaging`/`cloudmessaging.messages.create`, push
 * tetap gagal 100% dan gejalanya baru muncul saat pengguna mengeluh.
 *
 * CARA KERJA: tanda tangani JWT RS256 dengan private_key, tukar ke access token
 * OAuth2 di token_uri, lalu kirim satu pesan ke token perangkat yang sengaja
 * tidak valid. Yang dinilai adalah KODE ERROR-nya, bukan pengirimanannya:
 *
 *   404 / UNREGISTERED   → kredensial SAH, hanya token perangkat yang tidak ada
 *   400 / INVALID_ARGUMENT → kredensial SAH (payload ditolak)
 *   401 / 403            → kredensial TIDAK berwenang (peran IAM kurang)
 *
 * Private key tidak pernah dicetak.
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keyPath = process.argv[2];

if (!keyPath) {
  console.error('Pakai: node scripts/verify-fcm-credential.mjs <path-ke-adminsdk-xxx.json>');
  process.exit(1);
}

const key = JSON.parse(readFileSync(resolve(process.cwd(), keyPath), 'utf8'));
for (const f of ['project_id', 'client_email', 'private_key', 'token_uri']) {
  if (!key[f]) {
    console.error(`✖ Bukan service account key yang valid (field "${f}" kosong).`);
    process.exit(1);
  }
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claims = b64url(
  JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  })
);

const signer = createSign('RSA-SHA256');
signer.update(`${header}.${claims}`);
const jwt = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;

console.log(`Project     : ${key.project_id}`);
console.log(`client_email: ${key.client_email}`);

const tokenRes = await fetch(key.token_uri, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }),
  signal: AbortSignal.timeout(20000),
});

if (!tokenRes.ok) {
  const body = await tokenRes.text();
  console.error(`✖ Gagal menukar JWT ke access token — HTTP ${tokenRes.status}`);
  console.error(`   ${body.slice(0, 300)}`);
  console.error('   Penyebab umum: private_key tidak cocok, atau jam sistem melenceng.');
  process.exit(1);
}

const { access_token: accessToken } = await tokenRes.json();
console.log('✔ access token OAuth2 didapat (kunci & jam sistem valid)');

// Token perangkat sengaja tidak valid — kita hanya membaca kode error.
const sendRes = await fetch(
  `https://fcm.googleapis.com/v1/projects/${key.project_id}/messages:send`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: 'sensoria-credential-probe-not-a-real-token',
        data: { probe: '1' },
      },
    }),
    signal: AbortSignal.timeout(20000),
  }
);

const text = await sendRes.text();
let errCode = '';
try {
  errCode = JSON.parse(text)?.error?.status || '';
} catch {
  /* biarkan kosong */
}

if (sendRes.status === 401 || sendRes.status === 403) {
  console.error(`✖ Kredensial DITOLAK FCM — HTTP ${sendRes.status} ${errCode}`);
  console.error(`   ${text.slice(0, 300)}`);
  console.error('   Beri service account peran Firebase Cloud Messaging API Admin');
  console.error('   (Firebase Console → Project settings → Service accounts → Cloud Messaging).');
  process.exit(1);
}

if (sendRes.status === 404 || sendRes.status === 400) {
  console.log(`✔ kredensial SAH — FCM menjawab HTTP ${sendRes.status} ${errCode}`);
  console.log('  (error ini hanya karena token perangkat uji memang tidak ada)');
  process.exit(0);
}

console.error(`? Jawaban tak terduga: HTTP ${sendRes.status} ${errCode}`);
console.error(`   ${text.slice(0, 300)}`);
process.exit(1);
