-- ============================================================================
-- Sensoria AAC — HARDENING hak akses push token
-- ============================================================================
--
-- MASALAH yang ditemukan saat audit database produksi (25 Okt 2026):
--
--   information_schema.role_table_grants untuk anon pada device_push_tokens:
--     DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--
--   Migrasi 20261024 hanya memberi `GRANT INSERT, UPDATE, DELETE`, tetapi
--   Supabase punya DEFAULT PRIVILEGES di schema public yang otomatis memberi
--   ALL ke anon untuk setiap tabel baru. Jadi klaim "tidak ada SELECT" di
--   komentar migrasi itu TIDAK benar di level GRANT.
--
--   Praktisnya data belum bocor: RLS aktif dan tidak ada policy SELECT, jadi
--   `set role anon; select * from device_push_tokens` mengembalikan 0 baris
--   (sudah diuji di produksi). Tapi TRUNCATE tidak tunduk pada RLS, dan
--   pertahanan berlapis itu murah — jadi grant-nya diselaraskan dengan niat.
--
--   Fungsi notify_message_push() juga masih punya EXECUTE untuk PUBLIC
--   (`=X/postgres`). Ia SECURITY DEFINER, jadi tidak seharusnya bisa dipanggil
--   anon langsung; hanya trigger yang perlu mengeksekusinya.
--
-- KENAPA ADA GRANT SELECT KOLOM (bukan tabel):
--   Percobaan pertama hardening mencabut SELECT sepenuhnya dan itu MEMATAHKAN
--   app. PostgreSQL mewajibkan privilege SELECT pada setiap kolom yang dibaca
--   di klausa WHERE, bahkan untuk UPDATE/DELETE:
--
--     set role anon;
--     update device_push_tokens set speak=false where token='...';
--     → ERROR: permission denied for table device_push_tokens
--
--   Padahal `has_table_privilege('anon', ..., 'UPDATE')` = true. pushTokens.ts
--   memakai pola itu (`.update(...).eq('token', ...)`, `.delete().eq('device_id',
--   ...)`), jadi tanpa SELECT kolom, mematikan notifikasi dan prune token lama
--   akan gagal diam-diam (hanya jadi console.warn).
--
--   Solusinya: SELECT tingkat KOLOM hanya pada token + device_id. Cukup untuk
--   WHERE, tapi `select * from device_push_tokens` tetap ditolak, dan karena
--   tidak ada policy SELECT, RLS juga mengembalikan 0 baris.
--
-- IDEMPOTEN: aman dijalankan berulang.
-- ============================================================================

-- 1) Cabut hak yang tidak dipakai klien (termasuk SELECT tabel penuh).
REVOKE ALL ON public.device_push_tokens FROM anon, authenticated;

GRANT INSERT, UPDATE, DELETE ON public.device_push_tokens TO anon;
-- Hanya kolom yang muncul di WHERE. Tanpa ini UPDATE/DELETE gagal.
GRANT SELECT (token, device_id) ON public.device_push_tokens TO anon;
-- authenticated sengaja TIDAK diberi apa pun: app selalu memakai anon key.

-- 2) Trigger function: hanya trigger, bukan pemanggilan langsung.
REVOKE ALL ON FUNCTION public.notify_message_push() FROM PUBLIC, anon, authenticated;
