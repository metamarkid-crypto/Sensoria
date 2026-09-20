# QA Manual — Unlink/Relink Parent ke Anak Berbeda (Realtime Follow-Through)

> Tujuan: memastikan **semua channel realtime mengikuti anak baru** setelah parent
> unlink lalu relink ke child device yang berbeda **di sesi yang sama**, tanpa
> restart app di kedua perangkat.
>
> Prasyarat build: APK yang **sudah memuat perbaikan realtime** (filter `home_child_profile`
> tidak pernah kosong, channel device-keyed anak selalu hidup, presence/lokasi re-resolve
> saat `family_links` berubah). Perbaikan ini belum dirilis saat dokumen dibuat —
> jalankan setelah rilis berikutnya, bukan pada v1.0.4.

---

## 0. Alat & Persiapan

| Perangkat | Role | Keterangan |
|---|---|---|
| **A** | Anak 1 (mis. "Salwa") | Sudah onboarding, punya pairing code |
| **B** | Parent (mis. "Ibu") | Terlink ke Anak 1 di awal tes |
| **C** | Anak 2 (mis. "Bima") | Sudah onboarding, punya pairing code sendiri |

- Ketiga device online (Supabase reachable), sama versi APK.
- Wifi + GPS aktif; izin lokasi (foreground + background) disetujui di device anak.
- Siapkan akses **Supabase SQL Editor** untuk verifikasi state DB (query di §6).
- Catat waktu mulai tiap langkah (relevan untuk cek `last_seen`).

---

## 1. Baseline — Parent terlink ke Anak 1 (semua channel hidup)

Lakukan dulu supaya ada pembanding saat pindah ke Anak 2.

| # | Langkah | Hasil yang diharapkan |
|---|---|---|
| 1.1 | Buka Parent (B) → tab Home | Header menampilkan nama Anak 1; status online "Sekarang" |
| 1.2 | Di Anak 1 (A), buka app (foreground) | Dalam ±5 dtk status B berubah "Sekarang" (channel `global_presence` → `devices` UPDATE) |
| 1.3 | Anak 1 susun kalimat → **Kirim** | Parent: TTS membacakan kalimat (pager `global_parent_tts_pager`), kartu "pesan terakhir" di Home ikut ter-update (`home_recent_message`) |
| 1.4 | Parent: edit profil Anak 1 (Settings → Profil, ganti nama panggilan) → Simpan | Tersimpan tanpa error "Device ID tidak ditemukan" |
| 1.5 | Anak 1 edit profil sendiri (nick/gender) | Parent Home mirror berubah sendiri dalam hitungan detik (`home_child_profile`) — **tanpa** restart |
| 1.6 | Di Anak 1: ganti kecepatan suara (Voice Settings) | Muncul di Parent? (mirror settings dua arah lewat `child-settings-update` / upsert settings) |
| 1.7 | Parent: tab Lokasi | Marker di posisi terakhir Anak 1 |
| 1.8 | Parent: tombol refresh lokasi (ping) | Anak 1: toast "lokasi terkirim" + haptic; peta parent lompat ke posisi baru dalam ±5 dtk (broadcast `location-ping-{childId}`) |
| 1.9 | Gerakkan Anak 1 (GPS berubah) | Peta parent mengikuti otomatis (`parent-locations-{childId}`, INSERT `locations`) |
| 1.10 | Cek entitlement Parent | Status premium sesuai langganan **Anak 1** (aturan Combo) |

☐ Semua 1.1–1.10 lolos → baseline valid, lanjut.

---

## 2. Unlink — Parent memutus Anak 1

| # | Langkah | Hasil yang diharapkan |
|---|---|---|
| 2.1 | Parent: Home → sheet Pairing → **Unlink** → konfirmasi | Sheet kembali ke **form link** (input kode), nama anak hilang |
| 2.2 | Verifikasi store parent | `pairingCode` kosong, `childProfile` null — Home/Profil/Lokasi menampilkan state "belum terhubung" (tidak crash, tidak menampilkan data anak lama) |
| 2.3 | **Di sesi yang sama** (jangan restart) | Semua langkah §3 menguji re-target tanpa restart — inilah inti regresinya |
| 2.4 | Anak 1: buka sheet Pairing (mode anak) | Daftar parent terhubung kosong/berkurang (refresh realtime `family_links_updates_sheet`); anak **tidak** menerima toast "terhubung" (toast anak hanya untuk INSERT, unlink = DELETE) |
| 2.5 | Anak 1 coba **Kirim** kalimat | Toast gagal/tertahan — cek `family_links` mencegah pesan yatim |
| 2.6 | DB (§6 Q1) | Baris `family_links` untuk parent B **sudah tidak ada** |

☐ 2.1–2.6 lolos.

---

## 3. Relink ke Anak 2 — SEMUA realtime harus mengikuti anak baru

Parent tetap di sesi yang sama (layar tidak pernah ditutup). Ikuti urutannya.

| # | Langkah | Hasil yang diharapkan | Channel yang membuktikan |
|---|---|---|---|
| 3.1 | Parent: masukkan **pairing code Anak 2** → link | Sukses; nama **Anak 2** tampil di sheet; tidak ada alert "slot penuh" (kecuali skenario §5.3) | — |
| 3.2 | Parent: Home | Header: nama **Anak 2**; profil & gender sesuai Anak 2 (fetch awal via `family_links`) | resolve effect |
| 3.3 | Anak 2 foreground → cek status parent | "Sekarang" mengikuti **kehadiran Anak 2**, bukan Anak 1 | `global_presence` → `devices` filter id = **Anak 2** |
| 3.4 | Anak 1 (masih online, biarkan) | Status parent **tidak** berubah mengikuti aktivitas Anak 1 lagi | sama |
| 3.5 | Anak 2 kirim kalimat | Parent: TTS + kartu pesan terakhir = kalimat **Anak 2** | `global_parent_tts_pager`, `home_recent_message` (filter `channel_id` = kode Anak 2) |
| 3.6 | Anak 1 kirim kalimat | Parent **tidak** membacakannya (kode channel lama sudah lepas) | sama |
| 3.7 | Anak 2 edit profil (nick/gender) | Mirror di Parent Home dalam hitungan detik | `home_child_profile` (filter `device_id` = **Anak 2** — filter tidak pernah kosong) |
| 3.8 | Parent edit profil Anak 2 via Settings → Profil | Simpan sukses, tanpa "Device ID tidak ditemukan" | UserProfile upsert |
| 3.9 | Parent: tab Lokasi | Marker = posisi **Anak 2** | re-resolve via watcher `family_links` |
| 3.10 | Parent: ping refresh lokasi | **Anak 2** menerima toast + kirim GPS; peta update | broadcast `location-ping-{childId}` |
| 3.11 | Gerakkan Anak 2 | Peta mengikuti Anak 2 | `parent-locations-{childId}` |
| 3.12 | Gerakkan Anak 1 | Peta **tidak** ikut Anak 1 | sama |
| 3.13 | Anak 2: sheet Pairing | Toast "terhubung" muncul (INSERT `family_links` di sisi anak) + daftar slot bertambah | `child_family_links`, `family_links_updates_sheet` |
| 3.14 | Cek entitlement Parent | Premium kini mengikuti langganan **Anak 2** (jika Anak 2 tanpa langganan → parent terkunci; lihat §5.4) | `entitlement-watcher` |
| 3.15 | DB (§6 Q1–Q3) | Link lama hilang, link baru menunjuk device Anak 2; `pairing_code` store = kode Anak 2 | — |

☐ 3.1–3.15 lolos → relink sepenuhnya mengikuti anak baru.

---

## 4. Relink kembali ke Anak 1 (arah balik)

| # | Langkah | Hasil yang diharapkan |
|---|---|---|
| 4.1 | Unlink Anak 2 → link ke **Anak 1** (sesi sama) | Semua langkah 3.2–3.13 lolos dengan arah terbalik (nama, presence, TTS, profil, lokasi) |
| 4.2 | Setelah relink, Anak 1 edit profil | Parent mirror ikut lagi (memastikan re-subscribe tidak sekali pakai) |

☐ Lolos.

---

## 5. Edge cases

| # | Skenario | Hasil yang diharapkan |
|---|---|---|
| 5.1 | **Unlink dari sisi parent saat semua tab parent terbuka** (Home/Messages/Location aktif) | Tidak ada error/crash; setelah relink ke Anak 2 tanpa pindah tab, semua tab ikut anak baru |
| 5.2 | **Relink saat parent offline lalu online lagi** | Setelah online, fetch ulang mengembalikan state anak yang benar (jangan percaya salinan stale) |
| 5.3 | **Slot penuh** — child device Anak 2 punya `max_parent_slots` tercapai | Link ditolak dengan alert ramah "slot penuh" (DB trigger `enforce_parent_slots`), bukan error generik |
| 5.4 | **Anak 2 tanpa langganan aktif** | Parent masuk fase locked (aturan Strict Parent) sesuai combo rule — bukan tetap premium dari sisa Anak 1 |
| 5.5 | **Parent kedua** (device D) masih terlink ke Anak 1 saat B unlink | Device D **tidak terpengaruh** (delete hanya `parent_device_id` B); Anak 1 masih punya parent |
| 5.6 | **Anak 1 membunuh app** (swipe) selama parent sudah relink | Parent status Anak 1 memudar ke "X menit lalu"; tidak mempengaruhi status Anak 2 |
| 5.7 | **Restart parent setelah relink** | State pulih dari `family_links` (bukan dari salinan lokal) — tetap Anak 2 |
| 5.8 | **Anak 2 reinstall app** | Parent tetap terlink (link hidup di DB); profil anak tetap tampil di parent |

☐ Semua edge case dinilai & dicatat.

---

## 6. Verifikasi DB (Supabase SQL Editor)

```sql
-- Q1: Semua link milik parent B (harus hanya berisi anak AKTIF saat ini)
SELECT fl.id, fl.parent_device_id, fl.child_device_id, fl.parent_label, fl.created_at
FROM family_links fl
WHERE fl.parent_device_id = '<DEVICE_ID_PARENT_B>';

-- Q2: Profil kedua anak (identitas pembanding)
SELECT device_id, nickname, full_name, settings->>'childProfileGender' AS gender
FROM child_profiles
WHERE device_id IN ('<DEVICE_ID_ANAK_1>', '<DEVICE_ID_ANAK_2>');

-- Q3: Kode pairing kedua anak (harus = kode yang dipakai saat link)
SELECT id, role, pairing_code, last_seen
FROM devices
WHERE id IN ('<DEVICE_ID_ANAK_1>', '<DEVICE_ID_ANAK_2>');

-- Q4: Pesan terakhir per channel (verifikasi 3.5/3.6)
SELECT channel_id, sender_role, text_content, timestamp
FROM messages
WHERE channel_id IN ('<KODE_ANAK_1>', '<KODE_ANAK_2>')
ORDER BY timestamp DESC LIMIT 10;

-- Q5: Slot parent per anak (verifikasi 5.3)
SELECT id, max_parent_slots FROM devices
WHERE id IN ('<DEVICE_ID_ANAK_1>', '<DEVICE_ID_ANAK_2>');
```

---

## 7. Format pelaporan bila ada kegagalan

Untuk tiap langkah gagal, catat:

1. **ID langkah** (mis. 3.7) + waktu kejadian
2. **Device & build** (versi APK, versionCode)
3. **Ekspektasi vs aktual** (screenshot/screen record)
4. **State DB** saat itu (hasil query §6 yang relevan)
5. Apakah terjadi **network blip** (mode pesawat, ganti wifi) di sekitar kejadian

> Pola umum yang perlu dicurigai: gejala "mengikuti anak lama" = channel menempel
> ke filter lama (re-resolve tidak jalan); gejala "update hilang diam-diam" =
> filter kosong/stale; gejala hanya di sesi pertama = salinan persisted lama
> dipercaya daripada DB.
