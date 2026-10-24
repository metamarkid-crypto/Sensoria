/**
 * alertPolicy — keputusan PURE untuk satu pesan masuk (anak ⇄ orang tua).
 *
 * Dipisah dari messageAlerts.ts (yang menyentuh expo-notifications, AppState
 * dan audioManager) supaya aturan produk bisa dieksekusi di Node tanpa Metro:
 * `node scripts/verify-alert-policy.mjs`.
 *
 * ATURAN:
 *   1. App TERBUKA → tidak ada notifikasi OS sama sekali (tidak ada banner,
 *      tidak ada suara notifikasi). Suara pesan diputar oleh app yang terbuka.
 *   2. App di BACKGROUND → banner SENYAP (channel tanpa sound) + TTS profil
 *      suara pengirim. Satu bunyi saja, tidak pernah dobel.
 *   3. `notificationsEnabled === false` → banner tetap tampil, suara bungkam.
 *   4. Perangkat ANAK dengan Balasan Visual → tidak ada TTS (modal gambar).
 *      Flag ini di-mirror ke perangkat orang tua, jadi gerbangnya WAJIB
 *      memakai `childReceiver` — bukan flag itu sendiri.
 */

export type IncomingAlertInput = {
  /** AppState.currentState === 'active' */
  appActive: boolean;
  notificationsEnabled: boolean;
  /** true bila perangkat INI milik anak. */
  childReceiver: boolean;
  visualRepliesEnabled: boolean;
};

export type IncomingAlertPlan = {
  /** Notifikasi OS (banner senyap). */
  showBanner: boolean;
  /** TTS dari app ini. */
  speak: boolean;
  reason: 'foreground' | 'background' | 'disabled' | 'visual-reply';
};

export const planIncomingAlert = ({
  appActive,
  notificationsEnabled,
  childReceiver,
  visualRepliesEnabled,
}: IncomingAlertInput): IncomingAlertPlan => {
  // (1) App terbuka: layar sudah menampilkan pesannya, jadi tidak ada banner.
  const showBanner = !appActive;

  // (3) Notifikasi dimatikan: banner tetap, suara tidak.
  if (!notificationsEnabled) return { showBanner, speak: false, reason: 'disabled' };

  // (4) Anak mode Balasan Visual: gambar yang bicara, bukan suara.
  if (childReceiver && visualRepliesEnabled) return { showBanner, speak: false, reason: 'visual-reply' };

  // (1)+(2) App terbuka → app bicara; background → banner senyap + TTS.
  return { showBanner, speak: true, reason: appActive ? 'foreground' : 'background' };
};
