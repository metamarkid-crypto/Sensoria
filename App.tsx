import { useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, Text, TouchableOpacity, StyleSheet, AppState } from 'react-native';
import * as Sentry from '@sentry/react-native';
import Toast, { BaseToast, ErrorToast } from 'react-native-toast-message';
import AppNavigator from './src/navigation/AppNavigator';
import { useAACStore } from './src/store/useAACStore';
import { subscribeEntitlementRealtime } from './src/services/db/entitlementRealtime';
import SplashGate from './src/components/SplashGate';

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
 * REAL-TIME EXPIRY WATCHDOG (`tickPremiumGate`):
 *  4. A 15s interval re-derives the gate phase from the persisted raw
 *     boundaries against the local clock, so a device kept continuously open
 *     locks the moment its boundary passes instead of waiting for a refresh,
 *     navigation, or any other render trigger. It also fires on foreground
 *     resume (before the network refresh) to cover time spent suspended.
 *     Idle ticks are pure no-ops in the store — no state write, no re-render.
 *     Enforcement stays client-judged (offline-first mandate); the hourly
 *     DB cron only mirrors expiry into the subscriptions table.
 *
 * REALTIME ENTITLEMENT WATCHER (`subscribeEntitlementRealtime`):
 *  5. A Supabase Realtime channel on `subscriptions` + `family_links`
 *     funnels REMOTE row changes (renewal purchased on another device,
 *     cancellation, cron expiry flip, pairing/unpairing) into
 *     `refreshEntitlement()` on a LIVE session — no foreground resume needed.
 *     Every event goes through the same authoritative derivation path as
 *     every other trigger; relevance is filtered against the resolved
 *     `linkedChildIds` so foreign-child noise never causes a refresh.
 *
 * The stealth kill-switch (`webPaymentActive`) follows the same lifecycle:
 * fetched on boot and re-fetched on every foreground resume so flipping
 * `app_settings.web_payment_active` in Supabase applies live without a
 * restart. It is ephemeral store state — never persisted.
 *
 * Offline-first ("Compassionate Child"): on a COLD START the persisted raw
 * boundaries must survive untouched until a refresh succeeds — an offline
 * launch of a premium Child/Parent reads local state, so `resetPremium()` is
 * only called on a REAL in-session role/device switch, never on boot.
 */
const EXPIRY_WATCHDOG_INTERVAL_MS = 15_000;

function EntitlementLifecycle() {
  const role = useAACStore((s) => s.role);
  const deviceId = useAACStore((s) => s.deviceId);
  const refreshEntitlement = useAACStore((s) => s.refreshEntitlement);
  const tickPremiumGate = useAACStore((s) => s.tickPremiumGate);
  const resetPremium = useAACStore((s) => s.resetPremium);
  const refreshWebPaymentActive = useAACStore((s) => s.refreshWebPaymentActive);

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

  // Stealth kill-switch: re-read on boot AND on every foreground resume, so
  // flipping `web_payment_active` in Supabase applies live — no app restart,
  // no stale cached "live" state. Fails safe to stealth on any error.
  useEffect(() => {
    void refreshWebPaymentActive();
  }, [refreshWebPaymentActive]);

  // Expiry watchdog tick — local clock only, no network. Runs every 15s and
  // once on foreground resume (covering suspension), so a boundary that
  // passes while the app is open/suspended locks on that very tick.
  useEffect(() => {
    if (role === 'None' || !deviceId) return;
    tickPremiumGate(); // re-sync immediately after any role/device transition
    const id = setInterval(tickPremiumGate, EXPIRY_WATCHDOG_INTERVAL_MS);
    return () => clearInterval(id);
  }, [role, deviceId, tickPremiumGate]);

  // Realtime entitlement watcher — remote renewals/cancellations land on a
  // live session in under a second instead of waiting for the next
  // foreground resume. Events funnel into refreshEntitlement() (single
  // derivation path); relevance is filtered against the resolved
  // linkedChildIds. A socket drop self-heals in supabase-js, and the AppState
  // refresh below remains the authoritative fallback after long suspensions.
  useEffect(() => {
    if (role === 'None' || !deviceId) return;
    return subscribeEntitlementRealtime({
      getRelevantChildIds: () => useAACStore.getState().premium.linkedChildIds,
      refresh: () => useAACStore.getState().refreshEntitlement(),
    });
  }, [role, deviceId]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const {
        role: r,
        deviceId: d,
        refreshEntitlement: refresh,
        refreshWebPaymentActive: refreshSwitch,
        tickPremiumGate: tick,
      } = useAACStore.getState();
      if (d && r !== 'None') {
        tick(); // instant local-clock phase update (e.g. expired while suspended)
        void refresh(); // authoritative re-read (payments settled off-app)
      }
      void refreshSwitch();
    });
    return () => sub.remove();
  }, [refreshEntitlement]);

  return null;
}

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {/* Brand gate: holds the native splash until the persisted store has
          rehydrated (killing the RoleSelection flash) and plays the seamless
          hero + wordmark + tagline reveal. Renders above the navigator AND
          above the Sentry boundary (an error boundary can't intercept a
          sibling), but below Toast (toast must top everything). */}
      <SplashGate />
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
