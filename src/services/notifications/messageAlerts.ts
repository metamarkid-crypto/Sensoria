import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { setAudioModeAsync } from 'expo-audio';
import { playTTS } from '../ai/audioManager';
import { useAACStore } from '../../store/useAACStore';
import { planIncomingAlert } from './alertPolicy';

/**
 * messageAlerts — SATU pemilik bunyi untuk pesan masuk (anak ⇄ orang tua).
 *
 * Aturan produk ada di `alertPolicy.ts` (pure, bisa diuji di Node lewat
 * `scripts/verify-alert-policy.mjs`); modul ini hanya mengeksekusinya:
 * banner OS senyap + TTS profil suara pengirim.
 *
 * BATASAN (jujur): tanpa FCM/APNs, tidak ada JS yang bangun saat proses app
 * sudah mati total, jadi keadaan itu tidak memunculkan notifikasi.
 */

export const MESSAGE_CHANNEL_ID = 'aac-messages';

// Didaftarkan saat modul di-import (App.tsx), sebelum notifikasi pertama bisa
// datang. `shouldPlaySound: false` = tidak pernah ada nada ganda dari OS, dan
// banner disembunyikan saat app sedang terbuka (app yang bicara, bukan OS).
Notifications.setNotificationHandler({
  handleNotification: async () => {
    const appActive = AppState.currentState === 'active';
    return {
      shouldShowBanner: !appActive,
      shouldShowList: !appActive,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

let setupDone = false;

/**
 * Izin POST_NOTIFICATIONS (Android 13+) / alert (iOS).
 * Idempotent: tidak memunculkan dialog bila sudah pernah dijawab.
 */
export const requestNotificationPermission = async (): Promise<boolean> => {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return true;
    const asked = await Notifications.requestPermissionsAsync();
    return asked.status === 'granted';
  } catch (e) {
    console.warn('[Notif] izin gagal:', e);
    return false;
  }
};

/**
 * Channel Android senyap. Dipisah karena task headless juga membutuhkannya:
 * saat app dibunuh, `ensureNotificationSetup` belum tentu pernah berjalan di
 * proses ini, dan banner yang menunjuk channel tak dikenal bisa jatuh ke
 * channel default yang BERBUNYI (dua bunyi: nada + TTS).
 */
export const ensureMessageChannel = async (): Promise<void> => {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(MESSAGE_CHANNEL_ID, {
      name: 'Pesan AAC',
      importance: Notifications.AndroidImportance.HIGH,
      // TTS menggantikan nada notifikasi; channel ini sengaja senyap.
      sound: null,
      vibrationPattern: [0, 250, 250, 250],
    });
  } catch (e) {
    console.warn('[Notif] setup channel gagal:', e);
  }
};

/** Idempotent: channel Android, izin, dan sesi audio untuk playback latar. */
export const ensureNotificationSetup = async (): Promise<void> => {
  if (setupDone) return;
  setupDone = true;
  try {
    // Tanpa ini, TTS ikut dibungkam begitu app tidak lagi foreground.
    await setAudioModeAsync({ shouldPlayInBackground: true });
  } catch (e) {
    console.warn('[Notif] audio mode gagal:', e);
  }
  await ensureMessageChannel();
  // Izin hanya diminta bila fitur ini memang menyala (default-nya menyala).
  const { notificationsEnabled } = useAACStore.getState();
  if (notificationsEnabled) await requestNotificationPermission();
};

/** Banner senyap — bunyi selalu dari TTS, bukan dari OS. */
const showSilentBanner = async (title: string, body: string) => {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        // Senyap: satu-satunya bunyi adalah TTS profil suara pengirim.
        sound: false,
        data: { kind: 'message' },
      },
      // channelId ada di TRIGGER (bukan content) pada expo-notifications 57.
      // Trigger non-null dengan channelId tetap tampil seketika.
      trigger: { channelId: MESSAGE_CHANNEL_ID },
    });
  } catch (e) {
    console.warn('[Notif] gagal menampilkan banner:', e);
  }
};

/**
 * Dipanggil setiap ada pesan masuk dari perangkat lawan.
 * @param voiceRole peran PENGIRIM — menentukan profil suara yang dipakai:
 *   'Child' memakai preset suara anak, nama parent ('Ayah'/'Ibu'/…) memakai
 *   model suara ayah/ibu (lihat resolveVoice di audioManager).
 * @param childReceiver true bila perangkat INI milik anak (gerbang Balasan Visual).
 */
export const alertIncomingMessage = async (
  text: string,
  senderName: string,
  language: 'id' | 'en' | 'zh' | 'ms',
  voiceRole: string,
  childReceiver: boolean,
) => {
  const state = useAACStore.getState();
  const plan = planIncomingAlert({
    appActive: AppState.currentState === 'active',
    notificationsEnabled: state.notificationsEnabled,
    childReceiver,
    visualRepliesEnabled: state.visualRepliesEnabled,
  });

  if (plan.showBanner) await showSilentBanner(senderName || 'Sensoria', text);
  if (!plan.speak) return;

  try {
    await playTTS(text, language, voiceRole);
  } catch (e) {
    console.warn('[Notif] TTS gagal:', e);
  }
};
