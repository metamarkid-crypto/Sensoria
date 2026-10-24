-- ============================================================================
-- Sensoria AAC — PUSH NOTIFIKASI PESAN (Expo Push) untuk app yang DITUTUP
-- ============================================================================
--
-- MASALAH: notifikasi pesan hari ini hanya Realtime (supabase.channel). Itu
-- hidup selama proses JS app hidup. Begitu app di-swipe/force-stop, tidak ada
-- yang mendengar INSERT messages → tidak ada banner, tidak ada TTS.
--
-- SOLUSI: server yang mendengar. AFTER INSERT pada public.messages memanggil
-- Expo Push API lewat pg_net (async, non-blocking) ke token perangkat lawan
-- bicara. Payload sengaja DATA-ONLY (tanpa title/body) supaya:
--   • Android: FCM data message → app diberi waktu memutar TTS profil suara
--     pengirim, lalu menampilkan banner SENYAP sendiri (satu bunyi saja);
--   • iOS: butuh `_contentAvailable: true` (sudah dikirim).
--
-- PRASYARAT DI LUAR SQL (wajib, kalau tidak: tidak ada push sama sekali)
--   1. FCM V1 service account di-upload ke Expo: project → Credentials →
--      Android → FCM V1 (google-services.json hanya untuk build, bukan push).
--   2. APK dibangun dengan google-services.json (workflow: secret
--      GOOGLE_SERVICES_JSON) supaya getExpoPushTokenAsync() mengembalikan token.
--
-- IDEMPOTEN: aman dijalankan ulang (IF NOT EXISTS / CREATE OR REPLACE).
-- ============================================================================

-- 0) pg_net — HTTP async dari SQL (biasanya sudah terpasang di Supabase).
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 1) Tabel token perangkat.
--    device_id = devices.id (uuid yang dibuat klien). Satu perangkat bisa
--    punya beberapa token (reinstall menghasilkan token baru), jadi token
--    adalah kunci unik dan device_id hanya index.
CREATE TABLE IF NOT EXISTS public.device_push_tokens (
  token text PRIMARY KEY,
  device_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('Child', 'Parent')),
  platform text NOT NULL DEFAULT 'android',
  -- true = perangkat ini boleh BERSUARA (notificationsEnabled di app).
  speak boolean NOT NULL DEFAULT true,
  -- Bahasa UI perangkat penerima. Tanpa ini TTS headless membaca pesan dengan
  -- bahasa default server ('id') walau pengguna memakai EN/ZH/MS.
  language text NOT NULL DEFAULT 'id' CHECK (language IN ('id', 'en', 'zh', 'ms')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Migrasi ulang: tabel mungkin sudah dibuat versi awal (tanpa language).
ALTER TABLE public.device_push_tokens
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'id';

CREATE INDEX IF NOT EXISTS device_push_tokens_device_idx
  ON public.device_push_tokens (device_id);

ALTER TABLE public.device_push_tokens ENABLE ROW LEVEL SECURITY;

-- Klien (anon) hanya perlu UPSERT token miliknya sendiri dan menghapusnya saat
-- logout/reinstall. Tidak ada SELECT: token perangkat lain tidak boleh bocor.
DROP POLICY IF EXISTS device_push_tokens_insert ON public.device_push_tokens;
CREATE POLICY device_push_tokens_insert ON public.device_push_tokens
  FOR INSERT TO anon
  WITH CHECK (length(token) BETWEEN 10 AND 512 AND device_id IS NOT NULL);

DROP POLICY IF EXISTS device_push_tokens_update ON public.device_push_tokens;
CREATE POLICY device_push_tokens_update ON public.device_push_tokens
  FOR UPDATE TO anon
  USING (true)
  WITH CHECK (length(token) BETWEEN 10 AND 512 AND device_id IS NOT NULL);

DROP POLICY IF EXISTS device_push_tokens_delete ON public.device_push_tokens;
CREATE POLICY device_push_tokens_delete ON public.device_push_tokens
  FOR DELETE TO anon
  USING (true);

GRANT INSERT, UPDATE, DELETE ON public.device_push_tokens TO anon;

-- 2) Trigger pengirim push.
--    Siapa menerima: perangkat di channel yang sama, MINUS peran pengirim —
--    persis aturan Realtime yang sudah dipakai app (`payload.sender === role`
--    → diam), jadi tidak ada perangkat yang dapat banner ganda.
--      • pesan anak   → semua perangkat orang tua yang ter-link
--      • pesan parent → perangkat anak
--    Token dengan speak = false (notifikasi dimatikan di perangkat itu) tidak
--    dikirimi sama sekali: tidak ada bangun-bangun sia-sia.
--
--    `_contentAvailable: true` = syarat headless task di iOS.
CREATE OR REPLACE FUNCTION public.notify_message_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  child_uuid uuid;
  payloads jsonb;
BEGIN
  IF NEW.channel_id IS NULL OR coalesce(NEW.text_content, '') = '' THEN
    RETURN NEW;
  END IF;

  -- channel_id = pairing_code perangkat anak (lihat PairingBottomSheet).
  SELECT d.id INTO child_uuid
    FROM public.devices d
   WHERE d.pairing_code = NEW.channel_id AND d.role = 'Child'
   LIMIT 1;

  IF child_uuid IS NULL THEN
    RETURN NEW; -- channel tanpa perangkat terdaftar: tidak ada tujuan
  END IF;

  WITH targets AS (
    -- Perangkat ANAK (penerima pesan dari orang tua)
    SELECT t.token, t.language, true AS child_receiver
      FROM public.device_push_tokens t
     WHERE t.speak
       AND t.device_id = child_uuid
       AND NEW.sender_role <> 'Child'
    UNION ALL
    -- Perangkat ORANG TUA yang ter-link ke anak ini
    SELECT t.token, t.language, false AS child_receiver
      FROM public.device_push_tokens t
      JOIN public.family_links f ON f.parent_device_id = t.device_id
     WHERE t.speak
       AND f.child_device_id = child_uuid
       AND NEW.sender_role <> 'Parent'
  )
  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'to', token,
               'priority', 'high',
               '_contentAvailable', true,
               -- DATA-ONLY: tanpa title/body → OS tidak menampilkan apa pun;
               -- app yang bangun, memutar TTS, lalu menampilkan banner senyap.
               'data', jsonb_build_object(
                 'kind', 'message',
                 'channelId', NEW.channel_id,
                 'messageTs', NEW.timestamp,
                 'senderName', coalesce(NEW.sender_name, NEW.sender_role),
                 'text', left(coalesce(NEW.text_content, ''), 300),
                 -- Peran PENGIRIM untuk resolveVoice (anak → preset anak,
                 -- Ayah/Ibu → model suara masing-masing).
                 'voiceRole', CASE
                                WHEN NEW.sender_role = 'Child' THEN 'Child'
                                ELSE coalesce(NEW.sender_name, 'Parent')
                              END,
                 'childReceiver', child_receiver,
                 -- true: baris ini hanya dibuat dari token dengan speak = true.
                 'speak', true,
                 -- Bahasa perangkat PENERIMA ini (bukan bahasa pengirim).
                 'language', language
               )
             )
           ),
           '[]'::jsonb
         )
    INTO payloads
    FROM targets;

  IF jsonb_array_length(payloads) = 0 THEN
    RETURN NEW;
  END IF;

  -- pg_net = async & non-blocking: INSERT pesan tidak pernah menunggu Expo.
  PERFORM net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    body := payloads,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Accept', 'application/json'),
    timeout_milliseconds := 5000
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS messages_push_notify ON public.messages;
CREATE TRIGGER messages_push_notify
  AFTER INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_message_push();
