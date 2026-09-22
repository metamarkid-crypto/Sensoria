-- ============================================================================
-- Sensoria AAC — C-3: KUNCI EKSEKUSI RPC "UANG" YANG SECURITY DEFINER
--
-- MASALAH YANG DIPERBAIKI
--   PostgreSQL memberi EXECUTE ke role PUBLIC secara default untuk setiap
--   fungsi baru (dan Supabase menambahkan GRANT ALL ON FUNCTIONS ke anon &
--   authenticated lewat default privileges). Fungsi "uang" di bawah dibuat
--   SECURITY DEFINER (jalan sebagai pemiliknya, MENEMBUS RLS) tapi tidak
--   pernah di-REVOKE — kecuali apply_parent_slot_purchase.
--
--   Akibatnya, siapa pun yang mengekstrak anon key dari APK bisa memanggil:
--     supabase.rpc('apply_plan_purchase', {...})  -> langganan gratis
--     supabase.rpc('settle_transaction', {...})   -> tandai LUNAS tanpa bayar
--     supabase.rpc('refund_transaction', {...})   -> refund palsu
--
-- KENAPA HANYA 6 FUNGSI INI (SURGICAL, BUKAN BORONGAN)
--   Fungsi trigger (enforce_parent_slots, sync_child_device_on_*, dll) dan
--   helper RLS (is_admin, is_owner) TIDAK boleh di-REVOKE dari anon/auth:
--   trigger dipanggil otomatis oleh database ketika anon melakukan INSERT, dan
--   mencabut EXECUTE-nya akan MEMUTUS pairing/entitlement. is_admin() dipakai
--   di dalam policy RLS. Keduanya bukan vektor eskalasi.
--   Yang benar-benar berbahaya adalah fungsi UANG yang dipanggil LANGSUNG oleh
--   klien. Fungsi-fungsi itu HANYA dipakai service_role (qris-api & dashboard),
--   jadi aman dicabut dari anon/authenticated/PUBLIC.
--
-- MENGAPA AMAN DIJALANKAN (sudah diverifikasi di codebase)
--   • Mobile app TIDAK memanggil .rpc() sama sekali (nol hasil grep di src/).
--   • Admin dashboard memakai createServiceClient() = service_role.
--   • qris-api memakai SUPABASE_SERVICE_ROLE_KEY (store.js:57).
--   • service_role punya GRANT langsung (GRANT ALL ON FUNCTIONS TO
--     service_role), BUKAN lewat PUBLIC, sehingga REVOKE ini tidak
--     menyentuhnya. GRANT eksplisit di bawah menambah kepastian itu.
--
-- Idempoten: aman dijalankan berulang.
-- ============================================================================

BEGIN;

-- ── 1) Cabut dari semua klien ───────────────────────────────────────────────
--     Loop berbasis NAMA (bukan signature) karena:
--       • refund_transaction didefinisikan 2x dengan signature identik
--         (manual_refunds & refund_slot_aware) — final = (text, numeric, text,
--         text, text).
--       • create_qris_order mungkin belum ada (store.js memakai fallback dua
--         insert kalau RPC-nya belum terpasang) — fungsi yang tidak ada cukup
--         diabaikan (loop menghasilkan nol baris, bukan error).
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'apply_plan_purchase',
         'apply_parent_slot_purchase',
         'settle_transaction',
         'refund_transaction',
         'get_refunds_for_transaction',
         'create_qris_order'
       )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn.sig);
    -- Belt-and-suspenders: pastikan service_role TETAP bisa mengeksekusi
    -- (qris-api & admin dashboard), apapun konfigurasi default grant-nya.
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', fn.sig);
  END LOOP;
END;
$$;

COMMIT;

-- ============================================================================
-- CATATAN DISIPLIN KE DEPAN
--   Supabase secara default memberi GRANT ALL ON FUNCTIONS ke anon,
--   authenticated, dan service_role. Jangan diubah lewat ALTER DEFAULT
--   PRIVILEGES karena itu juga memutus auto-grant untuk fungsi TRIGGER yang
--   dibutuhkan anon (INSERT pairing, dll). Disiplin yang benar adalah:
--   SETIAP fungsi SECURITY DEFINER yang memodifikasi uang/entitlement WAJIB
--   diikuti baris:
--     REVOKE ALL ON FUNCTION public.<fn>(...) FROM anon, authenticated;
--     GRANT  EXECUTE ON FUNCTION public.<fn>(...) TO service_role;
-- ============================================================================

-- ── VERIFIKASI ──────────────────────────────────────────────────────────────
-- Harus mengembalikan 0 baris. Kalau ada baris, fungsi itu MASIH bisa
-- dipanggil publik lewat anon key.
--
-- SELECT p.proname,
--        p.oid::regprocedure AS signature,
--        has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_bisa,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_bisa
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('apply_plan_purchase','apply_parent_slot_purchase',
--                     'settle_transaction','refund_transaction',
--                     'get_refunds_for_transaction','create_qris_order')
--    AND (has_function_privilege('anon',          p.oid, 'EXECUTE')
--      OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
--
-- ── KONFIRMASI service_role MASIH BISA ──────────────────────────────────────
-- SELECT p.proname, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_bisa
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('apply_plan_purchase','settle_transaction','refund_transaction');
--  -> semua harus 'true'.
