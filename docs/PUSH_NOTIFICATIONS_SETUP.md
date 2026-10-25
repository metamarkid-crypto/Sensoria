# Push Notification Sensoria — Panduan Lengkap (Android)

Panduan ini menuntun dari nol sampai pesan AAC berbunyi **saat aplikasi ditutup
total**. Ditulis berdasarkan kondisi repo ini per 24 Oktober 2026 — bukan
teori. Setiap langkah punya cara memverifikasi bahwa langkah itu benar.

> **Batas jujur di depan:** push tidak akan pernah "pasti" sampai. Android
> membatasi data-only FCM lewat Doze/App Standby, dan OEM agresif
> (Xiaomi/Oppo/Vivo/Realme) bisa memblokirnya sampai pengguna memberi izin
> "autostart" + "baterai: tanpa batas". Yang bisa kita jamin: kalau izin itu
> diberikan dan perangkat online, pesan masuk dan dibacakan.

---

## 1. Arsitektur: kenapa butuh 4 komponen

Notifikasi Realtime (`supabase.channel`) hanya hidup selama proses JS hidup.
Saat app di-swipe, tidak ada yang mendengar `INSERT messages`. Jadi ada 4
komponen yang harus lengkap:

| # | Komponen | Fungsi | Di mana |
|---|---|---|---|
| 1 | **Token perangkat** | App mendaftarkan Expo Push Token ke tabel `device_push_tokens` | `src/services/notifications/pushTokens.ts` |
| 2 | **Trigger SQL** | `AFTER INSERT` pada `messages` → panggil Expo Push API via `pg_net` | `supabase/migrations/20261024_expo_push_notifications.sql` |
| 3 | **Kredensial FCM V1** | Expo butuh service account Firebase untuk bicara ke FCM | EAS dashboard / `eas credentials` |
| 4 | **google-services.json di APK** | Tanpa ini `getExpoPushTokenAsync()` gagal → tidak ada token | `app.config.js` + secret CI |

Kalau **satu** saja hilang, gejalanya sama: "tidak ada notifikasi". Karena itu
langkah verifikasi di bawah memeriksa keempatnya satu per satu.

Alur lengkap saat app mati:

```
anak kirim pesan
   → INSERT public.messages
   → trigger messages_push_notify
   → pg_net POST https://exp.host/--/api/v2/push/send
   → FCM → perangkat (data-only, tanpa title/body)
   → OS bangunkan proses JS headless
   → pushTask.ts: parse payload → TTS profil suara pengirim → banner senyap
```

Payload sengaja **data-only** supaya OS tidak menampilkan banner bersuara
sendiri (bunyi ganda). App yang bicara, lalu menampilkan banner senyap.

---

## 2. Cek dulu: apa yang sudah beres di repo ini

```bash
node scripts/verify-push-setup.mjs
```

Hasil pada repo ini (24 Okt 2026) — semua PASS:

```
PASS app.json terbaca
PASS extra.eas.projectId ada (aa1cfb2b-48ce-46c5-8fed-8f170a7cb3d9)
PASS google-services.json valid — project sensoria-dac4b (635041984017), 1 app Android
PASS package_name cocok dengan android.package (id.sensoria.aac)
PASS .github/workflows/android-build.yml: FCM dipasang sebelum prebuild
PASS .github/workflows/android-aab.yml: FCM dipasang sebelum prebuild
PASS versi sinkron: 1.0.16 (versionCode 16)
PASS app.json: plugin expo-notifications terpasang
PASS app.playstore.json: plugin expo-notifications terpasang
PASS ikon notifikasi 96×96 PNG
PASS migrasi push lengkap (tabel + trigger + pg_net + endpoint Expo)
```

Skrip ini menangkap tiga bug yang tidak terlihat dari `tsc`:

- **`package_name` di google-services.json beda dengan `android.package`** →
  FCM menolak token (`SENDER_ID_MISMATCH`), dan gejalanya cuma "token null".
- **Langkah CI menulis google-services.json SETELAH `expo prebuild`** →
  prebuild tidak menyalinnya ke `android/app/`, jadi AAB Play Store tanpa FCM.
  Ini bug nyata yang sudah diperbaiki di `android-aab.yml`.
- **`app.json` vs `app.playstore.json` beda versi** → workflow AAB menolak
  build sebelum sempat menguji push.

---

## 3. Langkah 1 — Firebase (sudah selesai)

Yang sudah dilakukan: project Firebase `sensoria-dac4b`, app Android
`id.sensoria.aac`, file `google-services.json` di root repo.

Verifikasi cepat tanpa membuka Firebase:

```bash
node -e "const g=require('./google-services.json'),a=require('./app.json').expo;
console.log('project:', g.project_info.project_id);
console.log('package cocok:', g.client[0].client_info.android_client_info.package_name === a.android.package)"
```

Harus keluar `package cocok: true`. Kalau `false`, **jangan lanjut** — hapus app
lama di Firebase Console (Settings → Your apps → Remove this app), daftarkan
ulang dengan package `id.sensoria.aac`, unduh ulang.

`google-services.json` sudah ada di `.gitignore` (baris 81) — **jangan** commit.
CI menyuntikkannya dari secret.

### Secret GitHub

Settings → Secrets and variables → Actions → **New repository secret**:

| Nama | Isi |
|---|---|
| `GOOGLE_SERVICES_JSON` | seluruh isi file `google-services.json` |

Dipakai oleh dua workflow: `android-build.yml` (APK GitHub Releases) dan
`android-aab.yml` (AAB Play Store). Keduanya menulis file itu **sebelum**
`expo prebuild`, lalu memvalidasi JSON-nya.

### Sidik jari SHA (SHA certificate fingerprints)

Di Firebase Console, kartu app **AAC Sensoria** menampilkan "SHA certificate
fingerprints" **kosong**. Itu **tidak** memblokir push: FCM HTTP v1 memakai
service account, bukan sidik jari APK. Yang terpengaruh kalau dibiarkan kosong
adalah fitur berbasis identitas app — Google Sign-In, App Check, Dynamic Links,
dan pembatasan API key Google Maps per-app (Android app restriction).

Ambil sidik jarinya tanpa perlu JDK/`keytool`:

```bash
npm run push:sha1                 # keystore release + debug.keystore
node scripts/android-sha1.mjs x.jks  # atau satu file tertentu
```

Hasil terverifikasi untuk repo ini (dicek ulang independen lewat `openssl x509
-fingerprint`, hasilnya identik):

| Keystore | SHA-1 |
|---|---|
| `@metamark__Sensoria.jks` (release, dipakai APK + AAB) | `34:96:41:F6:8B:C1:75:8D:61:E8:33:92:03:83:98:46:90:7D:A2:65` |
| `android/app/debug.keystore` (build debug lokal) | `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25` |

Tempel keduanya di Firebase → Project settings → Your apps → **Add fingerprint**.

> **Kalau nanti pakai Play App Signing:** Google menandatangani ulang AAB dengan
> *app signing key* miliknya, jadi sidik jari APK yang beredar dari Play
> **berbeda** dari keystore repo di atas. Ambil yang benar di Play Console →
> Release → Setup → App signing → *SHA-1 certificate fingerprint*, lalu tambahkan
> juga di Firebase. Selama belum rilis lewat Play, cukup dua baris tabel di atas.

---

## 4. Langkah 2 — Service account FCM V1 ke EAS (SUDAH SELESAI)

Status terverifikasi untuk project ini:

```bash
npm run push:fcm    # ✔ FCM V1 terpasang — firebase-adminsdk-fbsvc@sensoria-dac4b.iam.gserviceaccount.com
node scripts/verify-fcm-credential.mjs <file-adminsdk>.json
                    # ✔ OAuth2 OK → FCM jawab 400 INVALID_ARGUMENT = kredensial SAH
```

Baris kedua penting: `push:fcm` hanya membuktikan EAS **menyimpan** kunci.
Skrip kedua membuktikan Google **menerimanya**. Kalau kelak kunci dirotasi,
jalankan keduanya lagi — 401/403 di skrip kedua berarti peran IAM kurang.

Bagian di bawah tetap disimpan sebagai rujukan bila perlu upload ulang.

Ini bagian yang **belum selesai** di project Anda. Saya cek langsung ke API
Expo, dan hasilnya:

```
Project : @metamark/Sensoria (aa1cfb2b-48ce-46c5-8fed-8f170a7cb3d9)
Package : id.sensoria.aac
✖ FCM V1 BELUM terpasang — Expo tidak bisa mengirim push ke Android.
```

Artinya: `google-services.json` **tidak cukup**. File itu hanya membuat app bisa
meminta token. Untuk benar-benar *mengirim* push, server Expo butuh service
account Firebase (kunci berbeda, berisi `private_key`).

### 4a. Unduh service account key dari Firebase

1. Firebase Console → project **Sensoria** → ⚙️ **Project settings**.
2. Tab **Service accounts**.
3. Klik **Generate new private key** → **Generate key**.
4. File `sensoria-dac4b-firebase-adminsdk-xxxxx-xxxxxxxxxx.json` terunduh.

⚠️ File ini **rahasia**. Jangan commit, jangan tempel di chat, jangan simpan di
folder repo. Simpan di luar project (mis. `D:\secrets\`).

### 4b. Upload ke EAS

Dua cara — pilih satu.

**Cara A (skrip repo ini, tanpa menu interaktif):**

```bash
# cek status dulu
node scripts/upload-fcm-key.mjs --check

# upload + pasang ke id.sensoria.aac
node scripts/upload-fcm-key.mjs "D:\secrets\sensoria-dac4b-firebase-adminsdk-xxxxx.json"
```

Skrip ini memvalidasi file (harus `type: service_account`, ada `private_key`,
`project_id`, `client_email`), mengunggah ke akun `metamark`, lalu memasangnya
ke application identifier `id.sensoria.aac`. Ia **tidak pernah** mencetak isi
private key — hanya `client_email` dan `project_id`.

**Cara B (menu resmi EAS):**

```bash
npx eas-cli credentials --platform android
```

Lalu: **production** → **Google Service Account** →
**Manage your Google Service Account Key for Push Notifications (FCM V1)** →
**Set up** → **Upload a new service account key** → pilih file JSON tadi →
**Y** saat ditanya menyimpan.

> Kalau diminta memilih project (`metamark` vs `metamarks-team`), pilih
> **metamark** — project `Sensoria` ada di sana.

### 4c. Verifikasi

```bash
node scripts/upload-fcm-key.mjs --check
```

Harus berubah jadi:

```
✔ FCM V1 sudah terpasang — client_email: firebase-adminsdk-...@sensoria-dac4b.iam.gserviceaccount.com, project: sensoria-dac4b
```

Kalau masih `BELUM terpasang`, jangan lanjut ke build — push pasti gagal dan
gejalanya tidak jelas.

### 4d. Enhanced Push Security (biarkan OFF)

Saya juga cek `pushSecurityEnabled` untuk project ini: **false**. Itu bagus
untuk sekarang — kalau dinyalakan, trigger SQL harus mengirim header
`Authorization: Bearer <access token>` dan push akan balas **401**. Kalau nanti
Anda menyalakannya di dashboard Expo, ingat bahwa trigger di migrasi ini belum
mengirim header tersebut.

---

## 5. Langkah 3 — Jalankan migrasi SQL di Supabase

1. Supabase Dashboard → project Anda → **SQL Editor** → **New query**.
2. Buka [supabase/migrations/20261024_expo_push_notifications.sql](../supabase/migrations/20261024_expo_push_notifications.sql).
3. Salin **seluruh** isinya, tempel, **Run**.

Migrasi ini idempoten (`IF NOT EXISTS` / `CREATE OR REPLACE`) — aman dijalankan
ulang kalau ragu.

Yang dibuatnya:

- ekstensi `pg_net` (HTTP async dari SQL);
- tabel `device_push_tokens` (token, device_id, role, platform, `speak`, `language`);
- RLS + policy insert/update/delete untuk `anon` (tanpa SELECT — token perangkat
  lain tidak boleh bocor);
- fungsi `notify_message_push()` + trigger `messages_push_notify`.

### Verifikasi

Buka [scripts/check-push-setup.sql](../scripts/check-push-setup.sql), tempel di
SQL Editor yang sama, **Run**. Keluarannya tabel 11 baris. Yang harus `OK`:
baris 1–6. Baris 7 (`token terdaftar`) masih boleh `BELUM ADA` sebelum app
dijalankan.

Contoh keluaran sehat setelah semuanya jalan:

```
1  pg_net terpasang                  OK — HTTP async dari SQL tersedia
2  tabel device_push_tokens          OK — tabel ada
3  kolom device_push_tokens          OK — token · device_id · role · platform · speak · language · updated_at
4  RLS + policy token                OK — RLS aktif, 3 policy (insert/update/delete)
5  trigger messages_push_notify      OK — AFTER INSERT pada public.messages
6  fungsi notify_message_push        OK — fungsi ada
7  token terdaftar                   OK — 2 token (2 bersuara, 1 anak / 1 orang tua, 2 aktif 7 hari)
```

Kalau baris 5 `GAGAL`, trigger tidak ada → **tidak ada push sama sekali**,
seberapa pun benar konfigurasi Firebase-nya.

### 5b. Migrasi hardening (jalankan setelah migrasi utama)

Jalankan juga
[supabase/migrations/20261025_push_hardening.sql](../supabase/migrations/20261025_push_hardening.sql).
Ini **bukan** kosmetik — audit database produksi menemukan dua hal:

```
grant anon pada device_push_tokens:
  DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
```

`GRANT INSERT, UPDATE, DELETE` di migrasi utama **tidak** membatasi apa pun,
karena Supabase memasang *default privileges* di schema `public` yang otomatis
memberi `ALL` ke `anon` untuk setiap tabel baru. Jadi komentar "tidak ada
SELECT" di migrasi itu tidak benar di level GRANT.

Data belum bocor: RLS aktif dan tidak ada policy `SELECT`, sehingga
`set role anon; select count(*) from device_push_tokens` mengembalikan **0**
(sudah diuji di produksi). Tapi `TRUNCATE` tidak tunduk pada RLS, dan menutup
celah itu murah. Migrasi ini juga mencabut `EXECUTE` untuk `PUBLIC` pada fungsi
`notify_message_push()` — fungsi itu `SECURITY DEFINER`, jadi tidak seharusnya
bisa dipanggil klien secara langsung.

> **Jebakan yang sudah terverifikasi (jangan diulang):** mencabut `SELECT`
> sepenuhnya **mematahkan app**. PostgreSQL mewajibkan privilege `SELECT` pada
> setiap kolom yang dibaca di klausa `WHERE`, termasuk untuk `UPDATE`/`DELETE`:
>
> ```sql
> set role anon;
> update public.device_push_tokens set speak = false
>  where token = 'ExponentPushToken[...]';
> -- ERROR: permission denied for table device_push_tokens
> ```
>
> Padahal `has_table_privilege('anon', ..., 'UPDATE')` bernilai `true` — jadi
> pemeriksaan katalog saja tidak cukup. `pushTokens.ts` memakai pola
> `.update(...).eq('token', ...)` dan `.delete().eq('device_id', ...)`, sehingga
> mematikan notifikasi dan prune token lama akan gagal diam-diam (hanya
> `console.warn`). Karena itu migrasi memberi **`SELECT` tingkat kolom** hanya
> pada `token` dan `device_id` — cukup untuk `WHERE`, tapi `select *` tetap
ditolak.

---

## 5c. Diagnostik satu perintah

Setelah migrasi, tidak perlu lagi menempel SQL manual. Jalankan:

```bash
npm run push:doctor
```

Skrip ini masuk ke database produksi (butuh `EXPO_PUBLIC_SUPABASE_URL` +
`DB_PASS` di `.env`) dan memeriksa enam hal yang tidak bisa dilihat dari source
code:

```
1. Skema tabel token          ✔ tabel + semua kolom ada
2. Keamanan (RLS + grant)     ✔ RLS aktif / grant anon minimal
3. Trigger pengirim push      ✔ trigger aktif
4. pg_net                     ✔ Expo Push API terjangkau — HTTP 200
5. Token perangkat            ✖ belum ada token
6. Riwayat pengiriman         …balasan Expo terakhir
```

Pemeriksaan nomor 4 bukan sekadar "ekstensi ada": skrip benar-benar POST ke
`https://exp.host/--/api/v2/push/send` dengan token dummy dan menunggu
balasannya, membuktikan DNS + TLS + jalur keluar dari database hidup.

Untuk mengirim push sungguhan ke perangkat yang terdaftar:

```bash
node scripts/push-doctor.mjs --send-test
```

Hasilnya per tiket: `status: ok` (perangkat akan dibangunkan) atau
`DeviceNotRegistered` (token mati → buka app di perangkat itu).

> Skrip ini **tidak** pernah mencetak password atau isi token.
> Region pooler dicoba otomatis (project ini di `ap-northeast-1`).

---

## 6. Langkah 4 — Build dengan FCM benar-benar terpasang

Build lama Anda (versionCode ≤ 16) **tidak** membawa `google-services.json`
untuk AAB Play Store — itu bug yang baru diperbaiki. Jadi versi yang sudah ada
di Play **tidak akan** menerima push. Perlu build baru.

### Cek cepat sebelum build

```bash
node scripts/verify-push-setup.mjs
```

Semua harus PASS (kecuali peringatan `google-services.json tidak ada` — itu
hanya relevan untuk build lokal; CI memakai secret).

### Build AAB untuk Play

1. Pastikan versi di **kedua** file naik bersamaan (`app.json` dan
   `app.playstore.json`): `version` dan `android.versionCode`. Saat ini 1.0.16 / 16.
2. Commit + push, lalu jalankan workflow:

```bash
# tag memicu build otomatis
git tag v1.0.17 && git push origin v1.0.17

# atau manual
gh workflow run "Android AAB (Play Store) 🏪"
```

3. Buka log workflow, cari langkah **🔔 Pasang google-services.json (FCM)**.
   Kalau secret kosong, langkah itu sekarang **GAGAL** (`exit 1`), bukan lagi
   sekadar warning. Dulu ia `exit 0`, dan akibatnya APK `apk-v1.0.16-r75`
   terbit hijau padahal **tanpa** konfigurasi Firebase sama sekali —
   `resources.arsc`-nya tidak memuat `gcm_defaultSenderId` maupun
   `google_app_id`, sehingga `getExpoPushTokenAsync()` gagal di HP dan tabel
   `device_push_tokens` tetap kosong. Kegagalan senyap seperti itu tidak boleh
   terulang, jadi build sekarang berhenti lebih awal.

   Ada juga langkah **✅ Verifikasi FCM benar-benar masuk ke build native**
   (cek `android/app/google-services.json` + plugin gradle) dan
   **🔍 Pastikan APK hasil build memuat konfigurasi Firebase** (cek
   `resources.arsc` di APK final). Cek terakhir inilah yang paling jujur:
   ia menguji artefak yang benar-benar diunduh pengguna.

4. Setelah terpasang di perangkat, cek isi AAB-nya:

```bash
unzip -p app-release.aab base/resources.pb | grep -a google_app_id   # harus ada
```

Cara paling mudah: setelah app dibuka di perangkat, tabel `device_push_tokens`
harus bertambah satu baris (lihat Langkah 6).

### Build lokal (opsional, untuk uji cepat)

`app.config.js` otomatis memakai `./google-services.json` bila ada:

```bash
npx expo prebuild --platform android --clean
ls android/app/google-services.json   # ada? berarti plugin google-services akan aktif
```

---

## 7. Langkah 5 — Daftarkan token di perangkat

Pasang build baru di **dua** perangkat (satu sebagai anak, satu sebagai orang
tua), lalu:

1. Pilih peran (Child / Parent) sampai pairing selesai.
2. Saat diminta izin notifikasi, **Izinkan**. (Di Android 13+ dialog ini baru
   muncul karena ada channel `aac-messages`; urutan itu sudah diperbaiki di
   `pushTokens.ts` — sebelumnya izin bisa otomatis `denied` tanpa bertanya.)
3. Biarkan app terbuka ±5 detik, lalu tutup paksa (swipe dari recents).

### Verifikasi token masuk

SQL Editor Supabase:

```sql
select device_id, role, platform, speak, language, updated_at
  from public.device_push_tokens
 order by updated_at desc;
```

Harus ada minimal **2 baris** (anak + orang tua). Kalau kosong, baca bagian
"Tidak ada token" di Langkah 9.

Cek juga di log perangkat (Android Studio → Logcat, filter `Push`):

```
[Push] getExpoPushTokenAsync gagal: ...   ← FCM tidak terpasang di build
[Push] simpan token gagal: ...            ← RLS/migrasi belum jalan
```

Kalau tidak ada baris log sama sekali, `syncPushToken` tidak terpanggil —
periksa bahwa `MessageAlertBridge` ter-mount di `App.tsx`.

---

## 8. Langkah 6 — Uji kirim

### Uji A: dari app (paling realistis)

Tutup app di perangkat orang tua, lalu kirim pesan dari perangkat anak.
Harapan di perangkat orang tua:

- banner notifikasi muncul **tanpa suara dari OS**;
- TTS membacakan pesan dengan suara profil pengirim (anak);
- hanya **satu** bunyi (tidak dobel dengan Realtime).

### Uji B: dari SQL (membuktikan trigger jalan tanpa app)

```sql
insert into public.messages (channel_id, sender_role, sender_name, text_content, timestamp)
select d.pairing_code, 'Child', 'Anak', 'Tes push dari SQL',
       (extract(epoch from now()) * 1000)::bigint
  from public.devices d
 where d.role = 'Child' and d.pairing_code is not null
 limit 1;
```

### Uji C: lihat jawaban Expo

Ini bukti paling langsung bahwa trigger benar-benar memanggil Expo:

```sql
select id, status_code, left(content::text, 400) as respons, created
  from net._http_response
 order by created desc
 limit 5;
```

| Yang terlihat | Arti | Tindakan |
|---|---|---|
| `200` + `{"data":[{"status":"ok"}]}` | Push terkirim ke FCM | Selesai |
| `200` + `"DeviceNotRegistered"` | Token mati (app di-uninstall) | Hapus baris token itu; buka app lagi di perangkat tsb |
| `200` + `"MismatchSenderId"` | `google-services.json` di APK beda project dengan service account | Unduh ulang google-services.json dari project `sensoria-dac4b`, build ulang |
| `401` | Enhanced Push Security aktif | Matikan, atau tambahkan header Bearer di trigger |
| `400` + `SENDER_ID_MISMATCH` | Sama seperti MismatchSenderId | Sama |
| **tidak ada baris** | Trigger tidak jalan | Cek baris 5 di `check-push-setup.sql`; pastikan `channel_id` = `pairing_code` anak |

> `net._http_response` hanya menyimpan ±6 jam terakhir. Kalau uji kemarin,
> jalankan ulang uji B lalu langsung cek.

---

## 9. Troubleshooting: gejala → penyebab

### "Tidak ada token" (tabel kosong)

| Cek | Perintah | Perbaikan |
|---|---|---|
| projectId ada? | `node -e "console.log(require('./app.json').expo.extra)"` | `npx eas init` |
| Build membawa FCM? | `unzip -p app.aab base/resources.pb \| grep -a google_app_id` | Isi secret `GOOGLE_SERVICES_JSON`, build ulang |
| package cocok? | `node scripts/verify-push-setup.mjs` | Daftarkan ulang app di Firebase |
| Izin ditolak? | Pengaturan Android → Aplikasi → Sensoria → Notifikasi | Aktifkan; app akan mendaftar ulang saat foreground |
| Migrasi jalan? | `check-push-setup.sql` baris 2–4 | Jalankan migrasi |

### "Token ada tapi tidak ada push"

1. `net._http_response` kosong → trigger tidak jalan. Cek baris 5, dan pastikan
   `messages.channel_id` sama dengan `devices.pairing_code` perangkat anak.
2. Respons `200` tapi perangkat diam → data-only FCM ditahan Doze. Uji dengan app
   baru saja ditutup (bukan setelah 1 jam idle). Di Xiaomi/Oppo/Vivo: izin
   **Autostart** + **Baterai: Tanpa batas**.
3. Respons `MismatchSenderId` → `google-services.json` bukan dari project
   `sensoria-dac4b`, atau service account di EAS dari project lain.

### Bunyi dobel (OS + TTS)

Tidak seharusnya terjadi: payload tidak punya `title`/`body`, dan
`setNotificationHandler` memaksa `shouldPlaySound: false`. Kalau terdengar dobel,
berarti ada notifikasi **lokal** lain yang juga tampil — cek `messageAlerts.ts`.

### Bunyi tidak ada, banner ada

`speak` di tabel bernilai `false` (pengguna mematikan notifikasi di app), atau
TTS perangkat belum punya bahasa yang dipilih. Server memakai kolom `language`
dari token — bukan bahasa di perangkat pengirim.

---

## 10. Checklist akhir

- [ ] `npm run push:verify` → semua PASS
- [ ] `npm run push:fcm` → `✔ FCM V1 sudah terpasang`
- [ ] SHA-1 dari `npm run push:sha1` ditempel di Firebase (opsional untuk push,
      wajib kalau nanti memakai Google Sign-In / pembatasan Maps per-app)
- [ ] `npm run push:doctor` → tidak ada baris ✖
- [ ] Migrasi `20261025_push_hardening.sql` dijalankan
- [ ] Secret `GOOGLE_SERVICES_JSON` terisi di GitHub
- [ ] Build baru (versionCode > 16) terpasang di 2 perangkat
- [ ] `device_push_tokens` berisi ≥ 2 baris
- [ ] Uji B (insert SQL) → `net._http_response` status `200`, `"status":"ok"`
- [ ] Uji A (dari app, app ditutup) → banner + TTS, satu bunyi

---

## 11. File terkait

| File | Isi |
|---|---|
| [scripts/verify-push-setup.mjs](../scripts/verify-push-setup.mjs) | Cek konfigurasi repo (11 pemeriksaan) |
| [scripts/push-doctor.mjs](../scripts/push-doctor.mjs) | Diagnostik database produksi (6 pemeriksaan + `--send-test`) |
| [scripts/upload-fcm-key.mjs](../scripts/upload-fcm-key.mjs) | Upload service account FCM V1 ke EAS |
| [scripts/android-sha1.mjs](../scripts/android-sha1.mjs) | SHA-1/SHA-256 sertifikat dari JKS, tanpa `keytool` |
| [scripts/check-push-setup.sql](../scripts/check-push-setup.sql) | Diagnostik database versi SQL Editor (read-only) |
| [supabase/migrations/20261024_expo_push_notifications.sql](../supabase/migrations/20261024_expo_push_notifications.sql) | Tabel token + trigger |
| [supabase/migrations/20261025_push_hardening.sql](../supabase/migrations/20261025_push_hardening.sql) | Cabut grant berlebih + EXECUTE fungsi trigger |
| [src/services/notifications/pushTokens.ts](../src/services/notifications/pushTokens.ts) | Registrasi token di app |
| [src/services/notifications/pushTask.ts](../src/services/notifications/pushTask.ts) | Task headless (TTS + banner) |
| [src/services/notifications/pushPayload.ts](../src/services/notifications/pushPayload.ts) | Parser payload (diuji Node) |
| [scripts/verify-push-payload.mjs](../scripts/verify-push-payload.mjs) | Uji parser payload |
| [scripts/verify-alert-policy.mjs](../scripts/verify-alert-policy.mjs) | Uji aturan bunyi/banner |
