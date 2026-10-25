-- ============================================================================
-- Sensoria AAC — CEK KESIAPAN PUSH NOTIFICATION (read-only)
-- ============================================================================
-- Cara pakai:
--   1. Buka Supabase Dashboard → project Anda → SQL Editor → New query.
--   2. Tempel SELURUH isi file ini, tekan Run.
--   3. Baca tabel hasil di bawah. Baris 1-6 harus "OK".
--
-- Skrip ini TIDAK menulis/mengubah data aplikasi: hanya membaca katalog dan
-- mengisi tabel sementara (TEMP) yang hilang sendiri saat sesi SQL berakhir.
-- Aman dijalankan berkali-kali.
--
-- Kenapa dibungkus DO + EXECUTE: kalau migrasi push BELUM dijalankan, tabel
-- device_push_tokens tidak ada. Query biasa yang menyebut nama tabel itu akan
-- gagal total ("relation does not exist") sehingga kita tidak pernah tahu
-- bagian mana yang sudah beres. Di sini setiap cek berdiri sendiri.
-- ============================================================================

-- TANPA "ON COMMIT DROP": SQL Editor Supabase menjalankan tiap statement
-- dalam transaksi sendiri, jadi ON COMMIT DROP akan menghapus tabel ini tepat
-- setelah CREATE dan seluruh blok DO di bawahnya gagal.
DROP TABLE IF EXISTS pg_temp.push_check;
CREATE TEMP TABLE push_check (
  no     int,
  cek    text,
  hasil  text
);

DO $$
DECLARE
  v_ada_tabel   boolean;
  v_kolom       text;
  v_policy      int;
  v_rls         boolean;
  v_total       int := 0;
  v_bersuara    int := 0;
  v_anak        int := 0;
  v_ortu        int := 0;
  v_segar       int := 0;
  v_msg24       int := 0;
  v_msg_cocok   int := 0;
  v_anak_dev    int := 0;
  v_links       int := 0;
BEGIN
  -- 1) pg_net ───────────────────────────────────────────────────────────────
  INSERT INTO push_check VALUES (1, 'pg_net terpasang',
    CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')
         THEN 'OK — HTTP async dari SQL tersedia'
         ELSE 'GAGAL — jalankan: create extension if not exists pg_net;'
    END);

  -- 2) tabel token ──────────────────────────────────────────────────────────
  v_ada_tabel := to_regclass('public.device_push_tokens') IS NOT NULL;
  INSERT INTO push_check VALUES (2, 'tabel device_push_tokens',
    CASE WHEN v_ada_tabel THEN 'OK — tabel ada'
         ELSE 'GAGAL — migrasi 20261024_expo_push_notifications.sql belum dijalankan'
    END);

  -- 3) kolom wajib ──────────────────────────────────────────────────────────
  SELECT coalesce(string_agg(column_name, ' · ' ORDER BY ordinal_position), '')
    INTO v_kolom
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'device_push_tokens';

  INSERT INTO push_check VALUES (3, 'kolom device_push_tokens',
    CASE WHEN NOT v_ada_tabel THEN 'LEWATI — tabel belum ada'
         WHEN v_kolom LIKE '%token%' AND v_kolom LIKE '%speak%'
          AND v_kolom LIKE '%language%' AND v_kolom LIKE '%role%'
         THEN 'OK — ' || v_kolom
         ELSE 'GAGAL — kolom kurang: ' || coalesce(nullif(v_kolom, ''), '(kosong)')
    END);

  -- 4) RLS + policy ─────────────────────────────────────────────────────────
  IF v_ada_tabel THEN
    SELECT relrowsecurity INTO v_rls
      FROM pg_class WHERE oid = 'public.device_push_tokens'::regclass;
    SELECT count(*) INTO v_policy
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'device_push_tokens';
  END IF;

  INSERT INTO push_check VALUES (4, 'RLS + policy token',
    CASE WHEN NOT v_ada_tabel THEN 'LEWATI — tabel belum ada'
         WHEN coalesce(v_rls, false) AND v_policy >= 3
         THEN 'OK — RLS aktif, ' || v_policy || ' policy (insert/update/delete)'
         ELSE 'GAGAL — RLS/policy belum lengkap (' || coalesce(v_policy, 0) || ' policy)'
    END);

  -- 5) trigger ──────────────────────────────────────────────────────────────
  INSERT INTO push_check VALUES (5, 'trigger messages_push_notify',
    CASE WHEN EXISTS (SELECT 1 FROM pg_trigger
                       WHERE tgname = 'messages_push_notify' AND NOT tgisinternal)
         THEN 'OK — AFTER INSERT pada public.messages'
         ELSE 'GAGAL — trigger belum ada; migrasi push belum dijalankan'
    END);

  -- 6) fungsi trigger ───────────────────────────────────────────────────────
  INSERT INTO push_check VALUES (6, 'fungsi notify_message_push',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                        JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public' AND p.proname = 'notify_message_push')
         THEN 'OK — fungsi ada'
         ELSE 'GAGAL — fungsi belum ada'
    END);

  -- 7) isi tabel token ──────────────────────────────────────────────────────
  IF v_ada_tabel THEN
    EXECUTE $q$
      SELECT count(*),
             count(*) FILTER (WHERE speak),
             count(*) FILTER (WHERE role = 'Child'),
             count(*) FILTER (WHERE role = 'Parent'),
             count(*) FILTER (WHERE updated_at > now() - interval '7 days')
        FROM public.device_push_tokens
    $q$ INTO v_total, v_bersuara, v_anak, v_ortu, v_segar;
  END IF;

  INSERT INTO push_check VALUES (7, 'token terdaftar',
    CASE WHEN NOT v_ada_tabel THEN 'LEWATI — tabel belum ada'
         WHEN v_total = 0
         THEN 'BELUM ADA — buka app di HP, izinkan notifikasi, lalu kembali ke sini'
         ELSE 'OK — ' || v_total || ' token (' || v_bersuara || ' bersuara, '
              || v_anak || ' anak / ' || v_ortu || ' orang tua, '
              || v_segar || ' aktif 7 hari)'
    END);

  -- 8) umur token ───────────────────────────────────────────────────────────
  INSERT INTO push_check VALUES (8, 'umur token',
    CASE WHEN NOT v_ada_tabel THEN 'LEWATI — tabel belum ada'
         WHEN v_total = 0 THEN 'LEWATI — belum ada token'
         WHEN v_segar = 0
         THEN 'PERINGATAN — tidak ada token diperbarui 7 hari; app mungkin di-uninstall'
         ELSE 'OK — ada token yang diperbarui < 7 hari'
    END);

  -- 9) pesan 24 jam terakhir ────────────────────────────────────────────────
  SELECT count(*),
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.devices d
            WHERE d.pairing_code = m.channel_id AND d.role = 'Child'))
    INTO v_msg24, v_msg_cocok
    FROM public.messages m
   WHERE m.timestamp IS NOT NULL
     AND to_timestamp(m.timestamp / 1000.0) > now() - interval '24 hours';

  INSERT INTO push_check VALUES (9, 'pesan 24 jam terakhir',
    'INFO — ' || coalesce(v_msg24, 0) || ' pesan, ' || coalesce(v_msg_cocok, 0)
    || ' di antaranya ber-channel perangkat anak (hanya yang ini bisa memicu push)');

  -- 10) perangkat anak + link orang tua ─────────────────────────────────────
  SELECT count(*) INTO v_anak_dev FROM public.devices WHERE role = 'Child';
  SELECT count(*) INTO v_links FROM public.family_links;

  INSERT INTO push_check VALUES (10, 'perangkat anak terdaftar',
    CASE WHEN v_anak_dev = 0
         THEN 'BELUM ADA — pairing perangkat anak dulu di app'
         ELSE 'INFO — ' || v_anak_dev || ' perangkat anak, ' || v_links
              || ' link orang tua-anak'
    END);
END $$;

SELECT no, cek, hasil FROM push_check ORDER BY no;

-- ============================================================================
-- BLOK 2: RESPONS EXPO PUSH TERAKHIR — bukti paling langsung trigger jalan.
-- Jalankan terpisah (blok ini sengaja dikomentari karena net._http_response
-- hanya ada bila pg_net sudah terpasang DAN pernah dipakai).
-- ============================================================================
--
-- select id, status_code, left(content::text, 400) as respons, created
--   from net._http_response
--  order by created desc
--  limit 5;
--
-- Arti hasilnya:
--   200 + {"data":[{"status":"ok"}]}      → push terkirim
--   200 + "DeviceNotRegistered"           → token mati; hapus barisnya, buka app lagi
--   200 + "MismatchSenderId"              → google-services.json di APK beda project
--                                            dengan service account di EAS
--   401                                    → Enhanced Push Security aktif; trigger
--                                            butuh header Authorization Bearer
--   400 + SENDER_ID_MISMATCH              → sama seperti MismatchSenderId
--   TIDAK ADA BARIS SAMA SEKALI            → trigger tidak jalan (cek baris 5), atau
--                                            channel_id ≠ pairing_code anak
