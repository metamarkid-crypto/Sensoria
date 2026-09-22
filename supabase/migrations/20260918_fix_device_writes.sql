-- ============================================================================
-- Sensoria AAC — PERBAIKI tulis device & child_profile (revisi RLS 20260916)
--
-- MASALAH YANG DIPERBAIKI
--   Migrasi 20260916_enable_core_rls.sql membatasi kolom devices dengan
--   GRANT level kolom (untuk mencegah `UPDATE devices SET max_parent_slots=999`).
--   Pendekatan ini MEMUTUS `devices.upsert` dari klien: PostgREST upsert
--   (INSERT ... ON CONFLICT DO UPDATE) butuh hak INSERT/UPDATE penuh pada
--   kolom yang dikirim, dan GRANT kolom yang tidak lengkap membuat
--   INSERT/UPSERT gagal 42501. Karena child_profiles.device_id dan
--   subscriptions.child_device_id mengacu ke devices.id (FK), kegagalan
--   devices ikut membuat child_profile & trial tidak tertulis.
--
--   Perbaikan: kembalikan GRANT INSERT/UPDATE penuh ke anon, lalu lindungi
--   max_parent_slots lewat TRIGGER (hanya tolak perubahan dari perangkat,
--   izinkan service_role/dashboard). Trigger tidak mengganggu upsert.
--
-- Idempoten: aman dijalankan ulang.
-- ============================================================================

BEGIN;

-- ── 1) Pulihkan GRANT penuh (hapus batasan level kolom yang memutus upsert) ──
GRANT INSERT, UPDATE ON public.devices TO anon;

-- ── 2) Lindungi max_parent_slots lewat trigger, bukan GRANT kolom ──────────
--     Trigger hanya menolak perubahan max_parent_slots dari klien (anon/authenticated).
--     service_role (dashboard "+1 slot", qris-api) tetap boleh.
CREATE OR REPLACE FUNCTION public.guard_device_max_slots()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.max_parent_slots IS DISTINCT FROM OLD.max_parent_slots THEN
    IF coalesce(current_setting('request.jwt.claim.role', true), '') NOT IN ('service_role', 'supabase_admin') THEN
      RAISE EXCEPTION 'max_parent_slots hanya bisa diubah oleh sistem';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_device_max_slots ON public.devices;
CREATE TRIGGER trg_guard_device_max_slots
  BEFORE UPDATE ON public.devices
  FOR EACH ROW EXECUTE FUNCTION public.guard_device_max_slots();

COMMIT;

-- ── VERIFIKASI ──────────────────────────────────────────────────────────────
-- (a) anon bisa INSERT & UPDATE devices penuh (harus 'true'):
--   SELECT has_table_privilege('anon', 'public.devices', 'INSERT') AS ins,
--          has_table_privilege('anon', 'public.devices', 'UPDATE') AS upd;
--
-- (b) Trigger terpasang:
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.devices'::regclass
--     AND NOT tgisinternal;
--
-- (c) Dashboard "+1 slot" (service_role) tetap bisa:
--   -- jalankan dari dashboard; service_role melewati trigger guard.
