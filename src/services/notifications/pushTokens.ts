import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase, isSupabaseConfigured } from '../db/supabase';
import { useAACStore } from '../../store/useAACStore';
import { requestNotificationPermission } from './messageAlerts';

/**
 * pushTokens — mendaftarkan Expo Push Token perangkat ke `device_push_tokens`.
 *
 * Ini SATU-SATUNYA bagian yang membuat app bisa dibangunkan saat prosesnya
 * sudah mati: server (trigger SQL) mengirim push ke token ini, OS membangunkan
 * task headless (pushTask.ts), task itu memutar TTS + banner.
 *
 * Tanpa token di tabel → tidak ada push. Karena itu registrasi dipanggil ulang
 * setiap app foreground: token bisa berubah (reinstall, restore backup, FCM
 * rotate) dan `speak` bisa berubah (pengguna mematikan notifikasi).
 */

/** projectId EAS — wajib ada, kalau tidak Expo tidak tahu app mana yang dituju. */
const projectId =
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ||
  (Constants.easConfig as { projectId?: string } | undefined)?.projectId;

/**
 * Ambil token Expo untuk perangkat ini. Null = push tidak mungkin di build ini
 * (mis. APK dibangun tanpa google-services.json) — pemanggil hanya melewati
 * fitur, tidak pernah crash.
 */
const getPushToken = async (): Promise<string | null> => {
  if (!projectId) {
    console.warn('[Push] projectId EAS tidak ada di app config — push dilewati.');
    return null;
  }
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data || null;
  } catch (e) {
    // Kasus paling umum: build tanpa FCM (google-services.json) → tidak ada
    // token. Bukan error fatal; pesan tetap masuk lewat Realtime saat app hidup.
    console.warn('[Push] getExpoPushTokenAsync gagal:', e);
    return null;
  }
};

let lastSynced = '';

/**
 * Idempotent: aman dipanggil di setiap mount/foreground. Hanya menulis ke
 * Supabase bila (token, deviceId, role, language, speak) benar-benar berubah.
 */
export const syncPushToken = async (): Promise<void> => {
  const { deviceId, role, notificationsEnabled, language } = useAACStore.getState();
  if (!isSupabaseConfigured || !deviceId || role === 'None') return;

  if (!notificationsEnabled) {
    // Notifikasi dimatikan → berhenti bersuara. Token tetap disimpan supaya
    // menyalakannya lagi tidak perlu menunggu push token baru.
    if (!lastSynced) return;
    await supabase
      .from('device_push_tokens')
      .update({ speak: false, updated_at: new Date().toISOString() })
      .eq('device_id', deviceId);
    lastSynced = '';
    return;
  }

  const granted = await requestNotificationPermission();
  if (!granted) return;

  const token = await getPushToken();
  if (!token) return;

  const signature = `${token}|${deviceId}|${role}|${language}|true`;
  if (signature === lastSynced) return;

  const row = {
    token,
    device_id: deviceId,
    role,
    platform: Platform.OS,
    speak: true,
    // Bahasa TTS untuk push headless: dibaca server, karena task di perangkat
    // bisa berjalan sebelum store selesai rehidrasi.
    language,
    updated_at: new Date().toISOString(),
  };

  // INSERT dulu, UPDATE bila token sudah ada — BUKAN upsert: ON CONFLICT
  // membutuhkan hak SELECT pada kolom konflik, dan tabel ini sengaja tidak
  // memberi SELECT kepada anon (token perangkat lain tidak boleh terbaca).
  const inserted = await supabase.from('device_push_tokens').insert(row);
  if (inserted.error && inserted.error.code === '23505') {
    const { error: updateError } = await supabase
      .from('device_push_tokens')
      .update({ device_id: deviceId, role, platform: Platform.OS, speak: true, language, updated_at: row.updated_at })
      .eq('token', token);
    if (updateError) {
      console.warn('[Push] update token gagal:', updateError.message);
      return;
    }
  } else if (inserted.error) {
    console.warn('[Push] simpan token gagal:', inserted.error.message);
    return;
  }

  lastSynced = signature;

  // Token lama perangkat ini (reinstall / restore) tidak akan pernah dipakai
  // lagi oleh Expo — hapus supaya tidak ada push ke perangkat mati.
  // Kegagalan di sini tidak boleh membatalkan registrasi yang sudah sukses.
  const { error: pruneError } = await supabase
    .from('device_push_tokens')
    .delete()
    .eq('device_id', deviceId)
    .neq('token', token);
  if (pruneError) console.warn('[Push] prune token lama gagal:', pruneError.message);
};

