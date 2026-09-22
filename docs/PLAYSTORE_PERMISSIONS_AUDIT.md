# 🔐 Audit Permission & Kepatuhan Families Policy — Sensoria (`id.sensoria.aac`)

Dokumen referensi untuk mengisi **Play Console → App content** (Data Safety, Permissions Declaration, Families Policy) berdasarkan kondisi kode aktual. Terakhir diaudit: rilis v1.0.6 / versionCode 7.

> ⚡ **KEPUTUSAN RILIS PERTAMA (final)**: Build Play Store memakai `app.playstore.json` — **foreground-only** (`ACCESS_BACKGROUND_LOCATION` TIDAK diminta). Workflow `android-aab.yml` otomatis menukar config sebelum build. APK GitHub (`android-build.yml`, `app.json`) tetap background-enabled untuk penggunaan internal. Form Play: **Location permission = No, background location = tidak dikumpulkan**. Rencana background location menunggu siapnya video deklarasi di update berikutnya.

---

## 1. Inventaris Permission Aktual

> **Cara verifikasi otoritatif** — permission final di APK/AAB adalah hasil *merge* dari semua library native. Setelah prebuild, cek manifest:
> ```bash
> npx expo prebuild --platform android --clean
> grep -o 'uses-permission android:name="[^"]*"' android/app/src/main/AndroidManifest.xml | sort -u
> ```

### 1.1 Dideklarasikan eksplisit di `app.json`

| Permission | Kode terkait | Justifikasi untuk Play Console |
|---|---|---|
| `android.permission.POST_NOTIFICATIONS` | Notifikasi pesan/balasan parent→anak & anak→parent | Runtime permission Android 13+ untuk notifikasi realtime antara anak dan orang tua — inti fitur aplikasi |

### 1.2 Auto-merged oleh plugin `expo-location` (`isAndroidBackgroundLocationEnabled: true`)

| Permission | Kode terkait | Justifikasi |
|---|---|---|
| `ACCESS_COARSE_LOCATION` | — | Basis akses lokasi (wajib oleh Play di samping fine) |
| `ACCESS_FINE_LOCATION` | `ChildAACScreen.setupLocation` (foreground) | Titik lokasi anak dikirim ke parent — fitur keselamatan inti |
| `ACCESS_BACKGROUND_LOCATION` | `src/services/location/backgroundLocation.ts` | Pelacakan berkelanjutan agar parent dapat melihat posisi anak saat app tidak dibuka. **Permission paling berisiko ditolak — lihat §4** |

### 1.3 Auto-merged oleh library lain (verifikasi di manifest)

| Library | Permission kemungkinan | Catatan |
|---|---|---|
| `expo-sqlite` | — (tanpa permission) | Penyimpanan lokal offline-first |
| `expo-audio` | `RECORD_AUDIO` **jika** recording diaktifkan | App hanya *memutar* TTS; jika manifest memuat RECORD_AUDIO tanpa pemakaian, matikan via plugin config (`isAudioRecordingEnabled: false`) agar audit lebih bersih |
| `expo-secure-store` | — | Penyimpanan aman device id/kredensial |
| `@sentry/react-native` | `INTERNET` | Laporan crash — deklarasikan di Data Safety sebagai data dikumpulkan |
| React Native (core) | `INTERNET`, `ACCESS_NETWORK_STATE` | Standar; sinkronisasi Supabase saat online |

> ✅ **Tidak ada**: iklan pihak ketiga, kamera, kontak, mikrofon langsung, penyimpanan media, SMS/telepon. Ini posisi kuat untuk Families Policy.

---

## 2. Peta Data Safety Form (Play Console)

Jawaban konsisten dengan kode — **jangan ada selisih antara form dan kenyataan** (penyebab penolakan #2 setelah background location):

| Kategori Data | Dikumpulkan? | Dibagikan? | Bersifat opsional? | Terenkripsi transit | Bisa dihapus |
|---|---|---|---|---|---|
| Nama anak (nickname, full name, gender) | ✅ | ❌ tidak dibagikan ke pihak ketiga | Ya | ✅ | ✅ hapus profil → self-healing upsert tidak menulis ulang |
| Lokasi presisi (lat/lng anak, background) | ✅ | ❌ hanya tampil ke device parent yang ter-link di `family_links` | Ya (fitur utama) | ✅ | ✅ tabel `locations` + retention migration sudah ada (`20260913_location_retention.sql`) |
| Pesan AAC (teks) | ✅ | ❌ hanya antar device keluarga ter-link | Ya | ✅ | ✅ hapus pesan/cache |
| Device ID | ✅ | ❌ | Tidak (teknis) | ✅ | ✅ unlink + hapus device |
| Log crash (Sentry) | ✅ | ❌ (prosesor Sentry) | Tidak | ✅ | hubungi support |
| Data pembayaran (QRIS) | ✅ (status transaksi, **bukan** kartu/kredensial) | ❌ | Tidak | ✅ | — |

- **Tidak mengumpulkan**: riwayat browsing, data keuangan kartu, kontak, foto/video, iklan ID.
- **Target usia** & Families Policy: semuanya di atas dikumpulkan **dengan persetujuan orang tua** melalui alur pairing (role selection ibu/ayah/lainnya) — ini narasi kunci untuk review.

---

## 3. Checklist Families Policy (target pengguna anak)

| Persyaratan | Status | Catatan |
|---|---|---|
| Tanpa iklan pihak ketiga | ✅ | Tidak ada SDK iklan sama sekali |
| Privacy policy khusus & lengkap | ✅ siap | `https://aacsensoria.id/privacy` (3 bahasa) — halaman dibuat di repo ini |
| Data minimal | ⚠️ perlu narasi | Lokasi anak = fitur keselamatan inti; wajib dijustifikasi (lihat §4). Pesan = fungsi komunikasi. Tidak ada data lain |
| Consent orang tua | ✅ | Pairing parent↔anak lewat `family_links`; pengaturan anak dikendalikan remote oleh parent |
| Fits "Designed for Families" | ✅ direkomendasikan | Konten edukasi-assistive, tanpa UGC publik, tanpa chat ke orang asing (komunikasi tertutup keluarga) |
| Akun & penghapusan data | ⚠️ tindak lanjut | Sediakan jalur penghapusan akun/data (email support + hapus dari app). Play **mewajibkan** opsi penghapusan akun untuk app yang membuat akun/device-profile |

---

## 4. Rencana Deklarasi `ACCESS_BACKGROUND_LOCATION` (kunci lolos review)

Play **tidak menerima** background location hanya dari manifest — wajib isi **Permissions Declaration** di Play Console (`App content → Sensitive permissions`), lalu review manual 1–2 minggu.

### 4.1 Yang diisi di form

- **Fitur yang memakai**: "Parental safety location monitoring" — orang tua memantau keberadaan anak yang menggunakan perangkat AAC (anak berkebutuhan khusus yang tidak selalu dapat melaporkan posisinya sendiri).
- **Di mana fitur terlihat**: mode Parent → layar Lokasi (peta + riwayat); alur kirim lokasi dari mode Anak.
- **Kenapa foreground tidak cukup**: perangkat adalah milik anak dan aplikasi sering tidak dibuka anak saat berpindah tempat; tanpa background tracking, fitur keselamatan gagal pada kasus penggunaan justru yang paling penting (anak di luar jangkauan).

### 4.2 Bukti yang harus disiapkan (wajib)

1. **Video demo ≤30 detik**: tampilkan (a) prompt permission muncul dengan teks jelas, (b) app di background / device terkunci, (c) lokasi anak tetap ter-update di device parent, (d) pengaturan lokasi bisa dimatikan. *Rekam dari APK v1.0.6+ yang sudah berisi fitur ini.*
2. **Screenshot** prompt permission + layar peta parent.
3. **Teks prompt saat ini** (sudah ada di app.json, pastikan tampil pada satu prompt jelas): *"Sensoria mengakses lokasi di latar belakang agar orang tua tetap dapat memantau anak."* — sudah sesuai best practice (menyebut fitur, bukan generik).

### 4.3 Strategi rilis bertahap (disarankan keras)

| Fase | Isi | Manfaat |
|---|---|---|
| **Fase 1 — rilis pertama** | Background location **dimatikan** (`isAndroidBackgroundLocationEnabled: false`, permission tidak diminta) | Review cepat, lolos tanpa deklarasi sensitif; app tetap lengkap: AAC, chat, settings remote |
| **Fase 2 — update berikutnya** | Aktifkan background + kirim deklarasi + video | Riwayat review sudah baik → peluang persetujuan jauh lebih tinggi; pengguna baru tidak dibebani prompt sensitif saat install pertama |

> Kalau fase 1 tidak praktis (lokasi = fitur jual utama), minimal **minta `while-in-use` dulu** dan background hanya diminta dari layar pengaturan parent dengan penjelasan (*up-front disclosure*) — bukan saat onboarding pertama. Ini pola yang diterima Google.

---

## 5. Tindak lanjut teknis prioritas

1. ✅ `POST_NOTIFICATIONS` runtime request sudah ada (Android 13)
2. ⚠️ Cek `RECORD_AUDIO` di manifest hasil prebuild — matikan bila tidak dipakai
3. ⚠️ Tambahkan jalur **hapus akun/data** (email support di privacy page sudah disiapkan + opsi hapus profil di app)
4. ⚠️ Data Safety form diisi persis sesuai tabel §2
5. ✅ Teks prompt lokasi sudah deskriptif (bukan boilerplate)
6. ⚠️ Siapkan video deklarasi background location (§4.2) sebelum fase 2
