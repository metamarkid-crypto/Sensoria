import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * alertDedupe — satu pesan, satu bunyi.
 *
 * Pesan yang sama bisa tiba lewat DUA jalur sekaligus:
 *   • Realtime (`MessageAlertBridge`) saat proses JS masih hidup;
 *   • Push headless (`pushTask`) yang dikirim server untuk perangkat yang sama.
 * Saat app di-background, keduanya bisa hidup bersamaan → TTS dobel.
 *
 * `claimAlert` adalah klaim sekali-pakai: jalur pertama yang menang berbunyi,
 * jalur kedua diam. Disimpan di AsyncStorage (bukan memori) karena task
 * headless berjalan di konteks JS terpisah dari app utama.
 */

const KEY = 'sensoria.alertedKeys';
const TTL_MS = 60_000;

type Bucket = Record<string, number>;

const readBucket = async (): Promise<Bucket> => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Bucket) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

/** true = jalur ini yang berhak berbunyi; false = sudah ditangani jalur lain. */
export const claimAlert = async (key: string): Promise<boolean> => {
  if (!key) return true;
  const now = Date.now();
  const bucket = await readBucket();

  // Buang entri kedaluwarsa supaya bucket tidak tumbuh tanpa batas.
  for (const k of Object.keys(bucket)) {
    if (now - bucket[k] > TTL_MS) delete bucket[k];
  }

  const seen = bucket[key];
  if (seen && now - seen <= TTL_MS) {
    await AsyncStorage.setItem(KEY, JSON.stringify(bucket)).catch(() => {});
    return false;
  }

  bucket[key] = now;
  await AsyncStorage.setItem(KEY, JSON.stringify(bucket)).catch(() => {});
  return true;
};
