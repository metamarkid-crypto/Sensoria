-- ============================================================================
-- Sensoria AAC — app_content: konten dinamis "Tentang Sensoria AAC"
--
-- MASALAH YANG DIPERBAIKI
--   AboutScreen.tsx membaca public.app_content (SELECT content_json WHERE
--   id='about_sensoria') tetapi tabelnya tidak pernah dibuat di migrasi mana
--   pun — hanya dibuat "manual" di dashboard. Akibatnya fetch online selalu
--   gagal diam-diam dan layar About selamanya menampilkan fallback lokal.
--
--   Migrasi ini membuat tabel dengan skema yang SESUAI dengan harapan klien
--   (id text PRIMARY KEY + content_json jsonb), menyemai baris 'about_sensoria',
--   dan mengunci RLS (SELECT untuk anon, tulis hanya service_role).
--
-- Idempoten: aman dijalankan ulang.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.app_content (
  id          text PRIMARY KEY,
  content_json jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Seed default (tidak menimpa nilai yang sudah diatur admin).
INSERT INTO public.app_content (id, content_json)
VALUES (
  'about_sensoria',
  '{
    "description": "Sensoria AAC adalah aplikasi komunikasi augmentatif dan alternatif (AAC) yang membantu anak-anak berkebutuhan khusus, terutama yang belum lancar berbicara, untuk menyampaikan keinginan dan perasaannya melalui kartu bergambar dan suara.",
    "contactEmail": "support@aacsensoria.id",
    "version": "v1.0.0 (Beta)",
    "privacyPolicyUrl": "https://aacsensoria.id/privacy"
  }'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- RLS: klien (anon) boleh membaca; perubahan konten hanya lewat dashboard
-- (service_role menembus RLS).
ALTER TABLE public.app_content ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS app_content_select_all ON public.app_content;
CREATE POLICY app_content_select_all ON public.app_content
  FOR SELECT TO anon
  USING (true);

REVOKE INSERT, UPDATE, DELETE ON public.app_content FROM anon;
