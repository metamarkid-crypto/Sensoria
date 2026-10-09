import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Platform, StyleSheet, Text, View } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import {
  checkForAppUpdate,
  downloadUpdateApk,
  installUpdateApk,
  cleanupUpdateApk,
  type AppUpdateInfo,
} from '../services/appUpdate';

/**
 * AppUpdateGate — "update tersedia" dialog + download progress + install.
 *
 * Mounted at the app root (App.tsx, above the navigator). At launch (and a
 * small delayed re-check) it asks the VPS whether a newer versionCode is
 * published. When yes:
 *   • mandatory=false → dismissible card ("Nanti" + "Perbarui Sekarang")
 *   • mandatory=true  → the only way out is updating (no close button)
 * Downloading shows a determinate progress bar (0..1) streamed from
 * expo-file-system's progress callback. On completion the APK is handed to
 * Android's Package Installer via an ACTION_VIEW content intent; Android
 * shows the install sheet, the user confirms, and the system restarts the
 * app when the new package replaces this one.
 *
 * Brand palette matches the paywall/report screens (teal #00B5B8, navy).
 */

const POLL_DELAY_MS = 12_000; // first check after splash has fully landed
const PROGRESS_POLL_MS = 500;

export default function AppUpdateGate() {
  const [update, setUpdate] = useState<AppUpdateInfo | null>(null);
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'installing'>('idle');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const info = await checkForAppUpdate();
      if (!cancelled && info) setUpdate(info);
    }, POLL_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const startDownload = useCallback(() => {
    if (!update?.download_url || phase !== 'idle') return;
    setPhase('downloading');
    setProgress(0);
    // Poll with the LAST reported value; the download service throttles to
    // 1% steps, so this interval only smooths the bar between callbacks.
    let lastProgress = 0;
    const ticker = setInterval(() => setProgress(lastProgress), PROGRESS_POLL_MS);
    (async () => {
      const uri = await downloadUpdateApk(update.download_url!, (p) => {
        lastProgress = p.progress;
      });
      clearInterval(ticker);
      if (uri && lastProgress >= 0) {
        setProgress(1);
        setPhase('installing');
        const ok = await installUpdateApk(uri);
        if (!ok) {
          // User refused the "install unknown apps" grant, or the sheet
          // could not open. Offer manual retry; keep the APK cached.
          setPhase('idle');
          setUpdate((u) => u);
          Toast.show({
            type: 'error',
            text1: 'Instalasi dibatalkan',
            text2: 'Izinkan aplikasi menginstal dari sumber ini, lalu coba lagi.',
          });
        }
      } else {
        setPhase('idle');
        Toast.show({ type: 'error', text1: 'Unduhan gagal', text2: 'Periksa koneksi lalu coba lagi.' });
      }
    })();
  }, [update, phase]);

  const dismiss = useCallback(() => {
    setUpdate(null);
    void cleanupUpdateApk();
  }, []);

  if (!update) return null;
  const mandatory = update.mandatory;

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => { if (!mandatory && phase === 'idle') dismiss(); }}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.headRow}>
            <FontAwesome5 name="cloud-download-alt" size={26} color="#00B5B8" />
            <Text style={styles.title}>Pembaruan Tersedia</Text>
          </View>
          <Text style={styles.version}>
            Versi baru{update.latest_version_name ? ` ${update.latest_version_name}` : ''} siap dipasang.
          </Text>
          {update.release_notes ? <Text style={styles.notes}>{update.release_notes}</Text> : null}

          {phase === 'idle' && (
            <View style={styles.btnRow}>
              {!mandatory && (
                <Text style={styles.btnGhost} onPress={dismiss}>
                  Nanti
                </Text>
              )}
              <Text style={[styles.btnPrimary, !update.download_url && styles.btnDisabled]} onPress={startDownload}>
                Perbarui Sekarang
              </Text>
            </View>
          )}

          {phase === 'downloading' && (
            <View>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.round(progress * 100)}%` }]} />
              </View>
              <Text style={styles.progressLabel}>Mengunduh… {Math.round(progress * 100)}%</Text>
            </View>
          )}

          {phase === 'installing' && (
            <View style={styles.btnRow}>
              <ActivityIndicator color="#00B5B8" />
              <Text style={styles.progressLabel}>Membuka pemasangan…</Text>
            </View>
          )}

          {mandatory && phase === 'idle' ? (
            <Text style={styles.mandatoryNote}>Pembaruan wajib — aplikasi tidak bisa dipakai sebelum diperbarui.</Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const BRAND_TEAL = '#00B5B8';
const NAVY = '#11427B';

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(8,20,40,0.62)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    paddingVertical: 24,
    paddingHorizontal: 22,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 18, fontWeight: '800', color: NAVY, flex: 1 },
  version: { marginTop: 8, fontSize: 14, color: '#334155', fontWeight: '600' },
  notes: { marginTop: 4, fontSize: 13, color: '#64748B', lineHeight: 19 },
  btnRow: { marginTop: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 14 },
  btnGhost: { color: '#64748B', fontSize: 15, fontWeight: '700', paddingVertical: 10, paddingHorizontal: 6 },
  btnPrimary: {
    backgroundColor: BRAND_TEAL,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: 12,
    overflow: 'hidden',
  },
  btnDisabled: { opacity: 0.5 },
  track: {
    marginTop: 22,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
  },
  fill: { height: 10, backgroundColor: BRAND_TEAL, borderRadius: 5 },
  progressLabel: { marginTop: 8, fontSize: 12, color: NAVY, textAlign: 'center' },
  mandatoryNote: { marginTop: 12, fontSize: 12, color: '#B45309', textAlign: 'center' },
});
