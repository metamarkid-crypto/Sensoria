import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, Modal, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';
import { useTranslation } from '../i18n';
import * as Haptics from 'expo-haptics';
import { TextInput, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import Toast from 'react-native-toast-message';
import { fetchChildSlotState, fetchActiveSlotPlans, type SlotPackRow } from '../services/db/slots';
import { createQrisCheckout } from '../services/db/paywall';

interface Props {
  isVisible: boolean;
  onClose: () => void;
}

/** Stages of the in-sheet slot purchase flow (null = flow closed). */
type SlotFlowStage = 'plans' | 'requesting' | 'qr' | 'verifying';

/** Rp 1.234.567 — Indonesian thousands separator (mirrors PaywallScreen). */
const formatRupiah = (value: number) =>
  `Rp${Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

export default function PairingBottomSheet({ isVisible, onClose }: Props) {
  const { t } = useTranslation();
  const [linkedParents, setLinkedParents] = useState<Array<{ id: string; parent_label: string | null }>>([]);
  const [maxParentSlots, setMaxParentSlots] = useState<number | null>(null);
  const [inputCode, setInputCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const insets = useSafeAreaInsets();
  const { deviceId, pairingCode, role, childProfile, setPairingCode, setChildProfile, localParentName, setLocalParentName, webPaymentActive, webPaymentLoaded } = useAACStore();

  // ── Stealth gate (App Review kill-switch) ─────────────────────────────────
  // The slot purchase entry is a REAL-money surface, so it follows the exact
  // same contract as PaywallScreen / the trial banner / Settings: shared
  // store state (web_payment_active), refreshed on boot and every foreground
  // resume, failing safe — unresolved state ⇒ review mode ⇒ NO pricing, NO
  // QRIS, NO buy button anywhere in this sheet. The x/y capacity counter
  // itself stays visible: it is informational, not commerce.
  const slotPurchasesLive = webPaymentActive === true && webPaymentLoaded === true;
  // selectedRole keeps the CANONICAL stored label ('Ibu'/'Ayah'/... — persisted
  // as parent_label and matched by the audio persona keywords); the pills only
  // translate the DISPLAY.
  const [selectedRole, setSelectedRole] = useState(localParentName || 'Ibu');
  const roleOptions = [
    { id: 'Ibu', labelKey: 'pairing.roleMom' },
    { id: 'Ayah', labelKey: 'pairing.roleDad' },
    { id: 'Kakek', labelKey: 'pairing.roleGrandpa' },
    { id: 'Nenek', labelKey: 'pairing.roleGrandma' },
    { id: 'Terapis', labelKey: 'pairing.roleTherapist' },
    { id: 'Guru', labelKey: 'pairing.roleTeacher' },
  ] as const;

  // ── Parent-mode canonical link state ──────────────────────────────────────
  // THREE-way: null = resolving from family_links (the DB is the source of
  // truth, NOT local state — local pairing_code/childProfile can vanish on
  // reinstall/restart and would wrongly offer the link form to a linked
  // parent). true = linked ⇒ ONLY the unlink card (ONE-child rule). false =
  // genuinely unlinked ⇒ link form.
  const [parentLinksResolved, setParentLinksResolved] = useState<boolean | null>(null);
  const [parentChildName, setParentChildName] = useState<string | null>(null);

  // ── In-sheet slot purchase flow (child mode) ──────────────────────────────
  const [slotFlow, setSlotFlow] = useState<SlotFlowStage | null>(null);
  const [packsLoading, setPacksLoading] = useState(false);
  const [slotPacks, setSlotPacks] = useState<SlotPackRow[]>([]);
  const [selectedPack, setSelectedPack] = useState<SlotPackRow | null>(null);
  const [qrImageUri, setQrImageUri] = useState<string | null>(null);
  const [qrExpiresAt, setQrExpiresAt] = useState<string | null>(null);
  const [verifyPending, setVerifyPending] = useState(false);
  // Capacity snapshot taken when the paywall opened — the baseline for the
  // "did the purchase land?" check after verification.
  const [slotCapacityBefore, setSlotCapacityBefore] = useState<number | null>(null);

  // STEALTH SAFETY: if the kill-switch flips OFF while a purchase flow is
  // open (foreground refresh can land mid-QR), tear the whole flow down
  // immediately — review mode must never show a pack list or QR code.
  useEffect(() => {
    if (slotFlow !== null && !slotPurchasesLive) {
      setSlotFlow(null);
      setSelectedPack(null);
      setQrImageUri(null);
      setQrExpiresAt(null);
      setVerifyPending(false);
    }
  }, [slotFlow, slotPurchasesLive]);

  useEffect(() => {
    if (!isVisible || !deviceId) return;

    const refreshChildSlotState = async () => {
      if (role !== 'Child') return;
      const state = await fetchChildSlotState(deviceId);
      setLinkedParents(state.linkedParents);
      setMaxParentSlots(state.maxParentSlots);
    };

    refreshChildSlotState();

    // ── Parent mode: resolve the canonical link from family_links ──────────
    if (role === 'Parent') {
      let cancelled = false;
      setParentLinksResolved(null);
      setParentChildName(null);
      (async () => {
        const { data: links, error: linksError } = await supabase
          .from('family_links')
          .select('id, child_device_id, parent_label')
          .eq('parent_device_id', deviceId)
          .limit(1);
        if (cancelled) return;
        const link = linksError ? null : ((links ?? [])[0] ?? null);
        setParentLinksResolved(Boolean(link));

        if (link) {
          // Remote truth wins over local state: a linked parent never sees
          // the link form again (ONE-child rule), even after a reinstall.
          setPairingCode(null as any);
          const { data: profile } = await supabase
            .from('child_profiles')
            .select('*')
            .eq('device_id', link.child_device_id)
            .maybeSingle();
          if (cancelled) return;
          setParentChildName(profile?.nickname || profile?.full_name || null);
          if (profile) {
            setChildProfile({
              device_id: link.child_device_id,
              fullName: profile.full_name,
              nickname: profile.nickname,
              gender:
                (profile.settings?.childProfileGender || profile.settings?.childVoiceGender || '')
                  .toLowerCase() === 'girl'
                  ? 'Girl'
                  : 'Boy',
              settings: profile.settings,
            });
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // ── Child mode: keep the linked-parent list live ────────────────────────
    let channel: any = null;
    if (role === 'Child') {
      channel = supabase.channel('family_links_updates_sheet')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'family_links', filter: `child_device_id=eq.${deviceId}` },
          () => {
            void refreshChildSlotState();
          }
        )
        .subscribe();
    }

    // SAFEGUARD 1: Strict cleanup to prevent memory leaks
    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [isVisible, deviceId, role]);

  // ── Slot purchase flow (child mode) ────────────────────────────────────────

  const openSlotPaywall = async () => {
    if (!slotPurchasesLive) return; // stealth: never open the paywall in review mode
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSlotCapacityBefore(maxParentSlots);
    setVerifyPending(false);
    setSlotFlow('plans');
    setPacksLoading(true);
    const packs = await fetchActiveSlotPlans();
    setSlotPacks(packs);
    setPacksLoading(false);
  };

  const handleBuySlot = async (pack: SlotPackRow) => {
    if (!deviceId || !slotPurchasesLive) return; // backstop if the switch flips between open and tap
    setSelectedPack(pack);
    setVerifyPending(false);
    setSlotFlow('requesting');
    try {
      // SAME checkout contract as the Combo paywall: POST { device_id,
      // plan_id } → QRIS image. The QRIS backend settles slot packs via
      // apply_parent_slot_purchase() (service role), exactly like combos.
      const result = await createQrisCheckout(deviceId, pack.id);
      setQrImageUri(result.imageUri);
      setQrExpiresAt(result.qrisExpiresAt);
      setSlotFlow('qr');
    } catch (e) {
      setSlotFlow('plans');
      const code = e instanceof Error ? e.message : '';
      const localized = code === 'PAYMENT_SERVER_TIMEOUT' || code === 'CHECKOUT_NO_QRIS';
      Toast.show({
        type: 'error',
        text1: t('common.failed'),
        text2: localized || !code ? t('paywall.toastTryAgain') : code,
        position: 'top',
      });
    }
  };

  /**
   * Manual verification — re-reads THIS device's capacity. Success signal is
   * the same one the QRIS backend produces: max_parent_slots GREW beyond the
   * snapshot taken when the flow opened. (If capacity was unknown at open —
   * pre-migration DB — a known capacity with a spare slot still counts as
   * success; the pack list would be empty anyway on such a DB.)
   */
  const handleVerifySlot = async () => {
    if (slotFlow === 'verifying' || !deviceId) return;
    setSlotFlow('verifying');
    const state = await fetchChildSlotState(deviceId);
    const before = slotCapacityBefore;
    const grew =
      state.maxParentSlots !== null &&
      (before === null
        ? state.maxParentSlots > state.linkedParents.length
        : state.maxParentSlots > before);
    if (grew) {
      setMaxParentSlots(state.maxParentSlots);
      setLinkedParents(state.linkedParents);
      setSelectedPack(null);
      setSlotFlow(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Toast.show({
        type: 'success',
        text1: t('pairing.toastSlotPurchased'),
        text2: t('pairing.toastSlotPurchasedDesc'),
        position: 'top',
      });
      return;
    }
    setSlotFlow('qr');
    setVerifyPending(true);
    Toast.show({
      type: 'info',
      text1: t('pairing.toastNotVerified'),
      text2: t('pairing.toastNotVerifiedDesc'),
      position: 'top',
    });
  };

  // ── Linking (parent mode) ──────────────────────────────────────────────────

  const handleLinkDevice = async () => {
    if (!inputCode || inputCode.length !== 6) {
      Alert.alert(t('common.failed'), t('pairing.toastInvalidCode'));
      return;
    }

    setIsLoading(true);
    try {
      const { data: childDevice, error: deviceError } = await supabase
        .from('devices')
        .select('id')
        .eq('pairing_code', inputCode)
        .eq('role', 'Child')
        .single();
        
      if (deviceError || !childDevice) {
        Alert.alert(t('common.failed'), t('pairing.toastCodeNotFound'));
        setIsLoading(false);
        return;
      }

      // ONE-CHILD RULE: a parent device may hold at most one family_link.
      // The UI already hides the form while linked; this re-check closes the
      // race (form open while the link lands from another screen).
      if (deviceId) {
        const { data: existing } = await supabase
          .from('family_links')
          .select('id')
          .eq('parent_device_id', deviceId)
          .limit(1);
        if ((existing ?? []).length > 0) {
          Alert.alert(t('pairing.childLinked'), t('pairing.parentHasChild'));
          setParentLinksResolved(true);
          setIsLoading(false);
          return;
        }
      }

      // SLOT GUARD (pre-flight): check the child's capacity BEFORE writing so
      // a full child gets the friendly upsell message, not a raw DB error.
      const slotState = await fetchChildSlotState(childDevice.id);
      if (slotState.atCapacity) {
        Alert.alert(t('pairing.toastSlotFull'), t('pairing.toastSlotFullDesc'));
        setIsLoading(false);
        return;
      }

      setLocalParentName(selectedRole);

      const { error: linkError } = await supabase.from('family_links').upsert({
        parent_device_id: deviceId,
        child_device_id: childDevice.id,
        parent_label: selectedRole
      });

      if (linkError) {
        // The DB trigger (enforce_parent_slots, 20260913_parent_slot_enforcement.sql)
        // is the REAL gate covering every writer — map its violation to the
        // same friendly message. Anything else stays generic.
        if (/parent-slot limit/i.test(linkError.message ?? '')) {
          Alert.alert(t('pairing.toastSlotFull'), t('pairing.toastSlotFullDesc'));
        } else {
          Alert.alert(t('common.error'), t('pairing.toastLinkFailed'));
        }
        setIsLoading(false);
        return;
      }

      const { data: profile } = await supabase
        .from('child_profiles')
        .select('*')
        .eq('device_id', childDevice.id)
        .single();
        
      if (profile) {
        setChildProfile({
          device_id: childDevice.id,
          fullName: profile.full_name,
          nickname: profile.nickname,
          gender: profile.settings?.childVoiceGender?.toLowerCase() === 'girl' ? 'Girl' : 'Boy',
          settings: profile.settings
        });
      }

      setPairingCode(inputCode);
      setParentLinksResolved(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(t('common.success'), t('pairing.toastLinked'));
      setInputCode('');
      onClose();

    } catch (err) {
      Alert.alert(t('common.error'), t('pairing.toastLinkFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnlink = () => {
    Alert.alert(
      t('pairing.unlinkTitle'),
      t('pairing.unlinkConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { 
          text: t('pairing.unlink'), 
          style: 'destructive',
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            if (deviceId) {
               await supabase.from('family_links').delete().eq('parent_device_id', deviceId);
            }
            setPairingCode(null as any);
            setChildProfile(null);
            setParentChildName(null);
            setParentLinksResolved(false);
          }
        }
      ]
    );
  };

  // ── Renders ────────────────────────────────────────────────────────────────

  const renderChildModeContent = () => {
    const capacityKnown = maxParentSlots !== null;
    // Full = capacity known AND every slot taken. Unknown capacity (pre-
    // migration DB) renders the legacy list without the upsell entry.
    const full = maxParentSlots !== null && linkedParents.length >= maxParentSlots;
    return (
      <>
        <Image source={require('../../assets/cover-pairing.png')} style={styles.sheetCoverImage} resizeMode="contain" />
        <View style={styles.sheetCodeBox}>
          <Text style={styles.sheetCodeLabel}>{t('pairing.yourCode')}</Text>
          {linkedParents.length >= 1 ? (
            <View style={styles.sheetObfuscatedBox}>
              <FontAwesome5 name="lock" size={24} color="#94A3B8" style={{ marginRight: 12 }} />
              <Text style={styles.sheetObfuscatedText}>* * * * * *</Text>
            </View>
          ) : (
            <View style={styles.sheetCodeRow}>
              {pairingCode?.split('').map((digit, index) => {
                const colors = ['#2488FF', '#FF2A7A', '#FF9800', '#4CAF50', '#9C27B0', '#00BCD4'];
                return <Text key={index} style={[styles.sheetCodeDigit, { color: colors[index % colors.length] }]}>{digit}</Text>;
              })}
            </View>
          )}
          {linkedParents.length < 1 && (
            <Text style={styles.sheetCodeDesc}>{t('pairing.codeDesc')}</Text>
          )}
        </View>
        <View style={styles.sheetDevicesSection}>
          <Text style={styles.sheetDevicesTitle}>
            {capacityKnown
              ? t('pairing.slotsTitle', { used: linkedParents.length, max: maxParentSlots })
              : t('pairing.linkedDevices')}
          </Text>
          {linkedParents.length === 0 ? (
            <Text style={styles.sheetDevicesEmpty}>{t('pairing.noDevices')}</Text>
          ) : (
            linkedParents.map(parent => (
              <View key={parent.id} style={styles.sheetDeviceRow}>
                <View style={styles.sheetDeviceIconBox}>
                  <FontAwesome5 name="tablet-alt" size={20} color="#94A3B8" />
                </View>
                <Text style={styles.sheetDeviceName}>Sensoria {parent.parent_label}</Text>
                <View style={styles.sheetDeviceStatus}>
                  <View style={styles.sheetDeviceDot} />
                  <Text style={styles.sheetDeviceStatusText}>{t('pairing.connected')}</Text>
                </View>
              </View>
            ))
          )}
          {/* SLOT PAYWALL ENTRY — only when every slot is taken (capacity
              known). Unknown capacity (pre-migration) hides it entirely.
              STEALTH: when web_payment_active is off (or unresolved) the buy
              button is replaced by a neutral, price-free support note so the
              pairing sheet stays App-Review-clean. */}
          {full ? (
            <>
              <Text style={styles.slotFullNote}>{t('pairing.slotsFull')}</Text>
              {slotPurchasesLive ? (
                <TouchableOpacity style={[styles.sheetAddButton, styles.slotBuyButton]} onPress={() => void openSlotPaywall()} activeOpacity={0.85}>
                  <FontAwesome5 name="plus-circle" size={16} color="#00B5B8" solid />
                  <Text style={[styles.sheetAddButtonText, styles.slotBuyButtonText]}>{t('pairing.addSlot')}</Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.slotStealthNote}>{t('pairing.slotsSupportNote')}</Text>
              )}
            </>
          ) : null}
        </View>
      </>
    );
  };

  const renderSlotPaywall = () => {
    if (slotFlow === 'qr' || slotFlow === 'verifying') {
      return (
        <View>
          <View style={styles.slotQrCard}>
            <View style={styles.slotQrHeaderRow}>
              <FontAwesome5 name="qrcode" size={18} color="#11427B" solid />
              <Text style={styles.slotQrTitle}>{t('paywall.scanToPay')}</Text>
            </View>
            <View style={styles.slotQrFrame}>
              {qrImageUri ? (
                <Image source={{ uri: qrImageUri }} style={styles.slotQrImage} resizeMode="contain" />
              ) : (
                <ActivityIndicator size="large" color="#00B5B8" />
              )}
            </View>
            <Text style={styles.slotQrPackName}>
              {selectedPack?.name} · {formatRupiah(selectedPack?.price ?? 0)}
            </Text>
            <Text style={styles.slotQrInstruction}>
              {t('paywall.qrInstructionPre')}<Text style={{ fontWeight: '800' }}>QRIS</Text>{t('paywall.qrInstructionPost')}
            </Text>
            {qrExpiresAt ? (
              <Text style={styles.slotQrExpiry}>{t('paywall.qrExpiry', { date: qrExpiresAt.slice(0, 10) })}</Text>
            ) : null}
            {verifyPending ? (
              <Text style={styles.slotVerifyHint}>{t('paywall.verifyHint')}</Text>
            ) : null}
          </View>

          <TouchableOpacity
            style={styles.slotPrimaryBtn}
            onPress={() => void handleVerifySlot()}
            disabled={slotFlow === 'verifying'}
          >
            {slotFlow === 'verifying' ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <>
                <FontAwesome5 name="check-circle" size={15} color="#FFF" solid />
                <Text style={styles.slotPrimaryBtnText}>{t('pairing.slotVerify')}</Text>
              </>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.slotSecondaryBtn}
            onPress={() => setSlotFlow('plans')}
            disabled={slotFlow === 'verifying'}
          >
            <Text style={styles.slotSecondaryBtnText}>{t('paywall.chooseOther')}</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // Stage: plans
    return (
      <View>
        <View style={styles.slotPaywallHeaderBox}>
          <FontAwesome5 name="users" size={20} color="#00B5B8" solid />
          <Text style={styles.slotPaywallTitle}>{t('pairing.slotPaywallTitle')}</Text>
          <Text style={styles.slotPaywallDesc}>
            {t('pairing.slotPaywallDesc', { n: (slotCapacityBefore ?? 1) + 1 })}
          </Text>
        </View>

        {packsLoading ? (
          <View style={styles.slotPacksLoadingBox}>
            <ActivityIndicator size="large" color="#00B5B8" />
          </View>
        ) : slotPacks.length === 0 ? (
          <View style={styles.slotPacksLoadingBox}>
            <Text style={styles.slotPacksEmptyText}>{t('paywall.emptyPlans')}</Text>
            <TouchableOpacity onPress={() => void openSlotPaywall()}>
              <Text style={styles.slotPacksRetryText}>{t('paywall.reload')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          slotPacks.map(pack => (
            <TouchableOpacity
              key={pack.id}
              style={styles.slotPackCard}
              activeOpacity={0.85}
              onPress={() => void handleBuySlot(pack)}
            >
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.slotPackName}>{pack.name}</Text>
                <Text style={styles.slotPackNote}>{t('pairing.slotOneTime')}</Text>
                {pack.description ? (
                  <Text style={styles.slotPackDesc} numberOfLines={2}>{pack.description}</Text>
                ) : null}
              </View>
              <Text style={styles.slotPackPrice}>{formatRupiah(pack.price)}</Text>
              <View style={styles.slotPackCta}>
                <FontAwesome5 name="chevron-right" size={13} color="#FFF" solid />
              </View>
            </TouchableOpacity>
          ))
        )}

        <TouchableOpacity
          style={styles.slotSecondaryBtn}
          onPress={() => {
            setSlotFlow(null);
            setSelectedPack(null);
          }}
        >
          <Text style={styles.slotSecondaryBtnText}>{t('common.cancel')}</Text>
        </TouchableOpacity>
      </View>
    );
  };

  const renderParentModeContent = () => {
    // Resolving the canonical link from the DB — brief spinner, no form flash.
    if (parentLinksResolved === null) {
      return (
        <View style={styles.parentResolvingBox}>
          <ActivityIndicator size="large" color="#00B5B8" />
        </View>
      );
    }

    // LINKED: exactly one card + unlink. No link form (ONE-child rule).
    if (parentLinksResolved) {
      return (
        <View>
          <Image source={require('../../assets/cover-pairing.png')} style={styles.sheetCoverImage} resizeMode="contain" />
          <View style={styles.sheetCodeBox}>
            <Text style={styles.sheetCodeLabel}>{t('pairing.childLinked')}</Text>
            <View style={[styles.sheetDeviceRow, { width: '100%', backgroundColor: '#F8FAFC', marginBottom: 12 }]}>
              <View style={[styles.sheetDeviceIconBox, { backgroundColor: '#E0F2FE' }]}>
                <FontAwesome5 name="child" size={20} color="#0EA5E9" />
              </View>
              <Text style={styles.sheetDeviceName}>
                {parentChildName || childProfile?.fullName || childProfile?.nickname || 'Sensoria'}
              </Text>
              <View style={styles.sheetDeviceStatus}>
                <View style={styles.sheetDeviceDot} />
                <Text style={styles.sheetDeviceStatusText}>{t('pairing.connected')}</Text>
              </View>
            </View>
            <Text style={styles.parentHasChildNote}>{t('pairing.parentHasChild')}</Text>
            <TouchableOpacity style={[styles.sheetAddButton, { borderColor: '#EF4444', backgroundColor: '#FEF2F2' }]} onPress={handleUnlink}>
              <FontAwesome5 name="unlink" size={14} color="#EF4444" />
              <Text style={[styles.sheetAddButtonText, { color: '#EF4444' }]}>{t('pairing.unlinkTitle')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }

    // UNLINKED: the link form.
    return (
      <View>
        <Image source={require('../../assets/cover-pairing.png')} style={styles.sheetCoverImage} resizeMode="contain" />
        <View style={styles.sheetCodeBox}>
          <Text style={styles.sheetCodeLabel}>{t('pairing.enterChildCode')}</Text>
          
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.pairingInput}
              placeholder="123456"
              placeholderTextColor="#CBD5E1"
              value={inputCode}
              onChangeText={setInputCode}
              keyboardType="number-pad"
              maxLength={6}
            />
          </View>
          
          <Text style={styles.sheetCodeDesc}>{t('pairing.getCodeDesc')}</Text>
          
          <Text style={[styles.sheetCodeLabel, { marginTop: 16, marginBottom: 8 }]}>{t('pairing.chooseRole')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16, width: '100%' }}>
            {roleOptions.map(r => (
              <TouchableOpacity 
                key={r.id} 
                style={[
                  styles.rolePill, 
                  selectedRole === r.id ? styles.rolePillActive : styles.rolePillInactive
                ]}
                onPress={() => setSelectedRole(r.id)}
              >
                <Text style={[
                  styles.rolePillText, 
                  selectedRole === r.id ? styles.rolePillTextActive : styles.rolePillTextInactive
                ]}>
                  {t(r.labelKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          
          <TouchableOpacity 
            style={[styles.linkButton, (!inputCode || inputCode.length !== 6) && styles.linkButtonDisabled]}
            onPress={handleLinkDevice}
            disabled={isLoading || inputCode.length !== 6}
          >
            {isLoading ? <ActivityIndicator color="#FFF" /> : (
              <>
                <FontAwesome5 name="link" size={14} color="#FFF" />
                <Text style={styles.linkButtonText}>{t('pairing.linkNow')}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <Modal visible={isVisible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView 
        style={{ flex: 1 }} 
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
      >
        <TouchableOpacity 
          style={styles.bottomSheetOverlay} 
          activeOpacity={1} 
          onPress={onClose}
        >
          <View 
            style={[styles.bottomSheetContainer, { paddingBottom: Math.max(insets.bottom, 20) }]}
            onStartShouldSetResponder={() => true}
          >
          
          {/* Header */}
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleContainer}>
              <Text style={styles.sheetTitle}>{t('pairing.title')}</Text>
              <Text style={styles.sheetSubtitle}>{t('pairing.subtitle')}</Text>
            </View>
            <TouchableOpacity style={styles.sheetCloseBtn} onPress={onClose}>
              <FontAwesome5 name="times" size={18} color="#FF2A7A" />
            </TouchableOpacity>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            bounces={false}
            keyboardShouldPersistTaps="handled"
          >
            {role === 'Child'
              ? (slotFlow !== null ? renderSlotPaywall() : renderChildModeContent())
              : renderParentModeContent()}
          </ScrollView>

        </View>
      </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bottomSheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  bottomSheetContainer: {
    backgroundColor: '#FAFAFF',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingHorizontal: 24,
    paddingTop: 24,
    maxHeight: '88%',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 20,
  },
  sheetHeader: {
    alignItems: 'center',
    marginBottom: 20,
    position: 'relative',
  },
  sheetCloseBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFE3E3',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  sheetTitleContainer: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  sheetTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#11427B',
  },
  sheetSubtitle: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 2,
  },
  sheetCoverImage: {
    width: '100%',
    height: 180,
    marginBottom: 20,
  },
  sheetCodeBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 5,
    marginBottom: 24,
  },
  sheetCodeLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1A2980',
    marginBottom: 16,
  },
  sheetCodeRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  sheetCodeDigit: {
    fontSize: 48,
    fontWeight: '900',
    letterSpacing: 4,
  },
  sheetObfuscatedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 16,
    marginBottom: 16,
    width: '100%',
  },
  sheetObfuscatedText: {
    fontSize: 32,
    fontWeight: '900',
    color: '#94A3B8',
    letterSpacing: 8,
  },
  sheetCodeDesc: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
  },
  sheetDevicesSection: {
    marginBottom: 10,
  },
  sheetDevicesTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#94A3B8',
    marginBottom: 12,
  },
  sheetDevicesEmpty: {
    fontSize: 14,
    color: '#94A3B8',
    textAlign: 'center',
    marginBottom: 16,
  },
  sheetDeviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sheetDeviceIconBox: {
    width: 40,
    height: 40,
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  sheetDeviceName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '900',
    color: '#64748B',
  },
  sheetDeviceStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0FDF4',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  sheetDeviceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4CAF50',
    marginRight: 6,
  },
  sheetDeviceStatusText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#4CAF50',
  },
  sheetAddButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0F8FF',
    borderWidth: 1,
    borderColor: '#2488FF',
    borderRadius: 16,
    paddingVertical: 16,
    gap: 8,
  },
  sheetAddButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2488FF',
  },
  pairingInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 2,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    padding: 16,
    fontSize: 32,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 12,
    color: '#0F172A',
  },
  inputContainer: {
    width: '100%',
    marginBottom: 16,
  },
  linkButton: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2488FF',
    borderRadius: 16,
    paddingVertical: 16,
    marginTop: 16,
    gap: 8,
  },
  linkButtonDisabled: {
    backgroundColor: '#94A3B8',
  },
  linkButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
  },
  rolePill: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
  },
  rolePillActive: {
    backgroundColor: '#E0F2FE',
    borderColor: '#3B82F6',
  },
  rolePillInactive: {
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
  },
  rolePillText: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  rolePillTextActive: {
    color: '#3B82F6',
  },
  rolePillTextInactive: {
    color: '#94A3B8',
  },
  // ── Slot paywall (child mode, in-sheet) ────────────────────────────────────
  slotFullNote: {
    fontSize: 12,
    color: '#92400E',
    backgroundColor: '#FFFBEB',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    textAlign: 'center',
    marginBottom: 12,
    overflow: 'hidden',
  },
  slotBuyButton: {
    backgroundColor: '#E6FBFA',
    borderColor: '#00B5B8',
    marginBottom: 8,
  },
  slotBuyButtonText: {
    color: '#00A5A8',
  },
  slotStealthNote: {
    fontSize: 12,
    color: '#64748B',
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    textAlign: 'center',
    marginBottom: 8,
    overflow: 'hidden',
  },
  slotPaywallHeaderBox: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 20,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 5,
  },
  slotPaywallTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#11427B',
    marginTop: 10,
    marginBottom: 6,
  },
  slotPaywallDesc: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 19,
  },
  slotPacksLoadingBox: {
    alignItems: 'center',
    paddingVertical: 28,
  },
  slotPacksEmptyText: {
    fontSize: 14,
    color: '#64748B',
    marginBottom: 10,
  },
  slotPacksRetryText: {
    color: '#00B5B8',
    fontWeight: '800',
    fontSize: 15,
  },
  slotPackCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 16,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 5,
  },
  slotPackName: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1E293B',
    marginBottom: 2,
  },
  slotPackNote: {
    fontSize: 11,
    fontWeight: '700',
    color: '#00A5A8',
    marginBottom: 2,
  },
  slotPackDesc: {
    fontSize: 12,
    color: '#94A3B8',
    lineHeight: 16,
  },
  slotPackPrice: {
    fontSize: 16,
    fontWeight: '900',
    color: '#11427B',
    marginRight: 10,
  },
  slotPackCta: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#00B5B8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotQrCard: {
    backgroundColor: '#FFF',
    borderRadius: 20,
    alignItems: 'center',
    padding: 20,
    marginBottom: 14,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 5,
  },
  slotQrHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  slotQrTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#11427B',
    marginLeft: 8,
  },
  slotQrFrame: {
    width: 220,
    height: 220,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFF',
    overflow: 'hidden',
  },
  slotQrImage: {
    width: 210,
    height: 210,
  },
  slotQrPackName: {
    marginTop: 12,
    fontSize: 13,
    fontWeight: '800',
    color: '#11427B',
  },
  slotQrInstruction: {
    fontSize: 12,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 18,
    marginTop: 8,
    paddingHorizontal: 6,
  },
  slotQrExpiry: {
    marginTop: 8,
    fontSize: 12,
    color: '#F59E0B',
    fontWeight: '700',
  },
  slotVerifyHint: {
    marginTop: 10,
    fontSize: 11,
    color: '#F59E0B',
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: 8,
  },
  slotPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#00B5B8',
    borderRadius: 14,
    paddingVertical: 15,
    marginBottom: 10,
    gap: 8,
  },
  slotPrimaryBtnText: {
    color: '#FFF',
    fontWeight: '800',
    fontSize: 15,
  },
  slotSecondaryBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 14,
    paddingVertical: 13,
    marginBottom: 6,
  },
  slotSecondaryBtnText: {
    color: '#64748B',
    fontWeight: '700',
    fontSize: 14,
  },
  // ── Parent mode ─────────────────────────────────────────────────────────────
  parentResolvingBox: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  parentHasChildNote: {
    fontSize: 12,
    color: '#94A3B8',
    textAlign: 'center',
    marginBottom: 14,
  },
});
