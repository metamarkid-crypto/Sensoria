import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Modal } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { supabase, sendAACMessage } from '../../services/db/supabase';
import { queuePendingMessage } from '../../services/db/sqlite';
import { getMessagesCache, appendMessageToCache } from '../../services/db/sqlite';
import { useAACStore } from '../../store/useAACStore';
import { formatDate, formatTime, toTimestampMs } from '../../utils/format';
import { playTTS } from '../../services/ai/audioManager';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';
import * as Haptics from 'expo-haptics';
import { useAccessibleAction } from '../../hooks/useAccessibleAction';
import { useTranslation } from '../../i18n';

// ── Activity analytics (pure, testable) ─────────────────────────────────────
// Correctness notes:
//  • timestamps are normalized via toTimestampMs (PostgREST returns bigint as
//    string, so new Date(string) would be Invalid Date).
//  • unique words preserve CJK so trilingual (ZH) vocabulary is counted, not
//    silently erased by an [a-z0-9]-only strip.
//  • the four stats are all REAL and mutually consistent:
//      messages  = child + parent (total communication volume)
//      requests  = child messages (the child's AAC requests)
//      responses = parent messages (social responses)
//      unique    = distinct words the child used
//    so messages ≈ requests + responses, never a hardcoded zero.

type ActivityRange = 'today' | '7d' | '30d';

interface ActivityStats {
  messages: number;
  requests: number;
  responses: number;
  uniqueWords: number;
  activeDays: number;
  chart: number[];
  chartLabels: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Inclusive lower bound (epoch ms) for a range, ending at `nowMs`. */
function rangeStartMs(range: ActivityRange, nowMs: number): number {
  if (range === 'today') {
    const d = new Date(nowMs);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  const days = range === '7d' ? 7 : 30;
  return nowMs - (days - 1) * DAY_MS;
}

function dayStartMs(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function computeActivity(rows: any[], range: ActivityRange, nowMs: number): ActivityStats {
  const child = rows.filter((r) => r.sender_role === 'Child');
  const parent = rows.filter((r) => r.sender_role === 'Parent');

  const words = new Set<string>();
  const activeDays = new Set<string>();

  let chart: number[];
  let chartLabels: string[];

  if (range === 'today') {
    chart = new Array(24).fill(0);
    chartLabels = ['00', '04', '08', '12', '16', '20', '24'];
  } else if (range === '7d') {
    chart = new Array(7).fill(0);
    chartLabels = new Array(7).fill(0).map((_, i) =>
      String(new Date(nowMs - (6 - i) * DAY_MS).getDate()),
    );
  } else {
    chart = new Array(30).fill(0);
    chartLabels = [];
    for (let i = 0; i < 30; i += 5) {
      chartLabels.push(String(new Date(nowMs - (29 - i) * DAY_MS).getDate()));
    }
  }

  for (const m of child) {
    const ms = toTimestampMs(m.timestamp);
    if (Number.isNaN(ms)) continue;

    if (m.text_content) {
      String(m.text_content).toLowerCase().split(/\s+/).forEach((w: string) => {
        const clean = w.replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
        if (clean) words.add(clean);
      });
    }

    const d = new Date(ms);
    activeDays.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);

    if (range === 'today') {
      chart[d.getHours()]++;
    } else {
      const days = range === '7d' ? 7 : 30;
      const daysAgo = Math.round((dayStartMs(nowMs) - dayStartMs(ms)) / DAY_MS);
      const idx = days - 1 - daysAgo;
      if (idx >= 0 && idx < days) chart[idx]++;
    }
  }

  return {
    messages: child.length + parent.length,
    requests: child.length,
    responses: parent.length,
    uniqueWords: words.size,
    activeDays: activeDays.size,
    chart,
    chartLabels,
  };
}

const EMPTY_ACTIVITY: ActivityStats = {
  messages: 0,
  requests: 0,
  responses: 0,
  uniqueWords: 0,
  activeDays: 0,
  chart: new Array(24).fill(0),
  chartLabels: ['00', '04', '08', '12', '16', '20', '24'],
};

// ── Coming Soon modal (fitur yang sedang dikembangkan) ──────────────────────
// Elegan dan informatif: pengguna paham fiturnya nyata dan sedang disiapkan,
// bukan tombol mati.
function ComingSoonModal({ visible, onClose, title }: { visible: boolean; onClose: () => void; title: string }) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <View style={styles.modalIconBox}>
            <FontAwesome5 name="toolbox" size={28} color="#16A34A" />
          </View>
          <Text style={styles.modalTitle}>{t('home.comingSoonTitle')}</Text>
          <Text style={styles.modalDesc}>{t('home.comingSoonDesc', { feature: title })}</Text>
          <View style={styles.modalBadge}>
            <FontAwesome5 name="hammer" size={11} color="#A16207" />
            <Text style={styles.modalBadgeText}>{t('home.comingSoonBadge')}</Text>
          </View>
          <TouchableOpacity style={styles.modalCloseBtn} onPress={onClose} activeOpacity={0.85}>
            <Text style={styles.modalCloseText}>{t('home.comingSoonClose')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

export default function ParentHomeScreen() {
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { pairingCode, language, deviceId, childProfile, localParentName } = useAACStore();
  
  const [recentMessage, setRecentMessage] = useState<any>(null);
  const [comingSoonVisible, setComingSoonVisible] = useState(false);
  
  const { childStatus } = useAACStore();
  const currentAddress = childStatus.lastAddress || t('home.locationUnavailable');
  
  // Comprehensive Activity Widget State
  const ACTIVITY_TABS = [
    { id: 'today', labelKey: 'home.tabToday' },
    { id: '7d', labelKey: 'home.tab7Days' },
    { id: '30d', labelKey: 'home.tab30Days' },
  ] as const;
  type TabId = typeof ACTIVITY_TABS[number]['id'];

  const [activeTab, setActiveTab] = useState<TabId>('today');
  const [activity, setActivity] = useState<ActivityStats>(EMPTY_ACTIVITY);
  // Bumped on every child realtime INSERT so the active range re-fetches —
  // a live tap on the child's board is reflected in the stats immediately.
  const [refreshTick, setRefreshTick] = useState<number>(0);

  // Switching range clears the previous range's numbers immediately so the
  // widget never shows 7d/30d data under the wrong tab while re-fetching.
  const selectTab = (tab: TabId) => {
    if (tab === activeTab) return;
    setActivity(EMPTY_ACTIVITY);
    setActiveTab(tab);
  };

  // ── Proactive Upgrade Banner (stealth kill-switch) ──────────────────────────
  // Reads the SHARED store flag, refreshed by the app lifecycle on boot and
  // every foreground resume (see App.tsx / useAACStore). FAILS SAFE to `false`
  // (missing row / DB error / unapplied migration) — the banner can therefore
  // never exist during App Review. Parents receive ZERO grace, so the only
  // eligible proactive window on this node is an ACTIVE free trial.
  const premium = useAACStore((s) => s.premium);
  const webPaymentActive = useAACStore((s) => s.webPaymentActive);

  const showUpgradeBanner =
    webPaymentActive && premium.isPremium && premium.status === 'trial';

  // ── Recent message + realtime ─────────────────────────────────────────────
  useEffect(() => {
    if (!pairingCode) return;

    let cancelled = false;

    // 1. Recent child message (initial load) — offline-first: when the
    // network fetch returns nothing (airplane mode / dead socket), fall back
    // to the newest CACHED row so the "last message" card survives weeks of
    // not opening the app.
    (async () => {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', pairingCode)
        .eq('sender_role', 'Child')
        .order('timestamp', { ascending: false })
        .limit(1)
        .single();
      if (!cancelled && data) {
        setRecentMessage(data);
      } else if (!cancelled) {
        const cached = await getMessagesCache(pairingCode, 1);
        const lastChild = cached.find((m: any) => m.sender_role === 'Child');
        if (lastChild) setRecentMessage(lastChild);
      }
    })();

    // 2. Realtime: new child message → refresh recent + bump activity re-fetch.
    const msgSub = supabase.channel('home_recent_message')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${pairingCode}`
      }, (payload) => {
        if (payload.new.sender_role === 'Child') {
          setRecentMessage(payload.new);
          setRefreshTick((t) => t + 1);
          void appendMessageToCache(payload.new);
        }
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(msgSub);
    };
  }, [pairingCode]);

  // ── Child profile sync — authoritative initial fetch + live re-sync ──────
  // TWO-STAGE subscription: the linked child id is resolved FIRST into state,
  // and the realtime channel is created ONLY AFTER that. The postgres_changes
  // filter can therefore never be `device_id=eq.` (empty) — the old single
  // effect subscribed with an empty filter at mount, which matched nothing and
  // silently dropped every profile edit until an unrelated re-render rebuilt
  // the effect. Re-runs on pairingCode too, so unlink/relink to a different
  // child mid-session re-targets fetch + channel instead of watching the
  // previous child forever.
  const [linkedChildId, setLinkedChildId] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId) return;

    let cancelled = false;

    // 1. Resolve the child's device_id from family_links (authoritative;
    //    .limit(1) — NOT .single() — so a multi-row anomaly can never kill the
    //    pipeline), then fetch the LATEST profile — never trust a stale
    //    persisted copy.
    (async () => {
      const { data: links } = await supabase
        .from('family_links')
        .select('child_device_id')
        .eq('parent_device_id', deviceId)
        .limit(1);
      const childId = links?.[0]?.child_device_id ?? childProfile?.device_id;
      if (cancelled) return;
      setLinkedChildId(childId ?? null);
      if (!childId) return;

      const { data: profile } = await supabase
        .from('child_profiles')
        .select('*')
        .eq('device_id', childId)
        .single();
      if (cancelled || !profile) return;
      const current = useAACStore.getState().childProfile;
      useAACStore.getState().setChildProfile({
        ...current,
        device_id: childId,
        nickname: profile.nickname ?? current?.nickname,
        full_name: profile.full_name ?? current?.full_name,
        fullName: profile.full_name ?? current?.fullName,
        gender: profile.settings?.childProfileGender ?? current?.gender,
        settings: profile.settings ?? current?.settings,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [deviceId, pairingCode, childProfile?.device_id]);

  // 2. Live re-sync: child edits their profile → mirror it immediately.
  //    Subscribed against the RESOLVED id only — the filter is never empty,
  //    and the callback reads the store fresh so it can never go stale.
  useEffect(() => {
    if (!linkedChildId) return;

    const profileSub = supabase.channel('home_child_profile')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'child_profiles',
        filter: `device_id=eq.${linkedChildId}`
      }, (payload: any) => {
        if (payload.new) {
          const currentProfile = useAACStore.getState().childProfile;
          useAACStore.getState().setChildProfile({
            ...currentProfile,
            nickname: payload.new.nickname || currentProfile?.nickname,
            full_name: payload.new.full_name || currentProfile?.full_name,
            fullName: payload.new.full_name || currentProfile?.fullName,
            gender: payload.new.settings?.childProfileGender || currentProfile?.gender,
            settings: payload.new.settings || currentProfile?.settings
          });
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(profileSub);
    };
  }, [linkedChildId]);

  // ── Activity analytics: real data for today / 7d / 30d ────────────────────
  useEffect(() => {
    if (!pairingCode) return;

    let cancelled = false;

    (async () => {
      const nowMs = Date.now();
      const startMs = rangeStartMs(activeTab, nowMs);

      // Lower-bound only: no upper bound, so a child message stamped a few
      // seconds in the "future" (device clock skew) is never dropped.
      const { data, error } = await supabase
        .from('messages')
        .select('sender_role, text_content, timestamp')
        .eq('channel_id', pairingCode)
        .gte('timestamp', startMs)
        .order('timestamp', { ascending: true });

      if (cancelled) return;

      // Degrade to zeros — never show a half-baked or stale widget.
      setActivity(computeActivity(error ? [] : (data ?? []), activeTab, nowMs));
    })();

    return () => {
      cancelled = true;
    };
  }, [pairingCode, activeTab, refreshTick]);

  const handleQuickReply = async (text: string) => {
    if (!pairingCode) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const payload = {
      sender: 'Parent' as const,
      senderName: localParentName || t('home.parentFallback'),
      text: text,
      timestamp: Date.now()
    };
    const delivered = await sendAACMessage(pairingCode, payload);
    if (delivered) {
      Toast.show({ type: 'success', text1: t('aac.toastSent'), text2: t('home.toastReplied', { text }), position: 'top' });
    } else {
      // Offline: park in the outbox — the message must never vanish silently.
      await queuePendingMessage({
        channel_id: pairingCode,
        sender_role: payload.sender,
        sender_name: payload.senderName,
        text_content: payload.text,
        timestamp: payload.timestamp,
        location_lat: null,
        location_lng: null,
      });
      Toast.show({ type: 'info', text1: t('aac.toastSent'), text2: t('aac.toastQueuedOffline'), position: 'top' });
    }
  };

  const handleReplayTTS = () => {
    if (recentMessage) {
      Haptics.selectionAsync();
      playTTS(recentMessage.text_content, language, 'Child');
    }
  };

  // ── AAC-Safe Tremor Filter on Quick Replies ─────────────────────────────
  // One filter per surface (NOT per pill): Oke/Ya/Tidak share the same
  // handler, and rapid ghost-taps between adjacent pills must be absorbed
  // too. haptics:false — handleQuickReply already fires its own Medium
  // impact on the accepted send, so the hook's Light impact would double-buzz.
  const quickReplyFiltered = useAccessibleAction(handleQuickReply, { haptics: false });

  return (
    <View style={styles.container}>
      <View style={styles.overlapWrapper}>
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent} bounces={false}>
        
        {/* PROACTIVE UPGRADE BANNER — trial-only, hard-gated by web_payment_active */}
        {showUpgradeBanner ? (
          <TouchableOpacity
            style={styles.upgradeCard}
            onPress={() => navigation.navigate('Paywall')}
            activeOpacity={0.9}
          >
            <LinearGradient
              colors={['#FBBF24', '#F59E0B', '#D97706']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.upgradeGradient}
            >
              <View style={styles.upgradeIcon}>
                <FontAwesome5 name="crown" size={18} color="#FFF" />
              </View>
              <View style={styles.upgradeTextWrap}>
                <Text style={styles.upgradeTitle}>
                  {t('home.upgradeTitle')}
                </Text>
                {premium.trialEndsAt ? (
                  <Text style={styles.upgradeSub}>
                    {t('home.trialUntil', { date: formatDate(premium.trialEndsAt) })}
                  </Text>
                ) : null}
              </View>
              <FontAwesome5 name="chevron-right" size={16} color="#FFF" />
            </LinearGradient>
          </TouchableOpacity>
        ) : null}

        {/* WIDGET A: Pesan Terbaru */}
      <View style={styles.card}>
        <View style={styles.messageHeader}>
          <View style={styles.messageTitleRow}>
            <FontAwesome5 name="comment-dots" size={16} color="#00B5B8" />
            <Text style={styles.widgetTitle}>{t('home.recentMessages')}</Text>
          </View>
          {recentMessage && (
            <Text style={styles.messageTime}>
              {formatTime(recentMessage.timestamp)}
            </Text>
          )}
        </View>

        {recentMessage ? (
          <>
            {/* Notif style (lock-screen): avatar + nama + waktu di header ringkas,
                teks pesan di bawahnya — lebih pendek dan modern. */}
            <View style={styles.notifCard}>
              <View style={styles.notifHeader}>
                <Image
                  source={require('../../../assets/icon.png')}
                  style={styles.notifAvatar}
                />
                <View style={styles.notifHeaderText}>
                  <Text style={styles.notifName} numberOfLines={1}>
                    {childProfile?.nickname || t('aac.childFallback')}
                  </Text>
                  <Text style={styles.notifSubtitle} numberOfLines={1}>{t('aac.childFallback')}</Text>
                </View>
                <Text style={styles.notifTime}>{formatTime(recentMessage.timestamp)}</Text>
              </View>
              <Text style={styles.notifMessage} numberOfLines={3}>
                {recentMessage.text_content}
              </Text>
            </View>

            <View style={styles.quickReplyRow}>
              <TouchableOpacity style={styles.flexBtn} onPress={() => quickReplyFiltered(t('home.quickOke'))} activeOpacity={0.8}>
                <LinearGradient colors={['#FF9800', '#F57C00']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>{t('home.quickOke')}</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.flexBtn, { flex: 1.6 }]} onPress={() => quickReplyFiltered(t('home.quickWait'))} activeOpacity={0.8}>
                <LinearGradient colors={['#34D399', '#10B981']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>{t('home.quickWait')}</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity style={styles.flexBtn} onPress={() => quickReplyFiltered(t('home.quickNo'))} activeOpacity={0.8}>
                <LinearGradient colors={['#F87171', '#EF4444']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>{t('home.quickNo')}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.viewAllBtn} onPress={() => navigation.navigate('Pesan')}>
              <Text style={styles.viewAllText}>{t('home.viewAllMessages')}</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.emptyText}>{t('home.noMessagesToday')}</Text>
        )}
      </View>

      {/* WIDGET B: Lokasi (Full Width) */}
      <TouchableOpacity 
        style={[styles.card, { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16 }]} 
        onPress={() => navigation.navigate('Lokasi')} 
        activeOpacity={0.8}
      >
        <View style={[styles.summaryIconBox, { backgroundColor: '#D1FAE5', width: 48, height: 48 }]}>
          <FontAwesome5 name="map-marker-alt" size={24} color="#059669" />
        </View>
        <View style={{ marginLeft: 16, flex: 1 }}>
          <Text style={styles.widgetTitle}>{t('home.currentLocation')}</Text>
          <Text style={[styles.summaryValue, { fontSize: 16, marginTop: 2 }]} numberOfLines={1}>{currentAddress}</Text>
          <Text style={[styles.summarySub, { fontSize: 13, marginTop: 2 }]} numberOfLines={1}>{t('home.safeZone')}</Text>
        </View>
        <FontAwesome5 name="chevron-right" size={16} color="#CBD5E1" />
      </TouchableOpacity>

      {/* WIDGET C: Aksi Cepat */}
      <View style={[styles.card, { marginTop: 8 }]}>
        <View style={[styles.sectionTitleRow, { marginBottom: 16 }]}>
          <FontAwesome5 name="bolt" size={16} color="#FACC15" />
          <Text style={styles.widgetTitle}>{t('home.quickActions')}</Text>
        </View>
        <View style={styles.grid}>
          
          <TouchableOpacity style={styles.gridItem} onPress={() => navigation.navigate('VoiceSettings')}>
            <View style={[styles.gridIconBox, { backgroundColor: '#F3E8FF' }]}>
              <FontAwesome5 name="volume-up" size={20} color="#9333EA" />
            </View>
            <Text style={[styles.gridText, { color: '#9333EA' }]} numberOfLines={1}>{t('home.voice')}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem} onPress={() => navigation.navigate('AppearanceSettings')}>
            <View style={[styles.gridIconBox, { backgroundColor: '#EEF2FF' }]}>
              <FontAwesome5 name="palette" size={20} color="#4F46E5" />
            </View>
            <Text style={[styles.gridText, { color: '#4F46E5' }]} numberOfLines={1}>{t('home.appearance')}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem} onPress={() => setComingSoonVisible(true)}>
            <View style={[styles.gridIconBox, { backgroundColor: '#DCFCE7' }]}>
              <FontAwesome5 name="puzzle-piece" size={20} color="#16A34A" />
            </View>
            <Text style={[styles.gridText, { color: '#16A34A' }]} numberOfLines={1}>{t('home.vocabRoutines')}</Text>
          </TouchableOpacity>

        </View>
      </View>

      {/* NEW WIDGET: Comprehensive Activity */}
      <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
        <View style={{ padding: 16 }}>            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <View style={styles.sectionTitleRow}>
              <FontAwesome5 name="chart-line" size={16} color="#00B5B8" />
              <Text style={styles.widgetTitle}>{t('home.activity')}</Text>
            </View>
            <FontAwesome5 name="ellipsis-h" size={16} color="#94A3B8" />
          </View>

          {/* Activity Tabs */}
          <View style={styles.activityTabsRow}>
            {ACTIVITY_TABS.map((tab) => (
              <TouchableOpacity 
                key={tab.id}
                style={[styles.activityTab, activeTab === tab.id && styles.activityTabActive]}
                onPress={() => selectTab(tab.id)}
              >
                <Text style={[styles.activityTabText, activeTab === tab.id && styles.activityTabTextActive]}>
                  {t(tab.labelKey)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* 2x2 Stats Grid — all REAL values for the active range */}
          <View style={styles.statsGrid}>
            <View style={styles.statBox}>
              <View style={[styles.statIconWrap, { backgroundColor: '#E0F2FE' }]}>
                <FontAwesome5 name="comment-dots" size={16} color="#0284C7" />
              </View>
              <View>
                <Text style={styles.statValue}>{activity.messages}</Text>
                <Text style={styles.statLabel}>{t('home.statMessages')}</Text>
              </View>
            </View>

            <View style={styles.statBox}>
              <View style={[styles.statIconWrap, { backgroundColor: '#D1FAE5' }]}>
                <FontAwesome5 name="comment-medical" size={16} color="#059669" />
              </View>
              <View>
                <Text style={styles.statValue}>{activity.uniqueWords}</Text>
                <Text style={styles.statLabel}>{t('home.statUniqueWords')}</Text>
              </View>
            </View>

            <View style={styles.statBox}>
              <View style={[styles.statIconWrap, { backgroundColor: '#FFEDD5' }]}>
                <FontAwesome5 name="sun" size={16} color="#EA580C" />
              </View>
              <View>
                <Text style={styles.statValue}>{activity.requests}</Text>
                <Text style={styles.statLabel}>{t('home.statRequests')}</Text>
              </View>
            </View>

            <View style={styles.statBox}>
              <View style={[styles.statIconWrap, { backgroundColor: '#F3E8FF' }]}>
                <FontAwesome5 name="puzzle-piece" size={16} color="#9333EA" />
              </View>
              <View>
                <Text style={styles.statValue}>{activity.responses}</Text>
                <Text style={styles.statLabel}>{t('home.statSocialResponses')}</Text>
              </View>
            </View>
          </View>

          <Text style={[styles.widgetTitle, { fontSize: 14, marginTop: 24, marginBottom: 16 }]}>
            {t('home.commActivity')}
          </Text>

          {/* Custom Flexbox Bar Chart — buckets & axis follow the active range */}
          <View style={styles.chartContainer}>
            <View style={styles.barsRow}>
              {activity.chart.map((val, idx) => {
                // Determine bar color intensity based on value relative to max
                const max = Math.max(...activity.chart, 1);
                const heightPct = Math.max((val / max) * 100, 5); // min 5% height
                
                let color = '#93C5FD'; // Low intensity
                if (val > max * 0.75) color = '#2563EB'; // High intensity
                else if (val > max * 0.4) color = '#3B82F6'; // Med intensity
                else if (val === 0) color = '#F1F5F9'; // Zero

                return (
                  <View key={idx} style={styles.barWrap}>
                    <View style={[styles.barFill, { height: `${heightPct}%`, backgroundColor: color }]} />
                  </View>
                );
              })}
            </View>
            
            <View style={styles.chartXAxis}>
              {activity.chartLabels.map((label, idx) => (
                <Text key={idx} style={styles.chartLabel}>{label}</Text>
              ))}
            </View>
          </View>
          
          {/* Chart Legend */}
          <View style={styles.chartLegend}>
            <View style={[styles.legendDot, { backgroundColor: '#3B82F6' }]} />
            <Text style={styles.legendText}>{t('home.legendLow')}</Text>
            
            <View style={styles.legendDotsRow}>
              <View style={[styles.legendDotSmall, { backgroundColor: '#34D399' }]} />
              <View style={[styles.legendDotSmall, { backgroundColor: '#FCD34D' }]} />
              <View style={[styles.legendDotSmall, { backgroundColor: '#FBBF24' }]} />
              <View style={[styles.legendDotSmall, { backgroundColor: '#F59E0B' }]} />
            </View>

            <View style={[styles.legendDot, { backgroundColor: '#9333EA', marginLeft: 8 }]} />
            <Text style={styles.legendText}>{t('home.legendHigh')}</Text>
          </View>
        </View>
      </View>

        <ComingSoonModal
          visible={comingSoonVisible}
          onClose={() => setComingSoonVisible(false)}
          title={t('home.vocabRoutines')}
        />
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#181824', // Base color to blend with header gradient
  },
  overlapWrapper: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    marginTop: -60, // Overlap the fixed 220 height gradient header
    zIndex: 10,
    elevation: 5,
    overflow: 'hidden', // CRITICAL: Fixes touch zone offset bug on Android
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    paddingTop: 24,
    paddingBottom: 120, // Keep content above bottom tabs
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
  },
  upgradeCard: {
    borderRadius: 20,
    marginBottom: 16,
    overflow: 'hidden',
    elevation: 3,
    shadowColor: '#92400E',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
  },
  upgradeGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  upgradeIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  upgradeTextWrap: {
    flex: 1,
  },
  upgradeTitle: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
  },
  upgradeSub: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
  },
  messageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  messageTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  widgetTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#11427B',
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  messageTime: {
    fontSize: 13,
    color: '#94A3B8',
  },
  notifCard: {
    backgroundColor: '#F8FAFC',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    marginBottom: 12,
  },
  notifHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  notifAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#E0F2FE',
    marginRight: 10,
  },
  notifHeaderText: {
    flex: 1,
  },
  notifName: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1E293B',
  },
  notifSubtitle: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 1,
  },
  notifTime: {
    fontSize: 12,
    color: '#94A3B8',
    marginLeft: 8,
  },
  notifMessage: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1E293B',
    lineHeight: 24,
  },
  quickReplyRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  flexBtn: {
    flex: 1,
  },
  btnGradient: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  btnText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  viewAllBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  viewAllText: {
    color: '#3B82F6',
    fontWeight: 'bold',
    fontSize: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  modalCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
  },
  modalIconBox: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#DCFCE7',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#11427B',
    textAlign: 'center',
    marginBottom: 8,
  },
  modalDesc: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
  },
  modalBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FEF9C3',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 20,
    gap: 6,
  },
  modalBadgeText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#A16207',
  },
  modalCloseBtn: {
    backgroundColor: '#11427B',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  modalCloseText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    gap: 16,
  },
  halfCard: {
    flex: 1,
    padding: 16,
  },
  summaryTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  summaryIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  summaryTitle: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#11427B',
    flex: 1,
  },
  summaryValue: {
    fontSize: 16,
    fontWeight: '900',
    color: '#059669',
  },
  summarySub: {
    fontSize: 12,
    color: '#34D399',
    fontWeight: 'bold',
  },
  summaryValueDark: {
    fontSize: 24,
    fontWeight: '900',
    color: '#0F172A',
  },
  summarySubDark: {
    fontSize: 11,
    color: '#64748B',
  },
  grid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  gridItem: {
    alignItems: 'center',
    width: '24%', // 4 items per row
  },
  gridIconBox: {
    width: 54,
    height: 54,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  gridText: {
    fontSize: 10,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  emptyText: {
    textAlign: 'center',
    color: '#94A3B8',
    fontStyle: 'italic',
    paddingVertical: 20,
  },
  
  /* NEW ACTIVITY WIDGET STYLES */
  activityTabsRow: {
    flexDirection: 'row',
    backgroundColor: '#F8FAFC',
    borderRadius: 24,
    padding: 4,
    marginBottom: 20,
  },
  activityTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 20,
  },
  activityTabActive: {
    backgroundColor: '#3B82F6',
  },
  activityTabText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#64748B',
  },
  activityTabTextActive: {
    color: '#FFFFFF',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  statBox: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#F1F5F9',
    borderRadius: 16,
    padding: 12,
  },
  statIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  statValue: {
    fontSize: 18,
    fontWeight: '900',
    color: '#0F172A',
  },
  statLabel: {
    fontSize: 11,
    color: '#64748B',
  },
  chartContainer: {
    height: 120,
    marginTop: 8,
  },
  barsRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  barWrap: {
    flex: 1,
    height: '100%',
    marginHorizontal: 1,
    justifyContent: 'flex-end',
  },
  barFill: {
    width: '100%',
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  chartXAxis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  chartLabel: {
    fontSize: 10,
    color: '#94A3B8',
  },
  chartLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
    marginBottom: 8,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  legendDotSmall: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginHorizontal: 3,
  },
  legendText: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '500',
  },
  legendDotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
  }
});
