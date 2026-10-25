#!/usr/bin/env node
/**
 * upload-fcm-key.mjs — upload service account FCM V1 ke EAS TANPA prompt
 * interaktif `eas credentials`.
 *
 * KENAPA ADA: `npx eas credentials` adalah menu interaktif (Android →
 * production → Google Service Account → …). Di terminal non-interaktif, atau
 * saat mengikuti panduan langkah demi langkah, menu itu gampang salah pilih dan
 * hasilnya diam-diam `googleServiceAccountKeyForFcmV1: null` — push lalu gagal
 * walau google-services.json sudah benar. Skrip ini melakukan satu hal saja.
 *
 * PRASYARAT
 *   1. Sudah login: `npx eas-cli login` (sesi dibaca dari ~/.expo/state.json).
 *   2. Punya file private key dari Firebase Console:
 *      Project settings → Service accounts → Generate new private key.
 *      File itu berisi `private_key` — JANGAN commit, JANGAN kirim ke chat.
 *
 * PEMAKAIAN
 *   node scripts/upload-fcm-key.mjs --check
 *       # hanya melapor: project, package, dan apakah FCM V1 sudah terpasang
 *   node scripts/upload-fcm-key.mjs <path-ke-adminsdk-xxx.json>
 *       # upload + pasang ke application identifier id.sensoria.aac
 *
 * Tidak pernah mencetak isi private key — hanya client_email + project_id.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.expo.dev/graphql';

class Fatal extends Error {}

const fail = (msg) => {
  throw new Fatal(msg);
};

const main = async () => {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const keyPath = args.find((a) => !a.startsWith('--'));

  // ── konteks project ──────────────────────────────────────────────────────
  const appJson = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
  const expo = appJson.expo;
  const projectId = expo?.extra?.eas?.projectId;
  const applicationIdentifier = expo?.android?.package;
  if (!projectId) fail('app.json tidak punya extra.eas.projectId — jalankan `npx eas init` dulu.');
  if (!applicationIdentifier) fail('app.json tidak punya android.package.');

  // ── sesi Expo (sama seperti yang dipakai eas-cli) ────────────────────────
  const stateFile = join(homedir(), '.expo', 'state.json');
  let sessionSecret;
  try {
    sessionSecret = JSON.parse(readFileSync(stateFile, 'utf8'))?.auth?.sessionSecret;
  } catch {
    /* ditangani di bawah */
  }
  if (!sessionSecret) {
    fail(`Belum login EAS. Jalankan: npx eas-cli login\n   (sesi dibaca dari ${stateFile})`);
  }

  const gql = async (query, variables) => {
    // Timeout eksplisit: tanpa ini, jaringan yang memblokir DNS/HTTPS membuat
    // skrip menggantung tanpa batas dan pesannya hanya `fetch failed` — tidak
    // bisa dibedakan dari salah kredensial. 20 dtk cukup untuk GraphQL Expo.
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'expo-session': sessionSecret },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      const cause = e?.cause?.code || e?.cause?.message || e?.name || 'tidak diketahui';
      fail(
        `Tidak bisa menghubungi api.expo.dev (${cause}).\n` +
          '   Ini masalah jaringan, bukan kredensial. Cek: DNS (nslookup api.expo.dev), ' +
          'proxy/firewall yang memblokir HTTPS, atau mode offline.'
      );
    }
    if (!res.ok) {
      fail(`api.expo.dev menjawab HTTP ${res.status} ${res.statusText} — sesi EAS mungkin kedaluwarsa (npx eas-cli login).`);
    }
    const json = await res.json();
    if (json.errors?.length) fail(json.errors.map((e) => e.message).join('; '));
    return json.data;
  };

  // ── 1. cari app + android credentials untuk package kita ─────────────────
  const lookup = await gql(
    `query ($projectId: String!) {
       app {
         byId(appId: $projectId) {
           id
           slug
           fullName
           ownerAccount { id name }
           androidAppCredentials {
             id
             applicationIdentifier
             googleServiceAccountKeyForFcmV1 { id clientEmail projectIdentifier }
           }
         }
       }
     }`,
    { projectId }
  );

  const app = lookup?.app?.byId;
  if (!app) fail(`Project ${projectId} tidak ditemukan / tidak bisa diakses akun ini.`);

  console.log(`Project : ${app.fullName} (${app.id})`);
  console.log(`Package : ${applicationIdentifier}`);

  let creds = (app.androidAppCredentials || []).find(
    (c) => c.applicationIdentifier === applicationIdentifier
  );

  if (!creds) {
    if (checkOnly) fail('Belum ada credential Android untuk package ini (jalankan tanpa --check).');
    console.log('… application identifier belum ada di EAS, membuat baru');
    const created = await gql(
      `mutation ($appId: ID!, $applicationIdentifier: String!) {
         androidAppCredentials {
           createAndroidAppCredentials(
             appId: $appId
             applicationIdentifier: $applicationIdentifier
             androidAppCredentialsInput: {}
           ) { id applicationIdentifier }
         }
       }`,
      { appId: app.id, applicationIdentifier }
    );
    creds = created?.androidAppCredentials?.createAndroidAppCredentials;
    if (!creds) fail('Gagal membuat androidAppCredentials.');
    console.log(`✔ credential dibuat: ${creds.id}`);
  }

  const current = creds.googleServiceAccountKeyForFcmV1;
  if (current) {
    console.log(
      `✔ FCM V1 sudah terpasang — client_email: ${current.clientEmail || '(?)'}, ` +
        `project: ${current.projectIdentifier || '(?)'}`
    );
  } else {
    console.log('✖ FCM V1 BELUM terpasang — Expo tidak bisa mengirim push ke Android.');
  }

  if (checkOnly) {
    process.exitCode = current ? 0 : 1;
    return;
  }

  if (!keyPath) {
    console.log('');
    console.log('Pakai: node scripts/upload-fcm-key.mjs <path-ke-adminsdk-xxx.json>');
    console.log('   atau: node scripts/upload-fcm-key.mjs --check');
    process.exitCode = current ? 0 : 1;
    return;
  }

  // ── 2. validasi file key SEBELUM dikirim ────────────────────────────────
  const fullKeyPath = resolve(process.cwd(), keyPath);
  let key;
  try {
    key = JSON.parse(readFileSync(fullKeyPath, 'utf8'));
  } catch (e) {
    fail(`Tidak bisa membaca ${fullKeyPath}: ${e.message}`);
  }
  for (const field of ['type', 'project_id', 'private_key', 'client_email', 'token_uri']) {
    if (!key[field]) fail(`File itu bukan service account key yang valid (field "${field}" kosong).`);
  }
  if (key.type !== 'service_account') fail(`type = "${key.type}", harus "service_account".`);
  console.log(`Key     : ${key.client_email} → project ${key.project_id}`);
  console.log('          (isi private_key TIDAK dicetak)');

  // ── 3. upload ke akun, lalu pasang ke app credentials ───────────────────
  const uploaded = await gql(
    `mutation ($accountId: ID!, $jsonKey: JSONObject!) {
       googleServiceAccountKey {
         createGoogleServiceAccountKey(
           accountId: $accountId
           googleServiceAccountKeyInput: { jsonKey: $jsonKey }
         ) { id clientEmail projectIdentifier }
       }
     }`,
    { accountId: app.ownerAccount.id, jsonKey: key }
  );
  const createdKey = uploaded?.googleServiceAccountKey?.createGoogleServiceAccountKey;
  if (!createdKey?.id) fail('Upload service account key gagal (tidak ada id yang dikembalikan).');
  console.log(`✔ key terunggah: ${createdKey.id} (${createdKey.clientEmail})`);

  const attached = await gql(
    `mutation ($id: ID!, $googleServiceAccountKeyId: ID!) {
       androidAppCredentials {
         setGoogleServiceAccountKeyForFcmV1(
           id: $id
           googleServiceAccountKeyId: $googleServiceAccountKeyId
         ) { id googleServiceAccountKeyForFcmV1 { id clientEmail projectIdentifier } }
       }
     }`,
    { id: creds.id, googleServiceAccountKeyId: createdKey.id }
  );

  const attachedKey =
    attached?.androidAppCredentials?.setGoogleServiceAccountKeyForFcmV1?.googleServiceAccountKeyForFcmV1;
  if (!attachedKey) fail('Gagal memasang key ke application identifier.');
  console.log(`✔ FCM V1 terpasang untuk ${applicationIdentifier}: ${attachedKey.clientEmail}`);
  console.log('');
  console.log('Selesai. Langkah berikutnya: kirim 1 pesan uji dari perangkat anak');
  console.log('(app harus versi yang dibangun DENGAN google-services.json).');
};

main().catch((e) => {
  // SEMUA kegagalan harus terlihat. Sebelumnya Fatal ditelan diam-diam,
  // sehingga file key yang salah format hanya menghasilkan exit 1 tanpa
  // penjelasan apa pun.
  console.error(`✖ ${e?.message || e}`);
  process.exitCode = 1;
});
