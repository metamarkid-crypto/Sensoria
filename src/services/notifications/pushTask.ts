import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { setAudioModeAsync } from 'expo-audio';
import { playTTS } from '../ai/audioManager';
import { useAACStore } from '../../store/useAACStore';
import { planIncomingAlert } from './alertPolicy';
import { MESSAGE_CHANNEL_ID, ensureMessageChannel } from './messageAlerts';
import { parseMessagePushData, pushDedupeKey } from './pushPayload';
import { claimAlert } from './alertDedupe';

/**
 * pushTask — jalur yang membuat pesan tetap BERBUNYI saat app ditutup total.
 *
 * Alur: trigger SQL (messages INSERT) → Expo Push (data-only) → FCM/APNs →
 * OS membangunkan proses JS headless → task ini → TTS + banner senyap.
 *
 * BATASAN YANG JUJUR (bukan bug, batas OS):
 *   • Android: data-only FCM dibatasi Doze/App Standby; biasanya langsung,
 *     kadang tertunda bila perangkat lama idle. OEM agresif (Xiaomi/Oppo/Vivo)
 *     bisa memblokir sampai app diberi izin "autostart/battery: unrestricted".
 *   • iOS: headless push bersifat best-effort dan tidak dijamin OS.
 *   • TTS tetap butuh mesin TTS perangkat (offline) atau Fish Audio (online).
 *     Kalau perangkat benar-benar tanpa jaringan, offline TTS tetap jalan.
 */

export const BACKGROUND_NOTIFICATION_TASK = 'sensoria-message-push';

/**
 * Task headless berjalan di konteks JS BARU: store masih default (bahasa 'id',
 * volume default) sampai AsyncStorage selesai rehidrasi. Menunggu sebentar
 * mencegah pesan dibacakan dengan bahasa/volume yang salah.
 */
const waitForHydration = (timeoutMs = 2000): Promise<void> =>
  new Promise((resolve) => {
    const persistApi = (useAACStore as any).persist;
    if (!persistApi || persistApi.hasHydrated()) return resolve();
    const done = () => resolve();
    const timer = setTimeout(done, timeoutMs);
    const unsub = persistApi.onFinishHydration(() => {
      clearTimeout(timer);
      unsub?.();
      done();
    });
  });

/**
 * Dipanggil di SETIAP konteks (app utama & headless). Harus di level modul:
 * TaskManager hanya mengenali task yang didefinisikan saat modul dievaluasi.
 */
if (!TaskManager.isTaskDefined(BACKGROUND_NOTIFICATION_TASK)) {
  TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }: any) => {
    if (error) return;
    // Task juga menerima RESPONSE (tap banner) — itu ditangani bridge, bukan TTS.
    if (data && typeof data === 'object' && 'actionIdentifier' in data) return;

    const payload = parseMessagePushData(data);
    if (!payload) return;

    await waitForHydration();
    const state = useAACStore.getState();

    // Pesan sendiri tidak perlu notifikasi (sama seperti jalur Realtime).
    // voiceRole 'Child' = pengirim anak → perangkat ini bukan anak.
    if (payload.voiceRole === 'Child' && state.role === 'Child') return;
    if (payload.voiceRole !== 'Child' && state.role === 'Parent') return;

    const plan = planIncomingAlert({
      // Task ini HANYA berjalan saat app tidak terlihat (foreground ditangani
      // listener biasa). AppState di konteks headless tidak bisa dipercaya —
      // sering melaporkan 'active' walau tidak ada activity sama sekali, dan
      // itu akan membuang banner (satu-satunya bukti visual bagi pengguna).
      appActive: false,
      notificationsEnabled: state.notificationsEnabled,
      childReceiver: payload.childReceiver || state.role === 'Child',
      visualRepliesEnabled: state.visualRepliesEnabled,
    });

    // Realtime mungkin sudah menangani pesan ini (app masih hidup) → diam.
    const claimed = await claimAlert(pushDedupeKey(payload.channelId, payload.messageTs));
    if (!claimed) return;

    if (plan.speak) {
      try {
        await setAudioModeAsync({ shouldPlayInBackground: true });
        // Bahasa = bahasa UI perangkat INI (store sudah direhidrasi), bukan
        // tebakan server: trigger SQL tidak tahu setelan tiap penerima, jadi
        // payload.language hanya dipakai bila store belum punya nilai.
        await playTTS(payload.text, state.language ?? payload.language, payload.voiceRole);
      } catch (e) {
        console.warn('[Push] TTS gagal:', e);
      }
    }

    if (plan.showBanner) {
      try {
        // Konteks headless = proses baru: channel bisa belum ada di sini.
        await ensureMessageChannel();
        await Notifications.scheduleNotificationAsync({
          content: {
            title: payload.senderName || 'Sensoria',
            body: payload.text,
            // Senyap: satu-satunya bunyi adalah TTS profil suara pengirim.
            sound: false,
            data: {
              kind: 'message',
              channelId: payload.channelId,
              messageTs: payload.messageTs,
            },
          },
          trigger: { channelId: MESSAGE_CHANNEL_ID },
        });
      } catch (e) {
        console.warn('[Push] banner gagal:', e);
      }
    }
  });
}

/** Idempotent: daftarkan task ke OS. Tidak fatal bila sudah terdaftar. */
export const registerPushTask = async (): Promise<void> => {
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_NOTIFICATION_TASK)) return;
    await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
  } catch (e) {
    console.warn('[Push] registerTaskAsync gagal:', e);
  }
};
