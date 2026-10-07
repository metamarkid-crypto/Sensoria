import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  AppState,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import Toast from 'react-native-toast-message';
import { useAACStore } from '../store/useAACStore';
import { createCheckoutSession } from '../services/db/paywall';
import { computeRenewalPreview } from '../services/db/entitlement';
import { useAccessibleAction } from '../hooks/useAccessibleAction';
import { useTranslation } from '../i18n';

/**
 * PaywallScreen — Browser Checkout (multi-provider, Master Blueprint).
 *
 * Rendered as a full-screen modal from the Root Stack when a gated feature is
 * hit while `isPremium === false` (or the trial has expired).
 *
 * Two operating modes, driven by `app_settings.web_payment_active`:
 *   • false (App Review) → generic "coming soon" breakdown, NO pricing/payment.
 *   • true  (Live)       → one CTA opens the SYSTEM BROWSER on our backend's
 *                          checkout page (/pay/<token>). The PAGE — not the
 *                          app — lists the Combo plans (1/6/12 bln) and the
 *                          payment providers per region (QRIS for Indonesia,
 *                          DuitNow QR / FPX / card via toyyibPay for Malaysia).
 *
 * WHY a browser (not in-app QR): one backend page serves BOTH countries and
 * every provider it lists stays outside the binary — no payment-gateway SDKs,
 * no app update to change a price or add a channel. The checkout session is a
 * short-lived signed token binding the purchase to THIS child's uuid, so
 * entitlements stay consistent no matter which linked parent's device opens
 * the link.
 *
 * After the browser closes (or the app regains focus) we re-read
 * `refreshEntitlement()` — the subscriptions table is the single source of
 * truth; a "Saya Sudah Bayar" nudge re-checks on demand.
 */

type FlowStage = 'idle' | 'requesting' | 'waiting' | 'verifying';

const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const PERKS = [
  { icon: 'map-marked-alt', textKey: 'paywall.perk1' },
  { icon: 'comments', textKey: 'paywall.perk2' },
  { icon: 'microphone-alt', textKey: 'paywall.perk3' },
  { icon: 'shield-alt', textKey: 'paywall.perk4' },
] as const;

const formatDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS_ID[d.getMonth()]} ${d.getFullYear()}`;
};

export default function PaywallScreen() {
  const navigation = useNavigation<any>();
  const { t, language } = useTranslation();
  const deviceId = useAACStore((s) => s.deviceId);
  const premium = useAACStore((s) => s.premium);
  const refreshEntitlement = useAACStore((s) => s.refreshEntitlement);

  // --- Data (kill-switch is SHARED store state, refreshed on boot/foreground;
  //     fails safe: unknown state ⇒ review mode, never pricing) ---
  const [booting, setBooting] = useState(true);
  const webPaymentActive = useAACStore((s) => s.webPaymentActive);
  const webPaymentLoaded = useAACStore((s) => s.webPaymentLoaded);

  // --- Browser checkout flow ---
  const [stage, setStage] = useState<FlowStage>('idle');
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  // Renewal mode: a premium user pressing the Upgrade/Perpanjang CTA on the
  // success view re-enters the checkout flow (normally that view has no exit
  // into it — it renders whenever isPremium && stage === 'idle').
  const [renewalMode, setRenewalMode] = useState(false);

  // Re-check entitlement when the app comes back to the foreground while a
  // checkout session is out in the browser (user paid → premium flips on).
  const appStateSub = useRef<{ remove: () => void } | null>(null);
  useEffect(() => {
    if (stage !== 'waiting') {
      appStateSub.current?.remove();
      appStateSub.current = null;
      return;
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void handleCheckStatus(false);
    });
    appStateSub.current = sub;
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const load = useCallback(async () => {
    if (!webPaymentLoaded) return; // kill-switch not resolved yet
    setBooting(false);
  }, [webPaymentActive, webPaymentLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const goBack = () => navigation.goBack();

  /**
   * Open the SYSTEM BROWSER on the backend checkout page.
   *
   * Session = POST /api/checkout-session (HMAC) → { url: /pay/<token> } where
   * the token is a short-lived signature binding the checkout to THIS child's
   * uuid + the app language. Plan & provider selection happen ON THE PAGE —
   * the app never lists prices again.
   */
  const handleOpenBrowser = async () => {
    if (!deviceId) {
      Toast.show({ type: 'error', text1: t('common.failed'), text2: t('paywall.toastAccountNotReady'), position: 'top' });
      return;
    }
    setStage('requesting');
    try {
      const session = await createCheckoutSession(deviceId, language);
      setCheckoutUrl(session.url);
      setStage('waiting');
      await WebBrowser.openBrowserAsync(session.url, { enableBarCollapsing: true });
      // Browser closed without a focus event firing (edge): nudge one re-read.
      await refreshEntitlement();
      const isPremiumNow = useAACStore.getState().premium.isPremium;
      if (isPremiumNow) {
        Toast.show({ type: 'success', text1: t('paywall.toastPaid'), text2: t('paywall.toastPaidDesc'), position: 'top' });
        setStage('idle');
        setTimeout(goBack, 900);
      } else if (useAACStore.getState().webPaymentActive) {
        setStage('waiting');
      } else {
        setStage('idle');
      }
    } catch (e) {
      setStage('idle');
      const code = e instanceof Error ? e.message : '';
      // WebBrowser throws when no browser app can handle the URL.
      if (code.includes('ERR_WEB_BROWSER') || code.includes('ActivityNotFound')) {
        Toast.show({
          type: 'error',
          text1: t('paywall.toastBrowserFailedTitle'),
          text2: t('paywall.toastBrowserFailed'),
          position: 'top',
        });
        return;
      }
      // paywall.ts throws stable error CODES (PAYMENT_SERVER_TIMEOUT /
      // CHECKOUT_NO_URL / QRIS_SIGNATURE_REJECTED) — map them to localized
      // toasts. Anything else is a raw transport error shown as-is.
      const localizedCode =
        code === 'PAYMENT_SERVER_TIMEOUT' ||
        code === 'CHECKOUT_NO_URL' ||
        code === 'QRIS_SIGNATURE_REJECTED' ||
        code === 'QRIS_API_SECRET_MISSING';
      Toast.show({
        type: 'error',
        text1: t('paywall.toastCheckoutFailed'),
        text2: localizedCode || !code ? t('paywall.toastTryAgain') : code,
        position: 'top',
      });
    }
  };

  /**
   * Manual re-check ("Saya Sudah Bayar"): plain refreshEntitlement() re-read —
   * the browser provider settles server-side (webhook + poller), so nothing
   * to nudge here; the ledger is the source of truth.
   */
  const handleCheckStatus = async (showToast = true) => {
    if (stage === 'verifying') return;
    setStage('verifying');
    await refreshEntitlement();
    const isPremiumNow = useAACStore.getState().premium.isPremium;

    if (isPremiumNow) {
      Toast.show({ type: 'success', text1: t('paywall.toastPaid'), text2: t('paywall.toastPaidDesc'), position: 'top' });
      setStage('idle');
      setTimeout(goBack, 900);
    } else {
      setStage('waiting');
      if (showToast) {
        Toast.show({
          type: 'info',
          text1: t('paywall.toastNotVerified'),
          text2: t('paywall.toastNotVerifiedDesc'),
          position: 'top',
        });
      }
    }
  };

  const busy = stage === 'requesting' || stage === 'verifying';

  // ── Subscription Upgrade CTA (stacking preview) ───────────────────────────
  // The SAME pure math the backend applies (apply_plan_purchase SQL): a live
  // end date (trial → trial_ends_at, active → expires_at) is APPENDED to —
  // never burned — an expired/missing one restarts from NOW().
  const renewalPreview = computeRenewalPreview(
    { status: premium.status, trialEndsAt: premium.trialEndsAt, expiresAt: premium.expiresAt },
    1,
  );
  const openRenewalCheckout = useAccessibleAction(() => setRenewalMode(true));

  // ────────────────────────────── Renders ──────────────────────────────

  const renderHeader = () => (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle}>Sensoria Premium</Text>
        <Text style={styles.headerSubtitle}>{t('paywall.headerSubtitle')}</Text>
      </View>
      <TouchableOpacity style={styles.closeBtn} onPress={goBack} disabled={busy}>
        <FontAwesome5 name="times" size={18} color="#64748B" />
      </TouchableOpacity>
    </View>
  );

  const renderPerks = () => (
    <View style={styles.perksCard}>
      {PERKS.map((perk) => (
        <View key={perk.textKey} style={styles.perkRow}>
          <View style={styles.perkIconBox}>
            <FontAwesome5 name={perk.icon} size={13} color="#00B5B8" solid />
          </View>
          <Text style={styles.perkText}>{t(perk.textKey)}</Text>
        </View>
      ))}
    </View>
  );

  const renderSuccess = () => (
    <View style={styles.centerBox}>
      <View style={styles.successIcon}>
        <FontAwesome5 name="crown" size={34} color="#FFF" solid />
      </View>
      <Text style={styles.successTitle}>{t('paywall.successTitle')}</Text>
      {premium.status === 'trial' ? (
        <Text style={styles.successDesc}>
          {t('paywall.successTrial', { date: formatDate(premium.trialEndsAt) })}
        </Text>
      ) : (
        <Text style={styles.successDesc}>
          {t('paywall.successActive', { date: formatDate(premium.expiresAt) })}
        </Text>
      )}

      {/* Stacking promise — the EXACT math the backend applies. Only in
          live mode: the review build never surfaces purchasing affordances. */}
      {webPaymentActive ? (
        <View style={styles.stackingCard}>
          <FontAwesome5 name="layer-group" size={16} color="#D97706" solid />
          <View style={{ flex: 1 }}>
            <Text style={styles.stackingTitle}>{t('paywall.stackTitle')}</Text>
            <Text style={styles.stackingText}>
              {renewalPreview.stacks
                ? t('paywall.stackText', { date: formatDate(renewalPreview.newExpiresAt) })
                : t('paywall.expiredStackText')}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Upgrade / Perpanjang CTA — tremor-filtered, never visually disabled. */}
      {webPaymentActive ? (
        <TouchableOpacity style={styles.renewCta} onPress={openRenewalCheckout} activeOpacity={0.85}>
          <FontAwesome5 name="crown" size={15} color="#FFF" solid />
          <Text style={styles.renewCtaText}>
            {premium.status === 'active' ? t('paywall.extend') : t('paywall.upgrade')}
          </Text>
        </TouchableOpacity>
      ) : null}

      {/* No "Kembali" button here — the header's close (X) already dismisses. */}
    </View>
  );

  const renderReviewMode = () => (
    <View style={styles.centerBox}>
      <View style={styles.lockIcon}>
        <FontAwesome5 name="lock" size={26} color="#FFF" solid />
      </View>
      <Text style={styles.reviewTitle}>{t('paywall.reviewTitle')}</Text>
      <Text style={styles.reviewDesc}>
        {t('paywall.reviewDesc')}
      </Text>
      {renderPerks()}
      <View style={styles.soonBadge}>
        <Text style={styles.soonBadgeText}>{t('paywall.soonBadge')}</Text>
      </View>
      <TouchableOpacity style={styles.secondaryBtn} onPress={goBack}>
        <Text style={styles.secondaryBtnText}>{t('common.back')}</Text>
      </TouchableOpacity>
    </View>
  );

  const renderBrowserCheckout = () => (
    <View>
      {renderPerks()}

      <View style={styles.browserCard}>
        <View style={styles.browserIconRow}>
          <View style={styles.browserIconBox}>
            <FontAwesome5 name="globe" size={22} color="#FFF" solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.browserCardTitle}>{t('paywall.browserCta')}</Text>
            <Text style={styles.browserCardSubtitle}>{t('paywall.browserSubtitle')}</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={() => void handleOpenBrowser()} disabled={busy}>
          <FontAwesome5 name="external-link-alt" size={16} color="#FFF" solid />
          <Text style={styles.primaryBtnText}>{t('paywall.browserCta')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderWaiting = () => (
    <View>
      <View style={styles.browserCard}>
        <View style={styles.browserIconRow}>
          <View style={[styles.browserIconBox, { backgroundColor: '#F59E0B' }]}>
            <FontAwesome5 name="hourglass-half" size={20} color="#FFF" solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.browserCardTitle}>{t('paywall.browserWaiting')}</Text>
            <Text style={styles.browserCardSubtitle}>{t('paywall.browserWaitingDesc')}</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={() => void handleCheckStatus(true)} disabled={busy}>
          {stage === 'verifying' ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <>
              <FontAwesome5 name="check-circle" size={16} color="#FFF" solid />
              <Text style={styles.primaryBtnText}>{t('paywall.browserCheckStatus')}</Text>
            </>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryBtn} onPress={() => void handleOpenBrowser()} disabled={busy}>
          <FontAwesome5 name="external-link-alt" size={14} color="#64748B" solid />
          <Text style={styles.secondaryBtnText}>{t('paywall.browserReopen')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // ────────────────────────────── Body ──────────────────────────────

  let body: React.ReactNode;
  if (booting) {
    body = (
      <View style={styles.centerBox}>
        <ActivityIndicator size="large" color="#00B5B8" />
        <Text style={styles.bootingText}>{t('paywall.checking')}</Text>
      </View>
    );
  } else if (!deviceId) {
    body = (
      <View style={styles.centerBox}>
        <Text style={styles.reviewTitle}>{t('paywall.accountNotReadyTitle')}</Text>
        <Text style={styles.reviewDesc}>{t('paywall.accountNotReadyDesc')}</Text>
        <TouchableOpacity style={styles.secondaryBtn} onPress={goBack}>
          <Text style={styles.secondaryBtnText}>{t('common.back')}</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (premium.isPremium && stage === 'idle' && !renewalMode) {
    body = renderSuccess();
  } else if (!webPaymentActive) {
    body = renderReviewMode();
  } else if (stage === 'waiting' || stage === 'verifying') {
    body = renderWaiting();
  } else {
    body = renderBrowserCheckout();
  }

  return (
    <SafeAreaView style={styles.screen}>
      {renderHeader()}

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {body}
      </ScrollView>

      {/* Dimming overlay while a checkout request / verification is in flight */}
      {busy ? (
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.overlayCard}>
            <ActivityIndicator size="large" color="#00B5B8" />
            <Text style={styles.overlayText}>
              {stage === 'requesting' ? t('paywall.preparing') : t('paywall.verifying')}
            </Text>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#11427B',
  },
  headerSubtitle: {
    fontSize: 13,
    color: '#94A3B8',
    marginTop: 2,
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#FFF',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
  },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 32,
  },
  centerBox: {
    alignItems: 'center',
    paddingTop: 24,
    paddingBottom: 24,
  },
  bootingText: {
    marginTop: 12,
    color: '#64748B',
    fontSize: 14,
  },

  // Success / already-premium
  successIcon: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: '#00B5B8',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    elevation: 3,
  },
  successTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#11427B',
    marginBottom: 8,
  },
  successDesc: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 16,
  },

  // Review-mode (stealth: web_payment_active = false)
  lockIcon: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: '#9CA3AF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  reviewTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: '#11427B',
    marginBottom: 10,
    textAlign: 'center',
  },
  reviewDesc: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
    paddingHorizontal: 8,
  },
  perksCard: {
    backgroundColor: '#FFF',
    borderRadius: 16,
    padding: 16,
    width: '100%',
    marginBottom: 20,
    elevation: 1,
  },
  perkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  perkIconBox: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#E6FBFA',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  perkText: {
    flex: 1,
    fontSize: 13,
    color: '#334155',
    fontWeight: '600',
  },
  soonBadge: {
    backgroundColor: '#FFF0F5',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 18,
    marginBottom: 20,
  },
  soonBadgeText: {
    color: '#FF2A7A',
    fontWeight: '800',
    fontSize: 14,
  },

  // Browser checkout card
  browserCard: {
    backgroundColor: '#FFF',
    borderRadius: 20,
    padding: 20,
    marginTop: 4,
    marginBottom: 14,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 5,
  },
  browserIconRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
    gap: 12,
  },
  browserIconBox: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#00B5B8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  browserCardTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#11427B',
    marginBottom: 3,
  },
  browserCardSubtitle: {
    fontSize: 12,
    color: '#64748B',
    lineHeight: 17,
  },

  // Stacking preview + Upgrade/Perpanjang CTA
  stackingCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
    gap: 10,
  },
  stackingTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#92400E',
    marginBottom: 3,
  },
  stackingText: {
    fontSize: 12,
    color: '#B45309',
    lineHeight: 17,
  },
  renewCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#D97706',
    borderRadius: 14,
    paddingVertical: 15,
    marginBottom: 10,
    gap: 8,
    width: '100%',
    elevation: 2,
    shadowColor: '#92400E',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 6,
  },
  renewCtaText: {
    color: '#FFF',
    fontWeight: '800',
    fontSize: 15,
  },

  // Buttons
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00B5B8',
    borderRadius: 14,
    paddingVertical: 15,
    marginBottom: 10,
    gap: 8,
  },
  primaryBtnText: {
    color: '#FFF',
    fontWeight: '800',
    fontSize: 15,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 14,
    paddingVertical: 13,
    marginBottom: 6,
    gap: 8,
  },
  secondaryBtnText: {
    color: '#64748B',
    fontWeight: '700',
    fontSize: 14,
  },

  // Busy overlay
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(248,250,252,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayCard: {
    backgroundColor: '#FFF',
    borderRadius: 18,
    paddingVertical: 24,
    paddingHorizontal: 28,
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
  },
  overlayText: {
    marginTop: 12,
    color: '#334155',
    fontWeight: '700',
    fontSize: 14,
  },
});
