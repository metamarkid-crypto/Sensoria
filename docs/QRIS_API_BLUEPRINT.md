# Blueprint — QRIS API Sensoria (adaptasi go-merchant, jalur GoBiz saja)

> Sumber analisa: folder `go-merchant/` (76 file), dibedah file-per-file.
> Keputusan terkunci: **hanya fitur GoBiz** (`api.gobiz.co.id`) yang diambil.
> Seluruh jalur GoPay Mobile / Midtrans **dibuang** — lihat §2.3 mengapa.

---

## 1. Ringkasan eksekutif

`go-merchant` adalah gateway QRIS yang bekerja dengan pola:

1. **Taut akun merchant** — nomor HP terdaftar GoBiz → OTP via SMS →
   `/goid/token` → access + refresh token → `/v1/users/me` → `merchant_id` + nama.
2. **Pasang QRIS statis** — merchant menempel **string payload** QRIS statisnya,
   atau **meng-upload gambar** QRIS resmi yang di-decode di browser (jsQR) menjadi
   payload EMVCo asli → disimpan per merchant account.
3. **Jualan** — transaksi = payload statis ditransformasi jadi **QRIS dinamis**
   (tag `01` → `12`, sisip tag `54` nominal, recompute CRC16) → gambar QR (base64).
4. **Deteksi bayar** — worker cron memanggil `POST /journals/search` milik GoBiz,
   menyaring mutasi `settlement|capture`, lalu **FIFO-matching**:
   nominal persis + jendela waktu (−1 min … +5 menit dari transaksi dibuat) +
   dedup per `reference_id` jurnal → status `PENDING → PAID` → webhook.

Adaptasi ke Sensoria: pola 1–4 **dipertahankan utuh**; yang diganti adalah
penyimpanan (MySQL → Supabase Postgres via service role), ledger (tabel
`transactions` internal → **ledger `public.transactions` kita yang sudah ada**),
settlement (webhook → **`settle_transaction()` RPC kind-aware**), dan konsumen
(webhook client → **aplikasi mobile langsung**, kontrak `createQrisCheckout`).

---

## 2. Anatomi go-merchant — apa yang diambil, apa yang dibuang

### 2.1 DIAMBIL (inti GoBiz)

| File | Fungsi | Catatan adaptasi |
|---|---|---|
| `src/services/goMerchant.service.js` | SDK GoBiz: `headers()`, `convertCRC16()`, `createDynamicQRIS()`, `requestOtp()`, `verifyOtp()`, `refreshToken()`, `getMe()`, `getJournals()` | **Jantung porting.** Header set persis dipertahankan (`x-appId: go-biz-web-dashboard`, `X-AppVersion: platform-v3.101.0-…`, `Authentication-Type: go-id`). `device_id` (uuid) harus **persisten per merchant** — dipakai ulang saat refresh token |
| `src/services/worker.service.js` | Cron `*/2 * * * *`; **smart selection** (hanya merchant yang punya order PENDING yang di-poll); FIFO matching; dedup via `mutation_logs` (unique `external_id+source`); auto-refresh token saat 401; expire PENDING > 24 jam | Pola diambil utuh; jendela waktu & FIFO dipertahankan; dedup jurnal tetap perlu |
| `src/controllers/transaction.controller.js` → `checkTransactionStatus` | On-demand poll saat client cek status (tidak menunggu cron) + algoritma "kunci" jurnal: satu `gobiz_transaction_id` hanya boleh dipakai sekali | Diambil sebagai mode "instant verify" untuk tombol *Saya Sudah Membayar* |
| `src/controllers/merchant.controller.js` → `requestOtp/verifyOtp/setQr` | Normalisasi nomor (`62…`/`0…` → telanjang), persist device_id antara step OTP, upsert `merchant_accounts`, validasi kepemilikan saat `setQr` | Dipertahankan; penerima perintah berubah dari JWT-user menjadi **admin dashboard** |
| `public/app_v6.js` (line 338–356) | Upload gambar → `FileReader` → canvas → **jsQR decode → payload asli** → POST string | Dipindah ke **server-side** (jsqr + pngjs/jpeg-js, pure JS tanpa native) agar bisa dipakai dari dashboard admin apa pun perangkatnya |
| `GoMerchant.js` (root) | Versi mandiri SDK (untuk test) — termasuk contoh payload header lengkap | Referensi header; tidak dipakai langsung |

### 2.2 DIADAPTASI (pola dipertahankan, mesin diganti)

| go-merchant | Sensoria |
|---|---|
| MySQL (`mysql2`, pool manual) | **Supabase Postgres** via `@supabase/supabase-js` service-role (satu DB untuk semua — nol sync code) |
| Tabel `users` + JWT dashboard + API key | **Tidak ada auth sendiri.** Endpoint mobile → HMAC header; endpoint internal → dipanggil dari server action dashboard (service-to-service) |
| Tabel `transactions` sendiri + webhook ke client | **Ledger `public.transactions` yang sudah ada** (migration `20260911`): baris `pending` dibuat saat checkout, `settle_transaction(ref)` saat bayar — admin dashboard, royalti, refund, CSV otomatis melihatnya tanpa kode tambahan |
| `webhook.service.js` (retry 3×) | **Tidak perlu** — konsumennya mobile, verifikasi = re-read DB (sudah jadi pola `refreshEntitlement`) |
| `express-rate-limit` 50 req/menit di create | Dipertahankan + diperketat per device_id |

### 2.3 DIBUANG (dengan alasan tegas)

| Komponen | Alasan buang |
|---|---|
| `gopayAsli.service.js`, `gopayMidtrans.service.js`, `token.service.js`, `mutasiku.*`, frida scripts | **Mati oleh WAF GoGuard** — `waf_analysis.md` (dokumentasi mereka sendiri): `x-e1` ditandatangani native `libcvsdk.so`, memuat timestamp + hash dari access token; replay capture = **Error 1000 permanen**. Satu-satunya jalan = Frida hook perangkat asli 24/7 — tidak layak untuk production |
| `admin.controller.js`, `views/`, `public/index.html` | Dashboard kita sudah ada (Next.js admin); tak ada duplikasi UI |
| `device.generator.js` | Hanya untuk jalur Midtrans; GoBiz web cukup `uuid` sebagai `uniqueid` |

---

## 3. Fakta teknis krusial hasil reverse-engineering (wajib dipatuhi porting)

1. **Unit uang journals = sen.** `mutation.amount / 100` sebelum dicocokkan.
   (Worker asli: `mutation.amount / 100`; Midtrans history juga /100.)
2. **Matching = FIFO + jendela waktu + dedup.**
   `payment_time ∈ [created_at − 1 min, created_at + 5 min]`, nominal persis,
   ambil PENDING tertua; satu `reference_id` jurnal hanya boleh men-settle satu order
   (lock via cek `gobiz_transaction_id` sudah dipakai / unique index `mutation_logs`).
3. **`device_id` harus persisten per merchant.** Refresh token dipanggil dengan
   `uniqueid` yang sama saat login; ganti device = refresh bisa ditolak.
4. **Token GoBiz web kedaluwarsa diam-diam** — pola yang benar: coba → 401 →
   refresh → simpan → retry sekali. Jangan pre-emptive terus-menerus.
5. **Transformasi QRIS dinamis harus EMV-benar.** Versi asli memakai trik string
   (`slice(0,-4)` + replace `010211→010212` + split `5802ID`). Kita naikkan kelasnya:
   **parser + builder TLV penuh** — hapus tag `54` lama, set tag `01 = 12`, sisip
   tag `54` sebelum `58`, recompute CRC16. Tahan banting untuk payload statis
   arbitrary, dan sekaligus dipakai untuk **validasi** payload yang di-upload
   (CRC valid? mode `11`? tag `58=ID`? PAN ada?).
   Payload mode `12` (sudah dinamis / sekali pakai) **ditolak dengan pesan jelas**.
6. **Journals hanya menjawab bila access header + `accept: application/vnd.journal.v1+json`**
   dan filter `metadata.transaction.status ∈ {settlement, capture}` +
   `metadata.transaction.merchant_id` sama.
7. **`getMe()` → `user.merchant_id`** adalah identitas yang disimpan — bukan
   nomor HP. Satu akun GoBiz = satu baris merchant (unique).

---

## 4. Arsitektur `qris-api/` (service baru, port 3200, `app.aacsensoria.id`)

Sesuai roadmap deployment (§Fase 3 ROADMAP_DATA_DAN_DEPLOYMENT.md) dan kontrak
yang sudah tertanam di mobile (`QRIS_CHECKOUT_URL = https://app.aacsensoria.id/api/qris-checkout`).

```
qris-api/
  app.js                    — Express + helmet-lite + rate limit + /api/health
  src/gobiz.js              — SDK GoBiz (port dari goMerchant.service.js, dibersihkan)
  src/emv.js                — parser/builder TLV + CRC16 + validator payload statis
  src/decodeQris.js         — gambar → payload (jsqr + pngjs + jpeg-js, pure JS)
  src/store.js              — akses Supabase service-role (merchants, orders, plans, devices)
  src/settle.js             — FIFO matcher + pemanggil settle_transaction() + idempoten
  src/worker.js             — node-cron 60s: poll merchant ber-PENDING, expire order
  src/routes/mobile.js      — POST /api/qris-checkout, /api/qris-status   (HMAC)
  src/routes/internal.js    — merchant OTP/verify/set-qr/set-qr-image/status/refresh (HMAC, admin-only)
  .env.production           — PORT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, QRIS_API_SECRET, WORKER_*  (chmod 600, tidak pernah di-commit)
```

### 4.1 Tabel baru (satu migration: `20260914_qris_api.sql`)

```sql
-- QRIS merchant accounts (GoBiz web sessions)
CREATE TABLE IF NOT EXISTS public.qris_merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   text NOT NULL UNIQUE,      -- dari /v1/users/me
  merchant_name text NOT NULL,
  phone         text,
  device_id     text NOT NULL,             -- persistent uniqueid (refresh token tergantung ini)
  access_token  text,
  refresh_token text,
  token_updated_at timestamptz,
  static_qris   text,                      -- payload EMV asli (dari paste atau decode gambar)
  static_qris_source text CHECK (static_qris_source IN ('paste','image')),
  status        text NOT NULL DEFAULT 'active',  -- active | token_expired | disabled
  last_sync     timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- RLS: enable + policy SELECT untuk is_admin() — service role melewati RLS.

-- Payment intents milik API (ledger publik hanya menyimpan uang, bukan QR)
CREATE TABLE IF NOT EXISTS public.qris_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_ref text NOT NULL UNIQUE,     -- AAC-<ymd>-<rand> — KUNCI ke public.transactions
  child_device_id uuid NOT NULL REFERENCES public.devices(id),
  plan_id uuid NOT NULL REFERENCES public.plans(id),
  plan_kind text NOT NULL,                  -- snapshot kind saat checkout
  amount numeric(12,2) NOT NULL,            -- dari plans.price — TIDAK PERNAH dari klien
  merchant_db_id uuid REFERENCES public.qris_merchants(id),
  qr_string text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','failed')),
  matched_journal_id text UNIQUE,           -- lock: satu jurnal = satu order
  raw_journal jsonb,
  expires_at timestamptz NOT NULL,          -- default now()+15 menit
  paid_at timestamptz,
  created_at/updated_at …
);
CREATE INDEX … ON qris_orders (status, expires_at);
```

**Siklus uang (align penuh dengan ledger 20260911):**
checkout → INSERT `public.transactions (transaction_ref, child_device_id, plan_id,
amount, status='pending', payment_gateway='qris')` + INSERT `qris_orders` →
bayar terdeteksi → `UPDATE qris_orders SET status='paid'` +
**`SELECT public.settle_transaction(ref, raw_journal)`** → RPC membalik ledger
menjadi `paid` dan menerapkan plan **sekali**. Admin dashboard langsung melihat
baris `pending` begitu QR muncul (bagus untuk dukungan: "user sedang menatap QR ini").

### 4.2 Upgrade RPC yang WAJIB: `settle_transaction` menjadi kind-aware

`settle_transaction` saat ini selalu memanggil `apply_plan_purchase` (combo).
Untuk paket slot (kind `slots`) itu **salah** — akan menambah bulan langganan,
bukan slot. Migration meng-CREATE-OR-REPLACE menjadi:

```sql
SELECT kind INTO v_kind FROM public.plans WHERE id = v_row.plan_id;
IF v_kind = 'slots' THEN
  PERFORM public.apply_parent_slot_purchase(v_row.child_device_id, v_row.plan_id);
ELSE
  PERFORM public.apply_plan_purchase(v_row.child_device_id, v_row.plan_id);
END IF;
```

Kontrak return boolean tetap — pemanggil lama tidak berubah; jalur combo identik
dengan sebelumnya (aman terhadap regresi).

### 4.3 Endpoint

**Mobile (HMAC `X-Sensoria-Sign = HMAC-SHA256(rawBody, QRIS_API_SECRET)`):**

| Endpoint | Kontrak |
|---|---|
| `POST /api/qris-checkout` `{device_id, plan_id}` | Validasi: device ada & role child; plan aktif; (opsional: plan.kind vs konteks). Amount **selalu** dari `plans.price`. Buat ledger pending + order + QR dinamis → balik **persis** kontrak `createQrisCheckout`: `{order_id, qris_image_base64, qris_expires_at}` |
| `POST /api/qris-status` `{order_id}` | Instant-verify: poll journals on-demand (mode "kunci" ala `checkTransactionStatus` go-merchant) → settle bila match; balik `{status, paid_at}` |
| `GET /api/health` | UptimeRobot target |

**Internal (dipanggil server action dashboard; HMAC sama, plus cek admin):**

| Endpoint | Fungsi |
|---|---|
| `POST /internal/merchant/otp` `{phone}` | Normalisasi nomor → OTP GoBiz → balik `{otp_token, device_id}` (device_id baru disimpan sementara & diwajibkan kembali saat verify — pola asli) |
| `POST /internal/merchant/verify` `{phone, otp, otp_token, device_id}` | `verifyOtp` → `getMe` → upsert `qris_merchants` (token + device persisten) |
| `POST /internal/merchant/qr` `{merchant_id, payload}` | Validasi EMV (CRC, mode `11`, tag `58=ID`) → simpan `static_qris (source 'paste')` |
| `POST /internal/merchant/qr-image` (multipart) | Decode gambar server-side → payload → validasi sama → simpan `source 'image'` — **inilah "upload gambar QRIS resmi untuk mendapatkan payload aslinya"** |
| `GET /internal/merchant/status` | Daftar merchant + token health + last_sync + ada/tidaknya static QR |
| `POST /internal/merchant/refresh` `{merchant_id}` | Paksa refresh token |

### 4.4 Worker (cron 60 detik)

Port literal dari `worker.service.js`:
1. Expire order `pending` lewat `expires_at` → `failed`+ledger `failed`? —
   **tidak**: order expired cukup `status='expired'`; baris ledger dibiarkan
   `pending` hingga admin/gateway menandai `failed` (ledger policy saat ini hanya
   punya pending/paid/failed — set `failed` saat expire agar dashboard bersih).
2. **Smart selection**: hanya merchant yang memiliki order `pending` ( hemat
   panggilan, pola asli).
3. `getJournals` → filter settlement/capture → dedup (`matched_journal_id` UNIQUE) →
   FIFO match → settle.
4. 401 → refresh token sekali → retry; refresh gagal keras → `status='token_expired'`
   (dashboard menampilkan peringatan; verifikasi tetap mungkin via instant-verify
   setelah re-link).
5. Setelah settle: notifikasi Telegram paid baru otomatis mengalir — dashboard
   subscription polling & notifikasi sudah membaca ledger.

### 4.5 Keamanan — jujur tentang apa yang bisa dan tidak bisa

- HMAC dari mobile **bukan** rahasia kuat (secret ikut ter-bundle di APK) — ia
  menyaring scanner kasar. Keamanan sesungguhnya: amount & kind **selalu** dari
  server (`plans`), device diverifikasi ada, rate-limit per IP+device, ledger
  append-only dengan CHECK constraint.
- Token GoBiz & payload QRIS statis **hanya di server** (service role). Mobile
  tidak pernah melihatnya — hanya gambar QR jadi.
- Endpoint internal tidak terekspos publik kecuali lewat domain API; pertimbangkan
  allowlist IP VPS di Nginx untuk `/internal/*` (Fase 2 roadmap).

---

## 5. Risiko & catatan operasional (dibaca sebelum go-live)

1. **API tidak resmi.** Ini integrasi sesi web GoBiz (OTP login), bukan kemitraan
   resmi. Konsekuensi: bisa berubah tanpa pengumuman; volume besar/multi-akun
   agresif berisiko flag. Konfigurasi kita adalah yang paling jinak: **satu akun
   merchant milik sendiri**, volume kecil, uang masuk ke rekening GoBiz sendiri,
   journals hanya dibaca. Jaga kebersihan: refresh token jangan dibagikan, satu
   device_id per akun, hindari polling tanpa PENDING.
2. **Tabrakan nominal**: harga kita (49rb / 249rb / 1,99jt / 25rb slot) tidak
   saling bertabrakan; dua keluarga berbeda membayar nominal sama dalam jendela
   menit yang sama adalah kasus FIFO — tertua menang, dan jurnal terkunci per
   `reference_id`. Kalau volume naik, tuas berikutnya: variasikan amount
   (+Rp 1…99 unik per order, tercatat di `qris_orders.amount`) — desain kolom
   sudah mendukung karena matching memakai `qris_orders.amount`.
3. **QRIS statis yang di-upload HARUS mode statis (`01=11`)** — QR dinamis hasil
   generate sekali-pakai tidak bisa dipakai ulang; validator menolak dengan pesan
   jelas. Upload dari **Gojek Merchant → QRIS saya** (gambar asli), bukan
   tangkapan layar QR transaksi.
4. **Journals = sumber kebenaran uang** — bukan notifikasi push. Latensi deteksi
   = interval cron (60 s) atau instant-verify saat user menekan
   *Saya Sudah Membayar* (biasanya < 5 s).
5. **WAF GoPay Merchant adalah jalan buntu** (dokumentasi mereka sendiri,
   §2.3) — jangan pernah mengejar jalur Midtrans tanpa Frida; jalur GoBiz web
   tervalidasi jalan (worker asli memakainya tiap 2 menit).

---

## 6. Urutan build (rencana eksekusi)

1. **Migration** `20260914_qris_api.sql` — tabel + RLS + settle kind-aware + index.
2. **`qris-api/` skeleton** — `emv.js` (+ unit test CRC/TLV), `gobiz.js`, `store.js`.
3. **Checkout path** — `/api/qris-checkout` + `/api/qris-status` + HMAC middleware;
   uji dengan plan combo Rp 49.000 (QR ter-render, ledger pending muncul).
4. **Worker + settle** — cron, FIFO matcher, `settle_transaction`; uji end-to-end
   transfer kecil sungguhan (combo dulu, lalu slot pack Rp 25.000 → kapasitas naik).
5. **Admin provisioning UI** — panel "Payment Gateway" di dashboard:
   form OTP taut akun, upload/paste QRIS statis (via endpoint internal), status
   token, tombol refresh; semua server action ber-gate Owner + audit log
   (`qris_merchant_link`, `qris_static_qr_set`, `qris_token_refresh`).
6. **Mobile** — nol perubahan kode (kontrak sudah dipenuhi); hanya uji
   end-to-end dari PaywallScreen dan sheet slot.
7. **Deployment** — aaPanel: PM2 `qris-api` port 3200, Nginx reverse proxy
   `app.aacsensoria.id` + SSL (dokumen roadmap Fase 3 sudah menulis checklist).

Perkiraan: langkah 1–4 adalah inti (satu sesi kerja), 5 menyusul, 6 verifikasi.
