import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { resolveChildDeviceId, useAACStore } from '../store/useAACStore';
import { supabase, subscribeToAACMessages } from '../services/db/supabase';
import { alertIncomingMessage, ensureNotificationSetup } from '../services/notifications/messageAlerts';
import { claimAlert } from '../services/notifications/alertDedupe';
import { pushDedupeKey } from '../services/notifications/pushPayload';
import { registerPushTask } from '../services/notifications/pushTask';
import { syncPushToken } from '../services/notifications/pushTokens';
import { navigationRef } from '../navigation/AppNavigator';

/**
 * MessageAlertBridge — satu-satunya pemilik notifikasi + suara pesan masuk.
 *
 * Kenapa app-level (bukan per layar): pesan bisa masuk saat pengguna berada di
 * layar mana pun, atau saat app di background dan layar chat sudah dilepas.
 * Menaruhnya di layar berarti notifikasi hilang bersama layar itu.
 *
 * Pembagian tugas dengan layar:
 *   • layar yang sedang terbuka tetap menampilkan pesannya (toast / bubble /
 *     modal balasan visual);
 *   • bridge yang memutuskan SUARA dan banner, sehingga foreground dan
 *     background tidak pernah berbunyi bersamaan.
 */
export default function MessageAlertBridge() {
  const role = useAACStore((s) => s.role);
  const deviceId = useAACStore((s) => s.deviceId);
  const pairingCode = useAACStore((s) => s.pairingCode);
  const childProfile = useAACStore((s) => s.childProfile);

  // Ikut berubah saat profil anak tersinkron, supaya langganan di bawah
  // dibangun ulang untuk perangkat yang benar.
  const childDeviceId = resolveChildDeviceId(childProfile, deviceId, role);

  useEffect(() => {
    void ensureNotificationSetup();
  }, []);

  // Push (bukan Realtime) adalah satu-satunya jalur yang hidup saat app mati:
  // daftarkan task headless sekali, lalu sinkronkan token setiap kali app
  // kembali ke depan (token bisa berubah; `speak` mengikuti setelan pengguna).
  useEffect(() => {
    void registerPushTask();
    void syncPushToken();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void syncPushToken();
    });
    return () => sub.remove();
  }, []);

  // Setelan notifikasi / bahasa berubah → token ikut menyesuaikan (`speak` dan
  // `language` dibaca server saat menyusun push).
  const notificationsEnabled = useAACStore((s) => s.notificationsEnabled);
  const language = useAACStore((s) => s.language);
  useEffect(() => {
    void syncPushToken();
  }, [notificationsEnabled, pairingCode, role, deviceId, language]);

  // Tap banner → layar pesan. Tanpa ini banner hanya membuka app di posisi
  // terakhir, bukan di percakapan yang memicu notifikasi.
  useEffect(() => {
    const openMessages = (attempt = 0) => {
      const state = useAACStore.getState();
      // Cold start: navigator belum siap pada frame pertama, jadi coba lagi
      // beberapa kali sebelum menyerah (maks ~2 detik).
      if (!navigationRef.isReady()) {
        if (attempt < 10) setTimeout(() => openMessages(attempt + 1), 200);
        return;
      }
      if (state.role === 'Child') navigationRef.navigate('ChildAAC');
      else if (state.role === 'Parent') navigationRef.navigate('ParentDashboard', { screen: 'Pesan' });
    };

    // Cold start: app dibunuh, banner di-tap → response sudah ada sebelum
    // listener terpasang, jadi harus dibaca sekali secara eksplisit. Response
    // dibersihkan supaya tidak memicu navigasi lagi pada peluncuran berikutnya.
    void Notifications.getLastNotificationResponseAsync()
      .then(async (res) => {
        if (!res) return;
        openMessages();
        await Notifications.clearLastNotificationResponseAsync();
      })
      .catch(() => {});

    const sub = Notifications.addNotificationResponseReceivedListener(() => openMessages());
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!pairingCode || role === 'None') return;

    // Topik terpisah dari layar chat: `supabase.channel()` memakai ulang
    // channel bertopik sama, sehingga removeChannel milik layar akan ikut
    // mematikan listener notifikasi ini.
    const channel = subscribeToAACMessages(pairingCode, (payload: any) => {
      // Pesan sendiri tidak perlu notifikasi — pengirim sudah tahu isinya.
      if (!payload || payload.sender === role) return;

      const state = useAACStore.getState();
      const isChildDevice = role === 'Child';

      // Profil suara mengikuti PENGIRIM: anak → preset suara anak,
      // parent → model ayah/ibu yang dipilih dari nama perannya (Ayah/Ibu/…).
      const senderName = isChildDevice
        ? payload.senderName || state.localParentName || 'Orang Tua'
        : state.childProfile?.nickname || 'Anak';
      const voiceRole = isChildDevice ? senderName : 'Child';

      // Push mungkin sudah membangunkan app untuk pesan yang sama → klaim
      // sekali-pakai supaya TTS tidak dobel (lihat alertDedupe.ts).
      void (async () => {
        const claimed = await claimAlert(pushDedupeKey(pairingCode, payload.timestamp));
        if (!claimed) return;
        await alertIncomingMessage(
          payload.text ?? '',
          senderName,
          state.language,
          voiceRole,
          isChildDevice,
        );
      })();
    }, 'alerts');

    return () => {
      // removeChannel (bukan unsubscribe) supaya topik ini benar-benar dilepas
      // dari client dan tidak dihidupkan lagi dengan handler lama.
      if (channel) supabase.removeChannel(channel);
    };
    // `pairingCode` berubah (pairing baru) → langganan dibuat ulang.
  }, [pairingCode, role, childDeviceId]);

  return null;
}
