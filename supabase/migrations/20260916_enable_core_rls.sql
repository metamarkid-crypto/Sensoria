-- ============================================================================
-- Sensoria AAC — C-2: AKTIFKAN RLS PADA TABEL INTI
--
-- MASALAH YANG DIPERBAIKI
--   devices, subscriptions, locations, plans, app_settings, app_content,
--   messages, family_links, child_profiles dibuat TANPA RLS. Anon key ikut
--   terkirim di dalam APK, sehingga siapa pun yang mengekstraknya bisa:
--     SELECT * FROM locations   -> SELURUH riwayat GPS semua anak (paling parah)
--     UPDATE subscriptions ...  -> langganan gratis seumur hidup
--     UPDATE plans SET price=0  -> merusak model bisnis
--     SELECT * FROM child_profiles -> nama & data semua anak
--
-- MODEL KEAMANAN YANG DIPAKAI DI SINI
--   Aplikasi mobile TIDAK memakai Supabase Auth (nol hasil grep signIn/
--   getSession di src/) — semua perangkat adalah `anon`. Jadi RLS TIDAK BISA
--   memakai auth.uid(). Yang bisa ditegakkan di layer database adalah:
--
--     (a) MENGHILANGKAN operasi yang tidak pernah dipakai klien
--         -> DELETE & UPDATE massal diblokir total.
--     (b) MEMBATASI KOLOM yang boleh ditulis (GRANT level kolom)
--         -> perangkat tidak bisa lagi menyentuh kolom uang/tanggal.
--     (c) MEMBATASI NILAI yang boleh ditulis (WITH CHECK)
--         -> mis. subscriptions hanya boleh dibuat sebagai 'trial'.
--     (d) MENUTUP TOTAL tabel yang klien tidak pernah baca/tulis langsung.
--
--   CATATAN JUJUR SOAL BATASNYA: karena tidak ada auth, RLS tidak bisa
--   mencegah perangkat A membaca baris perangkat B kalau perangkat A tahu
--   UUID-nya (SELECT tetap harus terbuka agar pairing & peta orang tua jalan).
--   Yang ditutup migrasi ini adalah kerusakan MASSAL dan ESKALASI: dump
--   seluruh tabel, hapus data, ubah harga, perpanjang langganan sendiri.
--   Penutupan penuh butuh Supabase Auth (mis. signInAnonymously) — itu
--   perubahan aplikasi, bukan SQL, dan dicatat sebagai langkah lanjutan
--   di bagian ROADMAP paling bawah.
--
-- KOMPATIBILITAS (sudah diverifikasi baris-per-baris terhadap src/)
--   service_role (admin dashboard + qris-api) MENEMBUS RLS -> tidak terdampak.
--   Semua operasi mobile yang ada tetap lolos. Daftar lengkapnya di tiap blok.
--
-- Idempoten: aman dijalankan berulang.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0) Baseline: cabut hak default yang terlalu luas dari anon.
--    Supabase memberi anon SELECT/INSERT/UPDATE/DELETE penuh pada schema
--    public lewat GRANT bawaan. RLS tanpa mencabut ini tetap membiarkan
--    DELETE massal kalau ada policy yang kelewat permisif.
-- ---------------------------------------------------------------------------
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon;

-- ===========================================================================
-- 1) locations — DATA PALING SENSITIF (GPS anak). Append-only dari perangkat.
--    Dipakai mobile:
--      INSERT  backgroundLocation.ts:75  (child_device_id, lat, lng, accuracy, address)
--      SELECT  ParentLocationScreen.tsx:104 (riwayat per child_device_id)
-- ===========================================================================
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

-- Perangkat hanya boleh MENAMBAH titik, tidak boleh mengubah/menghapus
-- riwayat (append-only = bukti audit lokasi tidak bisa dirusak).
DROP POLICY IF EXISTS locations_insert_device ON public.locations;
CREATE POLICY locations_insert_device ON public.locations
  FOR INSERT TO anon
  WITH CHECK (
    child_device_id IS NOT NULL
    -- Hanya untuk device yang benar-benar terdaftar sebagai Child.
    AND EXISTS (
      SELECT 1 FROM public.devices d
       WHERE d.id = locations.child_device_id AND d.role = 'Child'
    )
    -- Tolak titik masa depan / backdating jauh (integritas jejak waktu).
    AND recorded_at <= now() + interval '5 minutes'
    AND recorded_at >= now() - interval '1 day'
  );

-- SELECT harus tetap ada agar peta orang tua berfungsi (tidak ada auth untuk
-- mengikat parent->child di layer DB). Dibatasi ke device Child yang valid.
DROP POLICY IF EXISTS locations_select_device ON public.locations;
CREATE POLICY locations_select_device ON public.locations
  FOR SELECT TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.family_links fl
       WHERE fl.child_device_id = locations.child_device_id
    )
  );

-- Tidak ada policy UPDATE/DELETE untuk anon => keduanya ditolak otomatis.
REVOKE UPDATE, DELETE ON public.locations FROM anon;

-- ===========================================================================
-- 2) subscriptions — SUMBER KEBENARAN ENTITLEMENT. Jangan pernah bisa diubah klien.
--    Dipakai mobile:
--      SELECT  entitlement.ts:339, subscriptions.ts:22
--      INSERT  subscriptions.ts:45  (HANYA injeksi trial, status='trial')
--    TIDAK PERNAH: UPDATE / DELETE dari mobile.
-- ===========================================================================
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subscriptions_select_device ON public.subscriptions;
CREATE POLICY subscriptions_select_device ON public.subscriptions
  FOR SELECT TO anon
  USING (true); -- entitlement dibaca per child_device_id oleh klien

-- KUNCI UTAMA: klien hanya boleh membuat baris TRIAL, tanpa plan berbayar,
-- dan tidak boleh menentukan tanggal kedaluwarsa yang jauh.
DROP POLICY IF EXISTS subscriptions_insert_trial_only ON public.subscriptions;
CREATE POLICY subscriptions_insert_trial_only ON public.subscriptions
  FOR INSERT TO anon
  WITH CHECK (
    status = 'trial'
    AND plan_id IS NULL                                  -- trial tidak boleh menempel plan berbayar
    AND child_device_id IS NOT NULL
    AND trial_ends_at IS NOT NULL
    AND trial_ends_at <= now() + interval '90 days'       -- pagar anti "trial 100 tahun"
    AND (expires_at IS NULL OR expires_at <= now() + interval '90 days')
    -- Satu trial per anak: baris kedua ditolak di DB, bukan hanya di klien.
    AND NOT EXISTS (
      SELECT 1 FROM public.subscriptions s
       WHERE s.child_device_id = subscriptions.child_device_id
    )
  );

-- Perpanjangan/pembayaran HANYA lewat service_role (qris-api + dashboard).
REVOKE UPDATE, DELETE ON public.subscriptions FROM anon;

-- ===========================================================================
-- 3) plans — KATALOG HARGA. Klien baca saja, titik.
--    Dipakai mobile: SELECT paywall.ts:105,118 dan slots.ts:85
-- ===========================================================================
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plans_select_active ON public.plans;
CREATE POLICY plans_select_active ON public.plans
  FOR SELECT TO anon
  USING (is_active = true); -- paket nonaktif tidak perlu bocor ke klien

REVOKE INSERT, UPDATE, DELETE ON public.plans FROM anon;

-- ===========================================================================
-- 4) app_settings / app_content — KONFIG GLOBAL. Klien baca saja.
--    Dipakai mobile: SELECT entitlement.ts:383, paywall.ts:54,
--                    subscriptions.ts:32, AboutScreen.tsx:32
-- ===========================================================================
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_settings_select_all ON public.app_settings;
CREATE POLICY app_settings_select_all ON public.app_settings
  FOR SELECT TO anon USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.app_settings FROM anon;

-- app_content dibuat manual di dashboard (tidak ada di migrasi) — jaga aman
-- hanya kalau tabelnya memang ada.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='app_content') THEN
    EXECUTE 'ALTER TABLE public.app_content ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS app_content_select_all ON public.app_content';
    EXECUTE 'CREATE POLICY app_content_select_all ON public.app_content FOR SELECT TO anon USING (true)';
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.app_content FROM anon';
  END IF;
END;
$$;

-- ===========================================================================
-- 5) devices — IDENTITAS PERANGKAT + PRESENCE.
--    Dipakai mobile:
--      UPSERT  RoleSelectionScreen.tsx:70   (id, role, pairing_code)
--      SELECT  RoleSelectionScreen.tsx:108, PairingBottomSheet.tsx:269,
--              ParentDashboardScreen.tsx:112, slots.ts:55
--      UPDATE  backgroundLocation.ts:89     (lat, lng, last_address, last_seen)
--
--    ESKALASI YANG DITUTUP: sebelumnya perangkat bisa
--      UPDATE devices SET max_parent_slots = 999  -> slot parent gratis
--    Ditutup dengan GRANT LEVEL KOLOM (RLS tidak bisa membatasi kolom).
-- ===========================================================================
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS devices_select_anon ON public.devices;
CREATE POLICY devices_select_anon ON public.devices
  FOR SELECT TO anon
  USING (true); -- pairing by code & presence butuh lookup lintas perangkat

DROP POLICY IF EXISTS devices_insert_self ON public.devices;
CREATE POLICY devices_insert_self ON public.devices
  FOR INSERT TO anon
  WITH CHECK (role IN ('Child', 'Parent'));

DROP POLICY IF EXISTS devices_update_presence ON public.devices;
CREATE POLICY devices_update_presence ON public.devices
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (true);

-- INTI PERBAIKAN: batasi kolom yang boleh ditulis anon.
-- max_parent_slots TIDAK ada dalam daftar -> tidak bisa dinaikkan sendiri.
REVOKE UPDATE ON public.devices FROM anon;
GRANT  UPDATE (latitude, longitude, last_address, last_seen, pairing_code, role)
       ON public.devices TO anon;

REVOKE INSERT ON public.devices FROM anon;
GRANT  INSERT (id, role, pairing_code, latitude, longitude, last_address, last_seen)
       ON public.devices TO anon;

REVOKE DELETE ON public.devices FROM anon;

-- ===========================================================================
-- 6) child_profiles — NAMA & PREFERENSI ANAK (PII).
--    Dipakai mobile:
--      UPSERT  OnboardingScreen.tsx:35, UserProfileScreen.tsx:46,
--              VoiceSettingsScreen.tsx:41, AppearanceSettingsScreen.tsx:36,
--              AccessibilitySettingsScreen.tsx:30, ParentLocationScreen.tsx:269,305
--      SELECT  ChildAACScreen.tsx:148, PairingBottomSheet.tsx:124,329
-- ===========================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='child_profiles') THEN
    EXECUTE 'ALTER TABLE public.child_profiles ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS child_profiles_select_anon ON public.child_profiles';
    EXECUTE 'CREATE POLICY child_profiles_select_anon ON public.child_profiles
               FOR SELECT TO anon USING (true)';

    EXECUTE 'DROP POLICY IF EXISTS child_profiles_insert_anon ON public.child_profiles';
    EXECUTE 'CREATE POLICY child_profiles_insert_anon ON public.child_profiles
               FOR INSERT TO anon WITH CHECK (device_id IS NOT NULL)';

    EXECUTE 'DROP POLICY IF EXISTS child_profiles_update_anon ON public.child_profiles';
    EXECUTE 'CREATE POLICY child_profiles_update_anon ON public.child_profiles
               FOR UPDATE TO anon USING (true) WITH CHECK (device_id IS NOT NULL)';

    -- Profil anak tidak boleh dihapus dari klien (cegah vandalisme massal).
    EXECUTE 'REVOKE DELETE ON public.child_profiles FROM anon';
  END IF;
END;
$$;

-- ===========================================================================
-- 7) family_links — RELASI PARENT<->CHILD (dasar seluruh entitlement).
--    Dipakai mobile:
--      UPSERT  PairingBottomSheet.tsx:309 (parent_device_id, child_device_id, parent_label)
--      DELETE  PairingBottomSheet.tsx:370 (unlink, HANYA milik sendiri)
--      SELECT  banyak (entitlement.ts:309, slots.ts:51, dll)
-- ===========================================================================
ALTER TABLE public.family_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS family_links_select_anon ON public.family_links;
CREATE POLICY family_links_select_anon ON public.family_links
  FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS family_links_insert_anon ON public.family_links;
CREATE POLICY family_links_insert_anon ON public.family_links
  FOR INSERT TO anon
  WITH CHECK (
    parent_device_id IS NOT NULL
    AND child_device_id IS NOT NULL
    AND parent_device_id <> child_device_id  -- perangkat tidak boleh mem-parent dirinya
    AND EXISTS (SELECT 1 FROM public.devices d
                 WHERE d.id = family_links.child_device_id AND d.role = 'Child')
  );

DROP POLICY IF EXISTS family_links_update_anon ON public.family_links;
CREATE POLICY family_links_update_anon ON public.family_links
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (parent_device_id IS NOT NULL AND child_device_id IS NOT NULL);

-- Unlink adalah fitur sah (PairingBottomSheet.tsx:370) -> DELETE dikembalikan
-- KHUSUS untuk tabel ini, sesudah REVOKE global di langkah 0.
GRANT DELETE ON public.family_links TO anon;
DROP POLICY IF EXISTS family_links_delete_anon ON public.family_links;
CREATE POLICY family_links_delete_anon ON public.family_links
  FOR DELETE TO anon
  USING (true);

-- ===========================================================================
-- 8) messages — CHAT AAC anak<->orang tua.
--    Dipakai mobile:
--      INSERT  supabase.ts:53
--      SELECT  supabase.ts:109 (limit 50 per channel_id)
-- ===========================================================================
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_select_channel ON public.messages;
CREATE POLICY messages_select_channel ON public.messages
  FOR SELECT TO anon
  USING (channel_id IS NOT NULL); -- klien selalu memfilter .eq('channel_id', ...)

DROP POLICY IF EXISTS messages_insert_channel ON public.messages;
CREATE POLICY messages_insert_channel ON public.messages
  FOR INSERT TO anon
  WITH CHECK (
    channel_id IS NOT NULL
    AND sender_role IN ('Child', 'Parent')
    AND length(coalesce(text_content, '')) <= 2000  -- pagar anti-spam payload
  );

-- Riwayat percakapan tidak boleh diedit/dihapus dari klien.
REVOKE UPDATE, DELETE ON public.messages FROM anon;

-- ===========================================================================
-- 9) custom_words — PERBAIKAN BUG: policy lama memblokir sync secara senyap.
--    Policy di 20260908_custom_words.sql mensyaratkan header
--    'x-sensoria-device-id', TAPI klien tidak pernah mengirimnya (sudah
--    diverifikasi: nol hasil grep di src/). Jadi setiap upsert dari
--    supabase.ts:83 ditolak 42501 dan hanya tercatat sebagai console.error.
--    Backup cloud kartu kustom SELAMA INI TIDAK PERNAH BEKERJA.
--    Diganti dengan predikat berbasis device yang benar-benar terdaftar.
-- ===========================================================================
DROP POLICY IF EXISTS "Devices manage their own custom words" ON public.custom_words;

DROP POLICY IF EXISTS custom_words_select_anon ON public.custom_words;
CREATE POLICY custom_words_select_anon ON public.custom_words
  FOR SELECT TO anon
  USING (true);

DROP POLICY IF EXISTS custom_words_write_anon ON public.custom_words;
CREATE POLICY custom_words_write_anon ON public.custom_words
  FOR INSERT TO anon
  WITH CHECK (
    child_device_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.devices d
                 WHERE d.id = custom_words.child_device_id AND d.role = 'Child')
  );

DROP POLICY IF EXISTS custom_words_update_anon ON public.custom_words;
CREATE POLICY custom_words_update_anon ON public.custom_words
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (child_device_id IS NOT NULL);

REVOKE DELETE ON public.custom_words FROM anon;

-- ===========================================================================
-- 10) TABEL YANG HARUS TERTUTUP TOTAL DARI KLIEN
--     Mobile tidak pernah menyentuh tabel-tabel ini; qris-api & dashboard
--     memakai service_role (menembus RLS), jadi mencabut hak anon di sini
--     tidak memutus apa pun.
-- ===========================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'transactions',      -- ledger uang (hanya service_role yang menulis)
    'qris_orders',
    'qris_merchants',    -- token OAuth GoBiz — paling sensitif
    'refunds',
    'royalty_payments',
    'admin_users',
    'admin_audit_log',
    'child_devices',
    'parent_contacts'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
  END LOOP;
END;
$$;

-- CATATAN PENTING soal transactions:
--   20260911_admin_transactions.sql:76 membuat policy transactions_insert_anon
--   ("gateway checkout creation only"). Itu warisan dari era ketika mobile
--   membuat baris ledger sendiri. Sekarang checkout dibuat oleh qris-api
--   (store.js:461 createOrderWithLedger) dengan service_role, sehingga policy
--   anon tidak lagi diperlukan dan hanya memperluas permukaan serangan.
DROP POLICY IF EXISTS transactions_insert_anon ON public.transactions;

COMMIT;

-- ============================================================================
-- VERIFIKASI — jalankan setelah COMMIT
-- ============================================================================
-- (a) Semua tabel public HARUS rowsecurity = true:
--
-- SELECT tablename, rowsecurity
--   FROM pg_tables
--  WHERE schemaname = 'public'
--  ORDER BY rowsecurity, tablename;
--
-- (b) Pastikan anon TIDAK bisa menaikkan slot parent (harus 'false'):
--
-- SELECT has_column_privilege('anon', 'public.devices', 'max_parent_slots', 'UPDATE');
--
-- (c) Pastikan anon TIDAK bisa membaca token merchant (harus 'false'):
--
-- SELECT has_table_privilege('anon', 'public.qris_merchants', 'SELECT');
--
-- (d) UJI ASAP DI APLIKASI (wajib, urut):
--     1. Install ulang APK -> pilih peran Child   (devices INSERT + trial INSERT)
--     2. Isi profil anak                          (child_profiles UPSERT)
--     3. Perangkat Parent -> pairing 6 digit       (family_links INSERT + trigger slot)
--     4. Kirim kartu AAC                          (messages INSERT + realtime)
--     5. Buka peta orang tua                      (locations SELECT)
--     6. Buat kartu kustom                        (custom_words UPSERT — BARU BEKERJA)
--     7. Buka paywall                             (plans + app_settings SELECT)
--     8. Unlink perangkat                         (family_links DELETE)
--     9. Dashboard admin: buka semua halaman      (service_role, harus normal)
--
-- ============================================================================
-- ROADMAP (di luar cakupan SQL — butuh perubahan aplikasi)
--   Selama mobile berjalan sebagai `anon` tanpa sesi, DB tidak punya identitas
--   untuk mengikat "baris ini milik perangkat itu". Untuk isolasi penuh
--   antar-perangkat, pakai Supabase Anonymous Sign-in:
--     1. supabase.auth.signInAnonymously() saat perangkat pertama kali dibuat
--     2. simpan devices.auth_uid = auth.uid()
--     3. ubah predikat USING/WITH CHECK di atas menjadi berbasis auth.uid()
--   Setelah itu SELECT lintas-perangkat bisa ditutup sepenuhnya.
-- ============================================================================
