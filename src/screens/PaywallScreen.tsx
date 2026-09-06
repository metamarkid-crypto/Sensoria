import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { FontAwesome5 } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useAACStore } from '../store/useAACStore';
import {
  createQrisCheckout,
  fetchActivePlans,
} from '../services/db/paywall';
import { computeRenewalPreview } from '../services/db/entitlement';
import { useAccessibleAction } from '../hooks/useAccessibleAction';
import type { SubscriptionPlanRow } from '../services/db/types';

/**
 * PaywallScreen — Stealth QRIS Subscription UI (Master Blueprint).
 *
 * Rendered as a full-screen modal from the Root Stack when a gated feature is
 * hit while `isPremium === false` (or the trial has expired).
 *
 * Two operating modes, driven by `app_settings.web_payment_active`:
 *   • false (App Review) → generic "coming soon" breakdown, NO pricing/payment.
 *   • true  (Live)       → Combo plans (1/6/12 bln) from `plans`, then a native
 *                          QRIS checkout: POST to our backend → render QR →
 *                          manual "Saya Sudah Membayar" → refreshEntitlement().
 *
 * No payment-gateway SDKs are involved anywhere.
 */

type FlowStage = 'idle' | 'requesting' | 'qr' | 'verifying';

const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const PERKS = [
  { icon: 'map-marked-alt', text: 'Pantau lokasi anak & zona aman (Geofencing)' },
  { icon: 'comments', text: 'Pesan & riwayat komunikasi tanpa batas' },
  { icon: 'microphone-alt', text: 'Semua pilihan suara premium untuk AAC' },
  { icon: 'shield-alt', text: 'Satu langganan untuk 1 Anak + Orang Tua (Combo)' },
];

const DURATION_LABEL: Record<number, string> = {
  1: '1 Bulan',
  6: '6 Bulan',
  12: '12 Bulan',
};

/** Rp 1.234.567 — Indonesian thousands separator, no Intl dependency. */
const formatRupiah = (value: number) =>
  `Rp${Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

const formatDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS_ID[d.getMonth()]} ${d.getFullYear()}`;
};

export default function PaywallScreen() {
  const navigation = useNavigation<any>();
  const deviceId = useAACStore((s) => s.deviceId);
  const premium = useAACStore((s) => s.premium);
  const refreshEntitlement = useAACStore((s) => s.refreshEntitlement);

  // --- Data load (kill-switch + active plans) ---
  // The kill-switch is SHARED store state, refreshed by the app lifecycle on
  // boot and every foreground resume (see App.tsx / useAACStore) — this screen
  // no longer holds its own copy, so Home banner / Settings row / Paywall can
  // never disagree. Fails safe: unknown state ⇒ review mode, never pricing.
  const [booting, setBooting] = useState(true);
  const webPaymentActive = useAACStore((s) => s.webPaymentActive);
  const webPaymentLoaded = useAACStore((s) => s.webPaymentLoaded);
  const [plans, setPlans] = useState<SubscriptionPlanRow[]>([]);

  // --- Checkout flow ---
  const [stage, setStage] = useState<FlowStage>('idle');
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionPlanRow | null>(null);
  const [qrImageUri, setQrImageUri] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [qrExpiresAt, setQrExpiresAt] = useState<string | null>(null);
  const [verifyPending, setVerifyPending] = useState(false);

  // Renewal mode: a premium user pressing the Upgrade/Perpanjang CTA on the
  // success view reopens the plan list (normally that view has no exit into
  // plans — it renders whenever isPremium && stage === 'idle').
  const [renewalMode, setRenewalMode] = useState(false);

  const load = useCallback(async () => {
    if (!webPaymentLoaded) return; // kill-switch not resolved yet
    setBooting(true);
    if (webPaymentActive) {
      const activePlans = await fetchActivePlans();
      setPlans(activePlans);
    } else {
      setPlans([]);
    }
    setBooting(false);
  }, [webPaymentActive, webPaymentLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const goBack = () => navigation.goBack();

  const handleSelectPlan = async (plan: SubscriptionPlanRow) => {
    if (!deviceId) {
      Toast.show({ type: 'error', text1: 'Gagal', text2: 'Akun belum selesai disiapkan.', position: 'top' });
      return;
    }
    setSelectedPlan(plan);
    setStage('requesting');
    setVerifyPending(false);
    try {
      const result = await createQrisCheckout(deviceId, plan.id);
      setQrImageUri(result.imageUri);
      setOrderId(result.orderId);
      setQrExpiresAt(result.qrisExpiresAt);
      setStage('qr');
    } catch (e) {
      setStage('idle');
      Toast.show({
        type: 'error',
        text1: 'Checkout Gagal',
        text2: e instanceof Error ? e.message : 'Silakan coba lagi.',
        position: 'top',
      });
    }
  };

  /** Manual verification — re-reads subscriptions after the user pays via QRIS. */
  const handleVerifyPayment = async () => {
    if (stage === 'verifying') return;
    setStage('verifying');
    await refreshEntitlement();
    const isPremiumNow = useAACStore.getState().premium.isPremium;

    if (isPremiumNow) {
      Toast.show({ type: 'success', text1: 'Pembayaran Berhasil 🎉', text2: 'Premium Anda sekarang aktif.', position: 'top' });
      // Small pause so the toast renders before the modal dismisses.
      setTimeout(goBack, 900);
    } else {
      setStage('qr');
      setVerifyPending(true);
      Toast.show({
        type: 'info',
        text1: 'Belum Terverifikasi',
        text2: 'Jika pembayaran sudah selesai, tunggu sebentar lalu periksa lagi.',
        position: 'top',
      });
    }
  };

  const busy = stage === 'requesting' || stage === 'verifying';

  // ── Subscription Upgrade CTA (stacking preview) ───────────────────────────
  // The SAME pure math the QRIS backend will apply (apply_plan_purchase SQL):
  // a live end date (trial → trial_ends_at, active → expires_at) is APPENDED
  // to — never burned — an expired/missing one restarts from NOW(). The
  // 1-month example below is illustrative; a real purchase stacks the CHOSEN
  // plan's duration. Wrapped in the AAC tremor filter (visually active, no
  // disabled prop) with its own light haptic on the accepted tap.
  const renewalPreview = computeRenewalPreview(
    { status: premium.status, trialEndsAt: premium.trialEndsAt, expiresAt: premium.expiresAt },
    1,
  );
  const openRenewalPlans = useAccessibleAction(() => setRenewalMode(true));

  // ────────────────────────────── Renders ──────────────────────────────

  const renderHeader = () => (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle}>Sensoria Premium</Text>
        <Text style={styles.headerSubtitle}>Akses penuh untuk keluarga Anda</Text>
      </View>
      <TouchableOpacity style={styles.closeBtn} onPress={goBack} disabled={busy}>
        <FontAwesome5 name="times" size={18} color="#64748B" />
      </TouchableOpacity>
    </View>
  );

  const renderPerks = () => (
    <View style={styles.perksCard}>
      {PERKS.map((perk) => (
        <View key={perk.text} style={styles.perkRow}>
          <View style={styles.perkIconBox}>
            <FontAwesome5 name={perk.icon} size={13} color="#00B5B8" solid />
          </View>
          <Text style={styles.perkText}>{perk.text}</Text>
        </View>
      ))}
    </View>
  );

  const renderSuccess = () => (
    <View style={styles.centerBox}>
      <View style={styles.successIcon}>
        <FontAwesome5 name="crown" size={34} color="#FFF" solid />
      </View>
      <Text style={styles.successTitle}>Premium Aktif</Text>
      {premium.status === 'trial' ? (
        <Text style={styles.successDesc}>
          Masa percobaan Anda aktif hingga {formatDate(premium.trialEndsAt)}.
        </Text>
      ) : (
        <Text style={styles.successDesc}>
          Langganan aktif hingga {formatDate(premium.expiresAt)}.
        </Text>
      )}

      {/* Stacking promise — the EXACT math the backend will apply. Only in
          live mode: the review build never surfaces purchasing affordances. */}
      {webPaymentActive ? (
        <View style={styles.stackingCard}>
          <FontAwesome5 name="layer-group" size={16} color="#D97706" solid />
          <View style={{ flex: 1 }}>
            <Text style={styles.stackingTitle}>Masa aktif ditambahkan, tidak hangus</Text>
            <Text style={styles.stackingText}>
              {renewalPreview.stacks
                ? `Beli paket kapan pun — durasinya DITAMBAHKAN ke akhir masa aktif Anda. Contoh: Paket 1 Bulan dibeli sekarang berlaku hingga ${formatDate(renewalPreview.newExpiresAt)}.`
                : 'Masa langganan Anda telah berakhir. Paket baru akan aktif segera setelah pembayaran terverifikasi.'}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Upgrade / Perpanjang CTA — tremor-filtered, never visually disabled. */}
      {webPaymentActive ? (
        <TouchableOpacity style={styles.renewCta} onPress={openRenewalPlans} activeOpacity={0.85}>
          <FontAwesome5 name="crown" size={15} color="#FFF" solid />
          <Text style={styles.renewCtaText}>
            {premium.status === 'active' ? 'Perpanjang Langganan' : 'Upgrade ke Premium'}
          </Text>
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity style={styles.primaryBtn} onPress={goBack}>
        <Text style={styles.primaryBtnText}>Kembali</Text>
      </TouchableOpacity>
    </View>
  );

  const renderReviewMode = () => (
    <View style={styles.centerBox}>
      <View style={styles.lockIcon}>
        <FontAwesome5 name="lock" size={26} color="#FFF" solid />
      </View>
      <Text style={styles.reviewTitle}>Fitur Premium Segera Hadir</Text>
      <Text style={styles.reviewDesc}>
        Kami sedang menyiapkan paket langganan terbaik untuk keluarga Anda.
        Nantikan pembaruan berikutnya!
      </Text>
      {renderPerks()}
      <View style={styles.soonBadge}>
        <Text style={styles.soonBadgeText}>🚀 Segera Hadir</Text>
      </View>
      <TouchableOpacity style={styles.secondaryBtn} onPress={goBack}>
        <Text style={styles.secondaryBtnText}>Kembali</Text>
      </TouchableOpacity>
    </View>
  );

  const renderPlans = () => (
    <View>
      <View style={styles.comboNote}>
        <FontAwesome5 name="users" size={14} color="#11427B" solid />
        <Text style={styles.comboNoteText}>
          1 langganan Combo mencakup 1 perangkat Anak + semua Orang Tua yang terhubung.
        </Text>
      </View>

      {plans.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>Paket belum tersedia saat ini.</Text>
          <TouchableOpacity onPress={() => void load()}>
            <Text style={styles.retryText}>Muat Ulang</Text>
          </TouchableOpacity>
        </View>
      ) : (
        plans.map((plan) => (
          <TouchableOpacity
            key={plan.id}
            style={styles.planCard}
            activeOpacity={0.85}
            onPress={() => void handleSelectPlan(plan)}
            disabled={busy}
          >
            <View style={styles.planInfo}>
              <View style={styles.planBadge}>
                <Text style={styles.planBadgeText}>{DURATION_LABEL[plan.duration_months] ?? `${plan.duration_months} Bulan`}</Text>
              </View>
              <Text style={styles.planName}>{plan.name}</Text>
              {plan.description ? (
                <Text style={styles.planDesc} numberOfLines={2}>{plan.description}</Text>
              ) : null}
            </View>
            <View style={styles.planPriceBox}>
              <Text style={styles.planPrice}>{formatRupiah(plan.price)}</Text>
              <Text style={styles.planPerMonth}>
                ≈ {formatRupiah(Math.round(plan.price / plan.duration_months))}/bln
              </Text>
            </View>
            <View style={styles.planCta}>
              <FontAwesome5 name="chevron-right" size={14} color="#FFF" solid />
            </View>
          </TouchableOpacity>
        ))
      )}
    </View>
  );

  const renderQr = () => (
    <View>
      <View style={styles.qrCard}>
        <View style={styles.qrHeaderRow}>
          <FontAwesome5 name="qrcode" size={18} color="#11427B" solid />
          <Text style={styles.qrTitle}>Scan untuk Membayar</Text>
        </View>

        <View style={styles.qrFrame}>
          {qrImageUri ? (
            <Image source={{ uri: qrImageUri }} style={styles.qrImage} resizeMode="contain" />
          ) : (
            <ActivityIndicator size="large" color="#00B5B8" />
          )}
        </View>

        <Text style={styles.qrInstruction}>
          Buka aplikasi bank / e-wallet Anda, pilih <Text style={{ fontWeight: '800' }}>QRIS</Text>, lalu scan kode di atas untuk menyelesaikan pembayaran.
        </Text>

        {qrExpiresAt ? (
          <Text style={styles.qrExpiry}>Berlaku hingga {formatDate(qrExpiresAt)}</Text>
        ) : null}
        {orderId ? <Text style={styles.qrOrderId}>Order: {orderId}</Text> : null}
      </View>

      {verifyPending ? (
        <Text style={styles.verifyHint}>
          Pembayaran belum terverifikasi. Jika sudah transfer, periksa kembali dalam beberapa saat.
        </Text>
      ) : null}

      <TouchableOpacity style={styles.primaryBtn} onPress={() => void handleVerifyPayment()} disabled={busy}>
        {stage === 'verifying' ? (
          <ActivityIndicator color="#FFF" />
        ) : (
          <>
            <FontAwesome5 name="check-circle" size={16} color="#FFF" solid />
            <Text style={styles.primaryBtnText}>Saya Sudah Membayar — Verifikasi</Text>
          </>
        )}
      </TouchableOpacity>

      <TouchableOpacity style={styles.secondaryBtn} onPress={() => setStage('idle')} disabled={busy}>
        <Text style={styles.secondaryBtnText}>Pilih Paket Lain</Text>
      </TouchableOpacity>
    </View>
  );

  // ────────────────────────────── Body ──────────────────────────────

  let body: React.ReactNode;
  if (booting) {
    body = (
      <View style={styles.centerBox}>
        <ActivityIndicator size="large" color="#00B5B8" />
        <Text style={styles.bootingText}>Memeriksa status premium…</Text>
      </View>
    );
  } else if (!deviceId) {
    body = (
      <View style={styles.centerBox}>
        <Text style={styles.reviewTitle}>Akun Belum Siap</Text>
        <Text style={styles.reviewDesc}>Selesaikan pengaturan perangkat terlebih dahulu.</Text>
        <TouchableOpacity style={styles.secondaryBtn} onPress={goBack}>
          <Text style={styles.secondaryBtnText}>Kembali</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (premium.isPremium && stage === 'idle' && !renewalMode) {
    body = renderSuccess();
  } else if (!webPaymentActive) {
    body = renderReviewMode();
  } else if (stage === 'qr' || stage === 'verifying') {
    body = renderQr();
  } else {
    body = renderPlans();
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
              {stage === 'requesting' ? 'Menyiapkan pembayaran QRIS…' : 'Memverifikasi pembayaran…'}
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

  // Live plans
  comboNote: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E7F0FB',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 14,
  },
  comboNoteText: {
    flex: 1,
    marginLeft: 10,
    fontSize: 12,
    color: '#11427B',
    fontWeight: '600',
    lineHeight: 17,
  },
  planCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF',
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 5,
  },
  planInfo: { flex: 1, paddingRight: 8 },
  planBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#E6FBFA',
    borderRadius: 8,
    paddingVertical: 3,
    paddingHorizontal: 8,
    marginBottom: 6,
  },
  planBadgeText: {
    color: '#00A5A8',
    fontWeight: '800',
    fontSize: 11,
  },
  planName: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1E293B',
    marginBottom: 2,
  },
  planDesc: {
    fontSize: 12,
    color: '#94A3B8',
    lineHeight: 16,
  },
  planPriceBox: { alignItems: 'flex-end' },
  planPrice: {
    fontSize: 16,
    fontWeight: '900',
    color: '#11427B',
  },
  planPerMonth: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  planCta: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#00B5B8',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 28,
  },
  emptyStateText: {
    color: '#64748B',
    fontSize: 14,
    marginBottom: 10,
  },
  retryText: {
    color: '#00B5B8',
    fontWeight: '800',
    fontSize: 15,
  },

  // QRIS checkout
  qrCard: {
    backgroundColor: '#FFF',
    borderRadius: 20,
    alignItems: 'center',
    padding: 20,
    marginTop: 4,
    marginBottom: 14,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 5,
  },
  qrHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  qrTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#11427B',
    marginLeft: 8,
  },
  qrFrame: {
    width: 230,
    height: 230,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF',
    overflow: 'hidden',
  },
  qrImage: {
    width: 220,
    height: 220,
  },
  qrInstruction: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 14,
    paddingHorizontal: 6,
  },
  qrExpiry: {
    marginTop: 10,
    fontSize: 12,
    color: '#F59E0B',
    fontWeight: '700',
  },
  qrOrderId: {
    marginTop: 4,
    fontSize: 11,
    color: '#94A3B8',
  },
  verifyHint: {
    fontSize: 12,
    color: '#F59E0B',
    textAlign: 'center',
    marginBottom: 10,
    paddingHorizontal: 12,
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
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 14,
    paddingVertical: 13,
    marginBottom: 6,
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
