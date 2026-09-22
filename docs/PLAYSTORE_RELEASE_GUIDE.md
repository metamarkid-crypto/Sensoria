# 📱 Panduan Rilis Sensoria ke Google Play Store (Production)

Panduan lengkap untuk menerbitkan APK/AAB ke Google Play Store sebagai aplikasi produksi. Ditulis berdasarkan kondisi proyek saat ini (EAS build, app.json, paket `_metamarkid_.sensoria`).

---

## Tahap 0 — Prasyarat Akun

| Item | Keterangan |
|---|---|
| Akun Google Play Console | Daftar di https://play.google.com/console — biaya pendaftaran **USD 25 sekali seumur akun** |
| Verifikasi identitas | Individu atau organisasi. Untuk organisasi: D-U-N-S number wajib |
| Jumlah aplikasi | Akun baru **harus menyelesaikan 14 hari + 12 tester** sebelum bisa ke production (kebijakan 2023+). Rencanakan: rilis internal/closed testing dulu selama periode ini |
| 2-Step Verification | Wajib aktif di akun Google |

---

## Tahap 1 — Lengkapi Identitas Aplikasi (`app.json`)

Sebelum build untuk Play Store, pastikan di `app.json`:

```json
"android": {
  "package": "_metamarkid_.sensoria",          // ← konfirmasi nama final (TIDAK BISA diganti setelah rilis!)
  "versionCode": 7,                             // ← wajib naik di setiap rilis
  "permissions": [...],                         // ← audit: LOCATION, MICROPHONE dsb harus punya justifikasi
  ...
}
```

> ⚠️ **Nama paket permanen.** Jika `_metamarkid_.sensoria` adalah placeholder, ganti SEKARANG sebelum upload pertama. Pola umum: `id.domain.appname` (mis. `id.sensoria.aac`).

### AAB, bukan APK

Play Store **mewajibkan Android App Bundle (.aab)**, bukan APK. APK masih dipakai untuk distribusi mandiri (GitHub Releases seperti sekarang), tapi untuk Play Store:

```bash
eas build --platform android --profile production
```

Pastikan `eas.json` memiliki profil production dengan `android.buildType: "app-bundle"`:

```json
"build": {
  "production": {
    "android": {
      "buildType": "app-bundle"
    }
  }
}
```

### Penandatanganan (Signing)

Play App Signing direkomendasikan:
1. Di Play Console → **Setup → App signing**, pilih *Google-managed signing key*
2. Upload kunci tanda tangan (upload key) dari EAS — jika pakai EAS, `eas build` otomatis mengelola keystore; cukup unduh & upload sertifikat upload key saat diminta
3. **Simpan keystore secara aman** (password manager + backup offline). Hilang = tidak bisa update aplikasi

---

## Tahap 2 — Aset & Konten yang Wajib Disiapkan

### Listing Store (Store Listing)

| Aset | Spesifikasi |
|---|---|
| Ikon aplikasi | 512×512 PNG (bisa dari `assets/icon.png`) |
| Banner Featured | 1024×500 PNG (opsional tapi disarankan) |
| Screenshot ponsel | **Minimal 2, maksimal 8** — min sisi 320px, maks 3840px; ambil dari mode anak & mode parent (grid kamus, obrolan, dashboard, lokasi) |
| Screenshot 7"/10" (tablet) | Opsional untuk awal |
| Video YouTube | Opsional, sangat membantu untuk aplikasi AAC |

### Teks Listing (bilingual ID/EN disarankan)

- **Nama aplikasi** (maks 30 karakter): mis. "Sensoria — AAC Komunikasi Anak"
- **Deskripsi singkat** (maks 80 karakter)
- **Deskripsi lengkap** (maks 4000 karakter) — jelaskan: AAC untuk anak dengan kebutuhan khusus, 244 kata pictogram, mode parent (obrolan, lokasi, pengaturan remote), Balasan Visual untuk anak tunarungu, offline-first

### Kebijakan & Formulir (sering jadi penghambat untuk aplikasi anak)

1. **Privacy Policy (wajib, URL aktif)** — host di website (mis. `sensoria.id/privacy`). Harus menjelaskan: data yang dikumpulkan (profil anak, lokasi GPS, pesan), cara penyimpanan (Supabase), hak penghapusan
2. **Data Safety Form** di Play Console — deklarasikan semua data yang dikumpulkan:
   - ✅ Info pribadi (nama anak) — dikumpulkan, tidak dibagikan
   - ✅ Lokasi — dikumpulkan (pelacakan parent-child), **justifikasi ketat**
   - ✅ Foto/ikon — tidak keluar perangkat
   - ✅ Aktivitas aplikasi (pesan AAC)
3. **Content Rating questionnaire** (IARC) — isi jujur; kategori komunikasi/anak biasanya menghasilkan rating "Everyone"
4. **Target Audience** — aplikasi untuk anak: pilih rentang usia target (mis. 5–12). **Perhatian:** jika target termasuk anak <13, aturan **Families Policy** berlaku ketat:
   - Tidak boleh ada iklan pihak ketiga
   - Privacy policy khusus anak
   - Data minimal — **pengumpulan lokasi anak adalah area sensitif**: siapkan justifikasi kuat bahwa pelacakan hanya untuk fitur keselamatan parent-child dengan persetujuan orang tua
5. **Permissions Declaration** — untuk `ACCESS_BACKGROUND_LOCATION` (pelacak lokasi), Play meminta **deklarasi video/screenshot pemakaian** + formulir. Tanpa ini update akan ditolak
6. **Data Security Form & kebijakan akun** (deletion) — sediakan cara pengguna meminta hapus akun/data (URL web atau di-app)

> 💡 **Saran untuk mempercepat rilis pertama:** pertimbangkan rilis pertama TANPA background location (fitur lokasi bisa menyusul di update), karena deklarasi `ACCESS_BACKGROUND_LOCATION` adalah penyebab penolakan paling umum dan proses review-nya bisa 1–2 minggu.

---

## Tahap 3 — Jalur Testing Sebelum Production (WAJIB untuk akun baru)

1. **Internal testing** (hingga 100 tester via email/Google Group) — upload AAB, tester install via link opt-in. Tidak perlu review Google
2. **Closed testing** — butuh minimal **12 tester selama 14 hari berturut-turut** untuk akun personal baru sebelum production terbuka
3. Kumpulkan feedback, perbaiki, lalu ajukan **ke Production**

> Closed testing juga terkena review Google (beberapa hari). Production review pertama biasanya **1–7 hari**.

---

## Tahap 4 — Buat Release Production

1. Play Console → **Production → Create new release**
2. Upload AAB (`app-release.aab` hasil `eas build -p android --profile production`)
3. **Release notes** ("What's new") — mis. untuk rilis pertama: "Rilis pertama Sensoria: komunikasi AAC anak + mode parent"
4. Pilih **countries** — mulai dari Indonesia saja untuk kontrol awal
5. **Review & roll out** → pilih *Standard* (rollout bertahap otomatis 20%→100%)

---

## Tahap 5 — Otomasi (opsional, setelah pipeline stabil)

GitHub Actions bisa langsung upload ke Play Store dengan `r0adkll/upload-google-play`:
- Simpan **service account JSON** di GitHub Secrets (`PLAY_SERVICE_ACCOUNT_JSON`)
- AAB hasil EAS build di-upload otomatis ke track production/internal
- Nilai tambah besar karena build Android kita sudah otomatis di GitHub Actions — tinggal tambah step `eas build --non-interactive` + upload

---

## Checklist Ringkas Sebelum Submit

- [ ] Nama paket final & permanen di `app.json`
- [ ] `versionCode` naik (sekarang 7) + `version` semver
- [ ] Build AAB production via EAS (bukan APK)
- [ ] Keystore aman + Play App Signing diaktifkan
- [ ] Privacy policy URL aktif (menyebut lokasi, profil anak, Supabase)
- [ ] Data Safety form terisi lengkap & konsisten dengan kode
- [ ] Deklarasi background location (atau fitur lokasi ditunda)
- [ ] 2+ screenshot ponsel kualitas baik
- [ ] Deskripsi listing 3 bahasa (id/en/zh) siap
- [ ] Content rating selesai, target audience + Families Policy terpenuhi
- [ ] Mekanisme hapus akun/data tersedia

---

## Estimasi Waktu

| Tahap | Durasi |
|---|---|
| Setup akun + verifikasi | 1–3 hari |
| Aset + listing + formulir | 2–5 hari kerja |
| Closed testing (wajib akun baru) | **14 hari** |
| Review production pertama | 1–7 hari |
| **Total realistis** | **±3–4 minggu** |

---

## 🔑 Keystore: strategi final (satu signature untuk semua kanal)

**Keputusan arsitektur**: AAB produksi dibangun **oleh GitHub Actions** (bukan EAS cloud), karena 13 `EXPO_PUBLIC_*` secret app harus ter-bake ke bundle saat build — dan hanya GitHub runner yang bisa membaca repo secrets. EAS hanya dipakai **sekali** untuk melahirkan keystore produksi.

**KEDUA pipeline kini memakai keystore yang sama** dari 4 secret repo:
- `android-aab.yml` (Play AAB) — **wajib** keystore; build gagal cepat bila secret belum diset.
- `android-build.yml` (APK GitHub) — memakai keystore bila secret tersedia; **fallback graceful** ke debug-signed bila belum, dengan catatan signature yang jujur di release notes.

Hasilnya: signature APK GitHub = signature AAB Play. Pengguna APK lama (debug-signed) harus **uninstall dulu** sebelum pasang build release-signed — catatan ini otomatis muncul di release notes setiap build.

### Cara mengekstrak keystore dari EAS (sekali jalan, setelah build pertama sukses):

```cmd
npx eas-cli@latest credentials
```

Pilih platform `android` → pilih **Download existing Android Keystore** (format `.jks`) → ekstrak ZIP ke `sensoria-release-key.jks`.

### Cara mengunduh kredensial pakai REST API (alternatif tanpa CLI interaktif):

```bash
TOKEN=<expo access token kamu>
PROJECT_ID=aa1cfb2b-48ce-46c5-8fed-8f170a7cb3d9
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.expo.dev/v2/credentials/$PROJECT_ID/android/keystore" \
  -o keystore.zip
```
ZIP berisi `<alias>.jks` + metadata (alias, keystore password, key password).

### Set 4 secret di GitHub (Settings → Secrets and variables → Actions):

| Secret | Isi |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w 0 sensoria-release-key.jks` (atau `certutil -encode file.jks out.txt` di Windows, ambil isi antara header) |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password dari metadata EAS |
| `ANDROID_KEYSTORE_ALIAS` | alias (default EAS: `my-key-alias`) |
| `ANDROID_KEY_PASSWORD` | key password dari metadata EAS |

Workflow memverifikasi keystore + alias + password **sebelum build** — kalau salah satu salah, build gagal cepat dengan pesan jelas (tidak menghasilkan AAB unsigned). Signing patch otomatis diterapkan ke `build.gradle` hasil prebuild (template default menandatangani release dengan debug key — itulah yang membuat APK lama kita "debug-signed" dan akan ditolak Play).

> ⚠️ Simpan cadangan `.jks` + password di password manager — hilangnya keystore = tidak bisa update app selamanya. EAS menyimpan backup, tapi prinsip tetap berlaku.
