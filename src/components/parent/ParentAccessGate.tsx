import React, { useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { evaluateParentGate } from '../../services/db/entitlement';
import { useAACStore } from '../../store/useAACStore';
import { useTranslation } from '../../i18n';
import { ParentStrictLock } from '../../screens/ParentDashboardScreen';
import ParentDashboardScreen from '../../screens/ParentDashboardScreen';

/**
 * ParentAccessGate — Navigator-level guard ("Strict Parent" past the dashboard).
 *
 * Rendered in the Root Stack INSTEAD of ParentDashboardScreen, so the parent
 * dashboard can never mount with an expired entitlement — including the two
 * bypasses the dashboard-level lock could not cover:
 *   • fresh install  → role Parent chosen while nothing is stored yet;
 *   • role re-selection → `setRole('Parent')` escapes the old dashboard lock.
 *
 * Phases (pure local rule `evaluateParentGate`, re-evaluated per render):
 *   • lock      → stored boundary in the past → ParentStrictLock. Online, the
 *                 Paywall auto-presents once per lock episode (same protocol
 *                 as the dashboard lock); dismiss it and the CTA reopens it.
 *   • verifying → fresh install / re-selection: ONE network round-trip (the
 *                 EntitlementLifecycle refresh) is awaited behind a quiet
 *                 spinner — a brand-new parent must reach the dashboard to
 *                 pair, and a transient offline paid user must not be bricked.
 *                 If the refresh errors, lastError + loaded flip the rule to
 *                 grant (combo-consistent: mirrors phase 'unknown') rather
 *                 than bricking the device offline forever.
 *   • grant     → the dashboard itself (which re-locks in-session via the
 *                 expiry watchdog).
 *
 * Navigation note: the Paywall lives in the Root Stack BEHIND this gate
 * screen; navigate() from here pushes it above, matching how the dashboard
 * lock presents it.
 */
export default function ParentAccessGate() {
  const premium = useAACStore((s) => s.premium);
  const refreshEntitlement = useAACStore((s) => s.refreshEntitlement);
  const navigation = useNavigation<any>();
  const { t } = useTranslation();

  const gate = evaluateParentGate(premium);
  const offline = premium.lastError != null;

  // One-shot auto-Paywall per lock episode (mirrors the dashboard lock).
  const paywallShownRef = React.useRef(false);
  useEffect(() => {
    if (gate !== 'lock') {
      paywallShownRef.current = false;
      return;
    }
    if (!offline && !paywallShownRef.current) {
      paywallShownRef.current = true;
      navigation.navigate('Paywall');
    }
  }, [gate, offline, navigation]);

  // Grant path → mount the real dashboard.
  if (gate === 'grant') {
    return <ParentDashboardScreen />;
  }

  // Lock path → the strict lock (dashboard copy, zero grace).
  if (gate === 'lock') {
    return (
      <ParentStrictLock
        offline={offline}
        onRetry={() => void refreshEntitlement()}
        onExtend={() => navigation.navigate('Paywall')}
      />
    );
  }

  // Verifying path → quiet spinner while the post-install refresh decides.
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color="#00B5B8" />
      <Text style={styles.text}>{t('paywall.checking')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5F7FA',
    gap: 14,
  },
  text: {
    fontSize: 14,
    color: '#64748B',
  },
});
