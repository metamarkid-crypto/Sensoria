# ROADMAP — Keselarasan Data & Deployment VPS aaPanel

> Disusun dari bedah kode aktual (bukan asumsi): peta akses tabel di `src/services/db/*` (mobile),
> `admin/lib/*` + `admin/app/admin/(dashboard)/*/actions.ts` (dashboard), dan 10 migrasi `supabase/migrations/20260913_*`.
> Tanggal: 2026-09-14.

---

# BAGIAN 1 — ANALISA KESELARASAN DATA (Dashboard Admin ↔ Aplikasi Mobile)

## 1.1 Arsitektur: satu DB, dua klien, nol sync

Kedua sistem berbagi **satu Supabase project yang sama**. Tidak ada replikasi/sinkronisasi antar
sistem — keselarasan dijaga oleh tiga mekanisme:

| Mekanisme | Detail |
|---|---|
| **Tabel yang sama** | Mobile menulis via anon key + RLS; dashboard membaca via **service role di server actions** (setelah gate `getAdminOrNull`/Owner); backend QRIS memakai service role via RPC. |
| **Enforcement di DB** | Aturan bisnis kritis dipagari trigger database (`enforce_parent_slots`, sync `child_devices`, settle validation) — berlaku untuk **semua penulis**, bukan cuma UI. |
| **Realtime** | `family_links`, `locations`, dan `devices` (presence) mengalir via Supabase Realtime ke parent app; dashboard memakai `router.refresh()` setelah aksi. |

## 1.2 Matriks tabel — siapa menulis, siapa membaca

| Tabel | Penulis | Pembaca | Status selaras |
|---|---|---|---|
| `devices` | Mobile: upsert saat pilih role (`RoleSelectionScreen`), presence (lat/lon/last_address/**last_seen**) dari background location | Dashboard: fleet, dossier, slot grant, analytics. Parent: status online anak (realtime) | ✅ |
| `child_profiles` | Mobile: onboarding (upsert), settings JSON (voice/appearance/accessibility/lokasi) via update | Dashboard: devices, subscriptions, lookup, dossier | ✅ |
| `family_links` | Mobile: pairing upsert + unlink; dashboard TIDAK menulis (hanya baca — benar) | Dashboard: devices/lookup/dossier; entitlement engine | ✅ + realtime |
| `child_devices` | **Trigger DB** (auto dari family_links) + dashboard (kontak parent: nama/HP) | Dashboard: lookup (search HP), dossier | ⚠️ Mobile belum menulis/membaca → GAP #1 |
| `subscriptions` | Mobile: insert trial; **RPC `apply_plan_purchase`** saat settle | Dashboard: subscriptions, devices, analytics | ✅ |
| `transactions` | Backend QRIS (INSERT pending) + RPC settle | Dashboard: ledger, refund, royalti, CSV | ✅ Mobile sengaja tidak membaca (verifikasi via re-read entitas fisik) |
| `plans` | Dashboard: upsert (kind `combo`/`slots`) | Mobile: paywall (`kind='combo'`), slot packs (`kind='slots'`) | ✅ Perubahan harga live ke paywall |
| `app_settings` | Dashboard settings panel | Mobile: kill-switch stealth, trial window, banner | ✅ Refresh saat boot + tiap foreground |
| `locations` | Mobile: insert history | Parent map (realtime), dashboard emergency locate, purge retensi 30 hari | ✅ |
| `messages`, `custom_words` | Mobile ↔ mobile | Dashboard: hitungan custom words per anak | ✅ |
| `admin_users`, `admin_audit_log`, `refunds`, `royalty_payments` | Dashboard + trigger DB | Dashboard | ✅ (audit append-only) |

## 1.3 Kontrak uang (pipeline QRIS) — status saat ini

```
Mobile                    Backend (app.aacsensoria.id)           Supabase
──────                    ────────────────────────────           ────────
createQrisCheckout  ──►  POST /api/qris-checkout        ──►  INSERT transactions(pending)
  {device_id,plan_id}      validasi plan (kind combo/slots)
◄── {imageUri, orderId,    buat QRIS di gateway
     qrisExpiresAt}
[scan & bayar]
                           POST /api/qris-callback (webhook) ──► RPC apply_plan_purchase (combo)
                                                                RPC apply_parent_slot_purchase (slots)
                                                                → ledger + royalti 10% + Telegram
Mobile "Saya Sudah Bayar" ── verifikasi = re-read subscription AKTIF
                              atau max_parent_slots bertambah ✅
```

- Kontrak mobile **sudah generik dan final**: `POST { device_id, plan_id }` → `{ imageUri, orderId?, qrisExpiresAt? }` (lihat `src/services/db/paywall.ts`).
- Sisi DB **sudah lengkap dan teruji**: `apply_plan_purchase` + `apply_parent_slot_purchase` (kind-aware), royalti otomatis, refund slot-aware.

> ### 🔴 GAP #2 — Endpoint QRIS belum ada di repo
> `admin/app/api/**` **kosong**. Mobile sudah menunjuk `https://app.aacsensoria.id/api/qris-checkout`,
> tetapi implementasinya belum dibangun. Ini **bloker monetisasi** dan menjadi Fase 3 roadmap
> deployment (Bagian 2). Spesifikasinya sudah siap di §2-Fase 3.

## 1.4 Temuan audit keselarasan (mendalam)

| # | Temuan | Dampak | Tindak lanjut |
|---|---|---|---|
| 1 | **Kontak parent tidak tersentuh mobile** — `child_devices.parent_phone` hanya bisa diisi manual oleh Owner dari dashboard, padahal perangkat parent punya konteks terbaik | Data kontak butuh kerja manual admin | **Backlog mobile**: field opsional "Nomor HP (opsional)" di `PairingBottomSheet` mode parent → upsert `child_devices`. Non-bloker |
| 2 | **Endpoint QRIS belum dibangun** (GAP #2 di atas) | Paywall mobile tidak bisa menampilkan QR beneran | **Fase 3 roadmap** — spesifikasi lengkap tersedia |
| 3 | Kill-switch stealth — **selaras penuh**: semua permukaan uang (PaywallScreen, banner trial, Settings, slot paywall in-sheet) membaca satu `webPaymentActive` yang sama, fail-safe ke review-mode | Aman App Review | Tidak ada |
| 4 | Slot enforcement — **selaras penuh**: trigger DB = penulis aturan tunggal; mobile punya pre-flight + pemetaan error trigger → pesan ramah; dashboard grant Owner-only + audit; refund slot-aware | Tidak ada celah penulisan | Tidak ada |
| 5 | `last_seen` = hasil tulisan background location → status "online" (dashboard & parent) bergantung pada izin lokasi *sementara sedang dipakai*. Jika izin dicabut, device tampak offline padahal aplikasi hidup | Persepsi "device mati" yang keliru | **Catatan desain**. Backlog: pilih heartbeat non-lokasi (mis. update `last_seen` saat app foreground) bila ingin status online tidak tergantung GPS |
| 6 | Privasi lokasi — selaras Play Families: koordinat mentah hanya lewat `getEmergencyLocation` (Owner, wajib alasan, ter-audit); UI sisanya address-only; retensi 30 hari + purge | Kepatuhan baik | Tidak ada |
| 7 | Bulan royalti & digest **UTC** di dashboard DAN SQL — konsisten satu sama lain (bukan bug), keputusan bisnis jika ingin WIB | — | Terdokumentasi di `admin/README.md` |
| 8 | i18n tri-bahasa lengkap untuk semua fitur baru (slot paywall, pesan slot penuh, catatan stealth) — `qa-trilingual-check.js` lolos | — | Tidak ada |

**Kesimpulan**: keselarasan data **tinggi**. Dua GAP nyata (kontak parent dari mobile; endpoint QRIS)
sudah terpetakan ke roadmap. Tidak ada inkonsistensi skema antara tipe TypeScript di kedua sisi
(`admin/lib/types.ts` ↔ `src/services/db/types.ts`).

---

# BAGIAN 2 — ROADMAP DEPLOYMENT VPS + aaPanel (aacsensoria.id)

## Pemetaan domain (ikut kontrak yang sudah tertanam di mobile)

| Domain | Aplikasi | Port internal |
|---|---|---|
| **aacsensoria.id** (+ `www`) | Dashboard admin (Next.js di folder `admin/`) | 127.0.0.1:3100 |
| **app.aacsensoria.id** | API QRIS (Fase 3 — dibangun baru) | 127.0.0.1:3200 |

Alasan: kontrak `QRIS_CHECKOUT_URL = https://app.aacsensoria.id/api/qris-checkout` sudah
**hard-coded di aplikasi mobile** — jadi API wajib hidup di subdomain `app`, dan dashboard bebas
pakai domain utama. Tidak ada perubahan mobile yang diperlukan.

---

## Fase 0 — Prasyarat (checklist sebelum mulai)

- [ ] **VPS**: Ubuntu 22.04 LTS, min 2 vCPU / 2 GB RAM / 40 GB SSD (rekomendasi region Singapore/Jakarta), snapshot awal aktif
- [ ] **Akses**: SSH root (atau sudoer) + SSH key di laptop kamu
- [ ] **DNS** (di pengelola domain aacsensoria.id):
  - `A @ → IP_VPS`, `A www → IP_VPS`, `A app → IP_VPS`
  - tunggu propagasi (`ping aacsensoria.id` dari laptop sudah mengarah ke VPS)
- [ ] **Kredensial Supabase**: Project URL, anon key (dashboard), **service_role key** (dashboard & API QRIS)
- [ ] **Repo**: push terbaru (`main`) — GitHub private ok, siapkan **Deploy Key / PAT** untuk `git pull` dari VPS

## Fase 1 — Persiapan VPS & aaPanel (± 1 jam)

1. **Hardening dasar** (SSH):
   ```bash
   apt update && apt upgrade -y
   adduser sensoria && usermod -aG sudo sensoria
   # copy SSH key ke user baru, lalu:
   nano /etc/ssh/sshd_config        # PasswordAuthentication no, PermitRootLogin no
   systemctl restart ssh
   ufw allow 22 && ufw allow 80 && ufw allow 443 && ufw enable
   apt install -y fail2ban
   ```
2. **Install aaPanel**:
   ```bash
   URL=https://www.aapanel.com/script/install_6.0_en.sh && bash "$URL" aapanel
   ```
   Catat **URL panel, username, password** yang dicetak di akhir, lalu:
   - Login panel → **Settings**: ganti port default (mis. 28xxx, jangan lupa `ufw allow <port>`), ganti username/password kuat, aktifkan **Panel SSL**, batasi **Authorized IP** (opsional: hanya IP kamu)
3. **App Store aaPanel** — install:
   - **Nginx** (1.22+)
   - **PM2 Manager** (atau "Node.js version manager" bila ada)
   - **Let's Encrypt / SSL** (builtin di menu Website)
4. **Node.js 20 LTS** — via PM2 Manager → Settings → install Node 20; verifikasi `node -v` di terminal panel.

## Fase 2 — Deploy dashboard admin ke aacsensoria.id (± 1 jam)

1. **Clone repo**:
   ```bash
   mkdir -p /www/wwwroot && cd /www/wwwroot
   git clone https://<TOKEN>@github.com/metamarkid-crypto/Sensoria.git sensoria-admin
   cd sensoria-admin/admin
   ```
2. **Buat `.env.production`** (di server, chmod 600, JANGAN pernah di-commit):
   ```bash
   nano .env.production
   ```
   ```ini
   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
   SUPABASE_SERVICE_ROLE_KEY=eyJ...
   ```
3. **Build & jalankan via PM2**:
   ```bash
   npm ci
   npm run build
   pm2 start npm --name sensoria-admin -- start     # start = next start -p 3100
   pm2 save && pm2 startup                          # auto-start saat reboot
   curl -I http://127.0.0.1:3100/admin/login        # harus HTTP/1.1 200 OK
   ```
4. **aaPanel → Website → Add site**:
   - Domain: `aacsensoria.id` + `www.aacsensoria.id`
   - PHP version: *pure static* (tidak dipakai)
5. **Reverse proxy**: buka site → **Reverse Proxy** → Proxy target `http://127.0.0.1:3100`.
   (Kalau panel tidak menyediakan menu, isi konfigurasi nginx manual:)
   ```nginx
   location / {
     proxy_pass http://127.0.0.1:3100;
     proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header Host $host;
     proxy_set_header X-Real-IP $remote_addr;
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_set_header X-Forwarded-Proto $scheme;
     proxy_cache_bypass $http_upgrade;
   }
   ```
   > ⚠️ Header `X-Forwarded-For` penting: rate limiter login & audit log dashboard membaca IP klien dari header ini — tanpa itu semua login tercatat sebagai IP VPS.
6. **SSL**: site → SSL → **Let's Encrypt** → centang kedua domain → Apply → aktifkan **Force HTTPS**. (Opsional: uji rating di SSL Labs, target A.)
7. **Hardening akses dashboard** (opsional tapi disarankan):
   - Nginx → site → **Access Control**: `allow <IP_kantor>; deny all;` pada `location /admin/login` bila admin selalu dari satu lokasi — atau biarkan terbuka (login sudah rate-limited + MFA-ready).
   - Supabase → Authentication → URL Configuration: pastikan Site URL/redirect mencantumkan `https://aacsensoria.id`.
   - Aktifkan MFA di Supabase + flag `ADMIN_ENFORCE_MFA` (lihat `admin/lib/SECURITY.md`).
8. **Smoke test**: login owner → cek Devices/Subscriptions/Executive/Audit → buat satu aksi kecil → pastikan `admin_audit_log` mencatat IP publik kamu (bukan IP VPS).

## Fase 3 — Bangun & deploy API QRIS di app.aacsensoria.id (± 1 hari) 🔴 kritis

> GAP #2 dari Bagian 1. Ini satu-satunya komponen yang belum ada — dibangun baru sebagai proyek
> terpisah `qris-api/` (Next.js route handlers atau Express ringan) di repo yang sama, deploy
> sebagai situs kedua di VPS.

1. **Struktur proyek** `qris-api/` (satu service Node, port **3200**).
2. **Endpoint yang wajib ada**:
   | Endpoint | Fungsi |
   |---|---|
   | `POST /api/qris-checkout` | Body `{ device_id, plan_id }` → validasi plan aktif (kind `combo`/`slots`) → INSERT `transactions` (status `pending`, `transaction_ref` unik, amount = `plans.price`) → minta QRIS ke gateway → balas `{ orderId, imageUri, qrisExpiresAt }` |
   | `POST /api/qris-callback` | Webhook gateway → **verifikasi signature** → idempoten (cek status transaction dulu) → panggil RPC service-role: `apply_plan_purchase` (kind combo) / `apply_parent_slot_purchase` (kind slots) |
   | `GET /api/health` | Untuk uptime monitoring (balas 200) |
   - Opsional: `GET /api/qris-status?order_id=` untuk polling.
3. **Keamanan**:
   - `.env` di server: `SUPABASE_SERVICE_ROLE_KEY`, key gateway (Xendit/Midtrans/dsb) — chmod 600, jangan pernah commit
   - Verifikasi signature callback; whitelist IP gateway bila gateway menyediakan
   - Rate-limit per `device_id` (mis. 10 checkout/menit) — cegah spam transaksi pending
   - Jangan log payload mentah berisi PII anak
4. **aaPanel → Add site** `app.aacsensoria.id` → reverse proxy `127.0.0.1:3200` → SSL Let's Encrypt + Force HTTPS.
5. **PM2**: `pm2 start npm --name sensoria-qris -- start && pm2 save`.
6. **Uji end-to-end uang kecil**:
   - Paywall combo di mobile → QR muncul → bayar nominal kecil → subscription naik + ledger tercatat + royalti 10% + notif Telegram
   - Paywall slot (anak kapasitas penuh) → beli slot → `max_parent_slots` bertambah
   - Refund dari dashboard → claw-back benar (durasi utk combo, slot utk pack)

## Fase 4 — Operasional & pemeliharaan (berkelanjutan)

- **Backup**:
  - Supabase: aktifkan **daily backup** (Pro) atau cron `pg_dump` mingguan
  - aaPanel: scheduled task — backup konfig nginx + `.env*` (di tempat aman, terenkripsi)
  - Bukti restore: sekali uji restore dari backup
- **Monitoring**: aaPanel load monitor + PM2 monit + uptime eksternal (UptimeRobot) ke `https://aacsensoria.id/admin/login` dan `https://app.aacsensoria.id/api/health`
- **Log**: `pm2 install pm2-logrotate`; rotasi access/error log nginx via panel
- **Deploy update** (script `deploy-admin.sh` di VPS):
  ```bash
  #!/bin/bash
  set -e
  cd /www/wwwroot/sensoria-admin
  git pull origin main
  cd admin && npm ci && npm run build
  pm2 reload sensoria-admin --update-env
  ```
- **Cron tetap di Supabase** (retensi lokasi, digest Telegram) — jangan dipindah ke VPS; Supabase lebih andal untuk ini dan sudah teruji.
- **Patch rutin**: bulanan `apt upgrade`, cek pembaruan aaPanel, review `admin_audit_log` sekali sepekan.

## Fase 5 — Checklist penerimaan (go-live)

- [ ] `https://aacsensoria.id/admin/login` hijau, SSL A (SSL Labs), Force HTTPS aktif
- [ ] Login + rate-limit teruji (5× salah → terkunci sementara), MFA aktif untuk Owner
- [ ] Audit log mencatat IP publik asli (bukan IP VPS)
- [ ] Semua halaman dashboard berfungsi dari domain produksi (Devices, Lookup, Subscriptions, Transactions, Executive, Audit, Team, Settings)
- [ ] Mobile paywall: QR combo & slot muncul dari `app.aacsensoria.id`, settle teruji uang nyata kecil
- [ ] Refund test mengembalikan dengan benar (combo vs slot)
- [ ] Telegram notif paid masuk; digest harian jalan
- [ ] Stealth mode OFF → paywall mobile bersih tanpa harga (siap App Review)
- [ ] Backup harian Supabase aktif; satu uji restore sukses
- [ ] PM2 dua proses (`sensoria-admin`, `sensoria-qris`) selamat dari `reboot`

---

## Urutan eksekusi yang direkomendasikan

| Hari | Pekerjaan |
|---|---|
| **Hari 1** | Fase 0 → 2 (VPS siap, dashboard live di aacsensoria.id dengan SSL) |
| **Hari 2–3** | Fase 3 (bangun `qris-api/`, deploy ke app.aacsensoria.id, uji uang end-to-end) |
| **Hari 4** | Fase 4–5 (backup, monitoring, checklist penerimaan, go-live) |
| **Backlog** | GAP #1 (nomor HP parent dari mobile), heartbeat non-lokasi, paginasi server-side |
