/**
 * pushPayload — pembaca PURE untuk data payload push pesan AAC.
 *
 * Dipisah dari pushTask.ts (yang menyentuh expo-task-manager, audio, store)
 * supaya bentuk payload bisa diuji di Node: `node scripts/verify-push-payload.mjs`.
 *
 * Bentuk payload BERBEDA per jalur, dan itu satu-satunya alasan modul ini ada:
 *   • task headless Android → `{ notification: { data: { ...key: 'string' } } }`
 *     (RemoteMessageSerializer menaruh semua data FCM sebagai string);
 *   • listener foreground     → `{ data: { ... } }`;
 *   • iOS                     → `{ data: { dataString: '<json>' } }`.
 * Semua field datang sebagai STRING dari FCM, jadi setiap nilai dikonversi
 * eksplisit di sini — bukan dipercaya sebagai number/boolean.
 */

export type PushLanguage = 'id' | 'en' | 'zh' | 'ms';

export type MessagePushData = {
  kind: 'message';
  channelId: string;
  /** `messages.timestamp` (epoch ms) — dipakai sebagai kunci dedupe. */
  messageTs: number;
  senderName: string;
  text: string;
  /** Peran PENGIRIM untuk resolveVoice: 'Child' atau label parent ('Ayah'/'Ibu'). */
  voiceRole: string;
  language: PushLanguage;
  /** true bila perangkat penerima milik anak. */
  childReceiver: boolean;
  /** Keputusan server (dari device_push_tokens) apakah perangkat ini bersuara. */
  speak: boolean;
};

const LANGUAGES: PushLanguage[] = ['id', 'en', 'zh', 'ms'];

const asRecord = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const truthy = (value: unknown): boolean => value === true || value === 'true' || value === 1 || value === '1';

/** Kumpulan kandidat map data, dari yang paling spesifik. */
const candidateMaps = (root: Record<string, any>): Record<string, any>[] => {
  const maps: Record<string, any>[] = [];
  const notification = asRecord(root.notification);
  const data = asRecord(root.data);
  const notificationData = notification ? asRecord(notification.data) : null;

  for (const map of [data, notificationData]) {
    if (!map) continue;
    // `dataString` = salinan JSON mentah payload (jalur iOS / cross-platform).
    if (typeof map.dataString === 'string' && map.dataString.trim().startsWith('{')) {
      try {
        const parsed = asRecord(JSON.parse(map.dataString));
        if (parsed) maps.push(parsed);
      } catch {
        /* payload rusak: lanjut ke map mentah */
      }
    }
    maps.push(map);
  }
  return maps;
};

export const parseMessagePushData = (raw: unknown): MessagePushData | null => {
  const root = asRecord(raw);
  if (!root) return null;

  for (const map of candidateMaps(root)) {
    if (str(map.kind) !== 'message') continue;

    const channelId = str(map.channelId);
    if (!channelId) continue;

    const language = LANGUAGES.includes(str(map.language) as PushLanguage)
      ? (str(map.language) as PushLanguage)
      : 'id';

    return {
      kind: 'message',
      channelId,
      messageTs: Number(map.messageTs) || 0,
      senderName: str(map.senderName),
      text: str(map.text),
      voiceRole: str(map.voiceRole) || 'Child',
      language,
      childReceiver: truthy(map.childReceiver),
      // Default AMAN: jangan bersuara kalau server tidak secara eksplisit
      // mengizinkannya (aturan "notifikasi dimatikan = bungkam").
      speak: truthy(map.speak),
    };
  }
  return null;
};

/** Kunci dedupe antara jalur Realtime (app hidup) dan jalur push (headless). */
export const pushDedupeKey = (channelId: string, messageTs: number): string => `${channelId}:${messageTs}`;
