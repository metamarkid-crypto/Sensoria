import { useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, Text, TouchableOpacity, StyleSheet, AppState } from 'react-native';
import * as Sentry from '@sentry/react-native';
import Toast, { BaseToast, ErrorToast } from 'react-native-toast-message';
import AppNavigator from './src/navigation/AppNavigator';
import { useAACStore } from './src/store/useAACStore';

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  tracesSampleRate: __DEV__ ? 1.0 : 0.1, // 10% di Produksi untuk menghemat kuota
  debug: __DEV__
});

const ErrorFallbackScreen = ({ error, resetError }: any) => {
  return (
    <View style={styles.fallbackContainer}>
      <Text style={styles.fallbackEmoji}>🤕</Text>
      <Text style={styles.fallbackTitle}>Oops! Ada yang tidak beres.</Text>
      <Text style={styles.fallbackText}>
        Kami telah merekam masalah ini dan teknisi kami akan segera memperbaikinya.
      </Text>
      <TouchableOpacity style={styles.restartButton} onPress={resetError}>
        <Text style={styles.restartText}>Mulai Ulang Aplikasi</Text>
      </TouchableOpacity>
    </View>
  );
};

const toastConfig = {
  success: (props: any) => (
    <BaseToast
      {...props}
      style={{ borderLeftColor: '#10B981', backgroundColor: '#10B981', borderRadius: 12, elevation: 5, width: '90%' }}
      contentContainerStyle={{ paddingHorizontal: 15 }}
      text1Style={{ fontSize: 16, fontWeight: 'bold', color: '#FFF' }}
      text2Style={{ fontSize: 14, color: '#F0FDF4' }}
    />
  ),
  error: (props: any) => (
    <ErrorToast
      {...props}
      style={{ borderLeftColor: '#EF4444', backgroundColor: '#EF4444', borderRadius: 12, elevation: 5, width: '90%' }}
      contentContainerStyle={{ paddingHorizontal: 15 }}
      text1Style={{ fontSize: 16, fontWeight: 'bold', color: '#FFF' }}
      text2Style={{ fontSize: 14, color: '#FEF2F2' }}
    />
  ),
  info: (props: any) => (
    <BaseToast
      {...props}
      style={{ borderLeftColor: '#3B82F6', backgroundColor: '#3B82F6', borderRadius: 12, elevation: 5, width: '90%' }}
      contentContainerStyle={{ paddingHorizontal: 15 }}
      text1Style={{ fontSize: 16, fontWeight: 'bold', color: '#FFF' }}
      text2Style={{ fontSize: 14, color: '#EFF6FF' }}
    />
  )
};

/**
 * Root premium-entitlement lifecycle (Master Blueprint — Phase 4/5 wiring).
 *
 * Trigger points for `refreshEntitlement()`:
 *  1. App mount (or rehydration) once role + deviceId exist.
 *  2. Role/deviceId transitions — every setup path commits through `setRole`
 *     (fresh Child setup AFTER the trial injection, Parent setup, profile
 *     recovery), so this single effect covers "immediately post-setup".
 *  3. Foreground resume — catches trial expiry and payments settled off-app
 *     (user scans the QRIS in a bank app, returns, entitlement re-reads).
 *
 * Offline-first ("Compassionate Child"): on a COLD START the persisted raw
 * boundaries must survive untouched until a refresh succeeds — an offline
 * launch of a premium Child/Parent reads local state, so `resetPremium()` is
 * only called on a REAL in-session role/device switch, never on boot.
 */
function EntitlementLifecycle() {
  const role = useAACStore((s) => s.role);
  const deviceId = useAACStore((s) => s.deviceId);
  const refreshEntitlement = useAACStore((s) => s.refreshEntitlement);
  const resetPremium = useAACStore((s) => s.resetPremium);

  // Tracks the last-seen identity so a change can be told apart from boot.
  const prevRef = useRef<{ role: string | null; deviceId: string | null }>({
    role: null,
    deviceId: null,
  });

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { role, deviceId };

    if (!deviceId || role === 'None') {
      resetPremium();
      return;
    }

    const isColdStart = prev.role === null && prev.deviceId === null;
    if (!isColdStart && (prev.role !== role || prev.deviceId !== deviceId)) {
      resetPremium(); // drop any gate left over from a previous role/device
    }

    void refreshEntitlement();
  }, [role, deviceId, refreshEntitlement, resetPremium]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const { role: r, deviceId: d } = useAACStore.getState();
      if (d && r !== 'None') void refreshEntitlement();
    });
    return () => sub.remove();
  }, [refreshEntitlement]);

  return null;
}

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <EntitlementLifecycle />
      <Sentry.ErrorBoundary fallback={ErrorFallbackScreen}>
        <AppNavigator />
      </Sentry.ErrorBoundary>
      <Toast config={toastConfig} />
    </SafeAreaProvider>
  );
}

export default Sentry.wrap(App);

const styles = StyleSheet.create({
  fallbackContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: '#F8FAFC' },
  fallbackEmoji: { fontSize: 60, marginBottom: 16 },
  fallbackTitle: { fontSize: 22, fontWeight: 'bold', color: '#11427B', marginBottom: 8, textAlign: 'center' },
  fallbackText: { fontSize: 16, color: '#64748B', textAlign: 'center', marginBottom: 24 },
  restartButton: { backgroundColor: '#00B5B8', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  restartText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 }
});
