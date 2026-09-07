import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { supabase, sendAACMessage } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';
import { formatDate } from '../../utils/format';
import { playTTS } from '../../services/ai/audioManager';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';
import * as Haptics from 'expo-haptics';
import { useAccessibleAction } from '../../hooks/useAccessibleAction';
import { useTranslation } from '../../i18n';

export default function ParentHomeScreen() {
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { pairingCode, language, deviceId, childProfile, localParentName } = useAACStore();
  
  const [recentMessage, setRecentMessage] = useState<any>(null);
  
  const { childStatus } = useAACStore();
  const currentAddress = childStatus.lastAddress || 'Lokasi belum tersedia';
  const [todayMessageCount, setTodayMessageCount] = useState<number>(0);
  
  // NEW: Comprehensive Activity Widget State
  const TABS = ['Hari Ini', '7 Hari', '30 Hari'] as const;
  type TabType = typeof TABS[number];

  const [todayUniqueWords, setTodayUniqueWords] = useState<number>(0);
  const [chartData, setChartData] = useState<number[]>(new Array(24).fill(0));
  const [activeTab, setActiveTab] = useState<TabType>('Hari Ini');

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

  useEffect(() => {
    if (!pairingCode) return;

    // 1. Fetch recent message & subscribe
    const fetchRecent = async () => {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', pairingCode)
        .eq('sender_role', 'Child')
        .order('timestamp', { ascending: false })
        .limit(1)
        .single();
      if (data) setRecentMessage(data);
    };
    fetchRecent();

    // The Activity Analytics Engine: Fetch messages today to populate Comprehensive Widget
    const fetchTodayData = async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0,0,0,0);
      const endOfDay = new Date();
      endOfDay.setHours(23,59,59,999);

      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', pairingCode)
        .eq('sender_role', 'Child')
        .gte('timestamp', startOfDay.getTime())
        .lte('timestamp', endOfDay.getTime());
        
      if (data) {
        setTodayMessageCount(data.length);
        
        const words = new Set<string>();
        const hourlyBlocks = new Array(24).fill(0);
        
        data.forEach((msg: any) => {
          if (msg.text_content) {
            msg.text_content.toLowerCase().split(/\s+/).forEach((w: string) => {
              const cleanWord = w.replace(/[^a-z0-9]/g, '');
              if (cleanWord) words.add(cleanWord);
            });
          }
          
          const h = new Date(msg.timestamp).getHours();
          hourlyBlocks[h]++;
        });
        
        setChartData(hourlyBlocks);
        setTodayUniqueWords(words.size);
      }
    };
    fetchTodayData();

    const msgSub = supabase.channel('home_recent_message')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${pairingCode}`
      }, (payload) => {
        if (payload.new.sender_role === 'Child') {
          setRecentMessage(payload.new);
          setTodayMessageCount(prev => prev + 1);
        }
      })
      .subscribe();

    const profileSub = supabase.channel('home_child_profile')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'child_profiles',
        filter: `device_id=eq.${childProfile?.device_id || ''}`
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
      supabase.removeChannel(msgSub);
      supabase.removeChannel(profileSub);
    };
  }, [pairingCode]);

  const handleQuickReply = async (text: string) => {
    if (!pairingCode) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await sendAACMessage(pairingCode, {
      sender: 'Parent',
      senderName: localParentName || t('home.parentFallback'),
      text: text,
      timestamp: Date.now()
    });
    Toast.show({ type: 'success', text1: t('aac.toastSent'), text2: t('home.toastReplied', { text }), position: 'top' });
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
                  Suka dengan Sensoria? Upgrade ke Premium sekarang.
                </Text>
                {premium.trialEndsAt ? (
                  <Text style={styles.upgradeSub}>
                    Masa coba aktif hingga {formatDate(premium.trialEndsAt)}.
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
            <Text style={styles.widgetTitle}>Pesan Terbaru</Text>
          </View>
          {recentMessage && (
            <Text style={styles.messageTime}>
              {new Date(recentMessage.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          )}
        </View>

        {recentMessage ? (
          <>
            <View style={styles.speechBubble}>
              <Text style={styles.messageText}>{recentMessage.text_content}</Text>
              
              {/* Child Avatar & Nickname Header inside bubble */}
              <View style={styles.audioRow}>
                <View style={styles.waveform}>
                  <Image 
                    source={childProfile?.gender === 'Boy' ? require('../../../assets/icon.png') : require('../../../assets/icon.png')} 
                    style={{ width: 24, height: 24, borderRadius: 12, marginRight: 8, backgroundColor: '#E0F2FE' }} 
                  />
                  <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#3B82F6' }}>
                    {childProfile?.nickname || t('aac.childFallback')}
                  </Text>
                </View>
              </View>
            </View>

            <View style={styles.quickReplyRow}>
              <TouchableOpacity style={styles.flexBtn} onPress={() => quickReplyFiltered(t('home.quickOke'))} activeOpacity={0.8}>
                <LinearGradient colors={['#FF9800', '#F57C00']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>{t('home.quickOke')}</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity style={styles.flexBtn} onPress={() => quickReplyFiltered(t('home.quickYa'))} activeOpacity={0.8}>
                <LinearGradient colors={['#34D399', '#10B981']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>{t('home.quickYa')}</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity style={styles.flexBtn} onPress={() => quickReplyFiltered(t('home.quickNo'))} activeOpacity={0.8}>
                <LinearGradient colors={['#F87171', '#EF4444']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>{t('home.quickNo')}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.viewAllBtn} onPress={() => navigation.navigate('Pesan')}>
              <Text style={styles.viewAllText}>Lihat semua pesan ➔</Text>
            </TouchableOpacity>
          </>
        ) : (
          <Text style={styles.emptyText}>Belum ada pesan masuk hari ini.</Text>
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
          <Text style={styles.widgetTitle}>Lokasi Sekarang</Text>
          <Text style={[styles.summaryValue, { fontSize: 16, marginTop: 2 }]} numberOfLines={1}>{currentAddress}</Text>
          <Text style={[styles.summarySub, { fontSize: 13, marginTop: 2 }]} numberOfLines={1}>Area aman</Text>
        </View>
        <FontAwesome5 name="chevron-right" size={16} color="#CBD5E1" />
      </TouchableOpacity>

      {/* WIDGET C: Aksi Cepat */}
      <View style={[styles.card, { marginTop: 8 }]}>
        <Text style={[styles.widgetTitle, { marginBottom: 16 }]}>Aksi Cepat</Text>
        <View style={styles.grid}>
          
          <TouchableOpacity style={styles.gridItem}>
            <View style={[styles.gridIconBox, { backgroundColor: '#DCFCE7' }]}>
              <FontAwesome5 name="puzzle-piece" size={20} color="#16A34A" />
            </View>
            <Text style={[styles.gridText, { color: '#16A34A' }]} numberOfLines={1}>Kosakata</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem}>
            <View style={[styles.gridIconBox, { backgroundColor: '#FFEDD5' }]}>
              <FontAwesome5 name="sun" size={20} color="#EA580C" />
            </View>
            <Text style={[styles.gridText, { color: '#EA580C' }]} numberOfLines={1}>Rutinitas</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem} onPress={() => navigation.navigate('VoiceSettings')}>
            <View style={[styles.gridIconBox, { backgroundColor: '#F3E8FF' }]}>
              <FontAwesome5 name="volume-up" size={20} color="#9333EA" />
            </View>
            <Text style={[styles.gridText, { color: '#9333EA' }]} numberOfLines={1}>Suara</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem} onPress={() => navigation.navigate('AppearanceSettings')}>
            <View style={[styles.gridIconBox, { backgroundColor: '#EEF2FF' }]}>
              <FontAwesome5 name="palette" size={20} color="#4F46E5" />
            </View>
            <Text style={[styles.gridText, { color: '#4F46E5' }]} numberOfLines={1}>Tampilan</Text>
          </TouchableOpacity>

        </View>
      </View>

      {/* NEW WIDGET: Comprehensive Activity */}
      <View style={[styles.card, { padding: 0, overflow: 'hidden' }]}>
        <View style={{ padding: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <Text style={styles.widgetTitle}>Aktivitas</Text>
            <FontAwesome5 name="ellipsis-h" size={16} color="#94A3B8" />
          </View>

          {/* Activity Tabs */}
          <View style={styles.activityTabsRow}>
            {TABS.map((tab) => (
              <TouchableOpacity 
                key={tab}
                style={[styles.activityTab, activeTab === tab && styles.activityTabActive]}
                onPress={() => setActiveTab(tab)}
              >
                <Text style={[styles.activityTabText, activeTab === tab && styles.activityTabTextActive]}>
                  {tab}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* 2x2 Stats Grid */}
          <View style={styles.statsGrid}>
            <View style={styles.statBox}>
              <View style={[styles.statIconWrap, { backgroundColor: '#E0F2FE' }]}>
                <FontAwesome5 name="comment-dots" size={16} color="#0284C7" />
              </View>
              <View>
                <Text style={styles.statValue}>{todayMessageCount}</Text>
                <Text style={styles.statLabel}>Pesan disampaikan</Text>
              </View>
            </View>

            <View style={styles.statBox}>
              <View style={[styles.statIconWrap, { backgroundColor: '#D1FAE5' }]}>
                <FontAwesome5 name="comment-medical" size={16} color="#059669" />
              </View>
              <View>
                <Text style={styles.statValue}>{todayUniqueWords}</Text>
                <Text style={styles.statLabel}>Kata berbeda</Text>
              </View>
            </View>

            <View style={styles.statBox}>
              <View style={[styles.statIconWrap, { backgroundColor: '#FFEDD5' }]}>
                <FontAwesome5 name="sun" size={16} color="#EA580C" />
              </View>
              <View>
                <Text style={styles.statValue}>0</Text>
                <Text style={styles.statLabel}>Permintaan</Text>
              </View>
            </View>

            <View style={styles.statBox}>
              <View style={[styles.statIconWrap, { backgroundColor: '#F3E8FF' }]}>
                <FontAwesome5 name="puzzle-piece" size={16} color="#9333EA" />
              </View>
              <View>
                <Text style={styles.statValue}>0</Text>
                <Text style={styles.statLabel}>Respons sosial</Text>
              </View>
            </View>
          </View>

          <Text style={[styles.widgetTitle, { fontSize: 14, marginTop: 24, marginBottom: 16 }]}>
            Aktivitas Komunikasi
          </Text>

          {/* Custom Flexbox Bar Chart */}
          <View style={styles.chartContainer}>
            <View style={styles.barsRow}>
              {chartData.map((val, idx) => {
                // Determine bar color intensity based on value relative to max
                const max = Math.max(...chartData, 1);
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
              <Text style={styles.chartLabel}>00</Text>
              <Text style={styles.chartLabel}>04</Text>
              <Text style={styles.chartLabel}>08</Text>
              <Text style={styles.chartLabel}>12</Text>
              <Text style={styles.chartLabel}>16</Text>
              <Text style={styles.chartLabel}>20</Text>
              <Text style={styles.chartLabel}>24</Text>
            </View>
          </View>
          
          {/* Chart Legend */}
          <View style={styles.chartLegend}>
            <View style={[styles.legendDot, { backgroundColor: '#3B82F6' }]} />
            <Text style={styles.legendText}>Rendah</Text>
            
            <View style={styles.legendDotsRow}>
              <View style={[styles.legendDotSmall, { backgroundColor: '#34D399' }]} />
              <View style={[styles.legendDotSmall, { backgroundColor: '#FCD34D' }]} />
              <View style={[styles.legendDotSmall, { backgroundColor: '#FBBF24' }]} />
              <View style={[styles.legendDotSmall, { backgroundColor: '#F59E0B' }]} />
            </View>

            <View style={[styles.legendDot, { backgroundColor: '#9333EA', marginLeft: 8 }]} />
            <Text style={styles.legendText}>Tinggi</Text>
          </View>
        </View>
      </View>

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
  messageTime: {
    fontSize: 12,
    color: '#94A3B8',
  },
  speechBubble: {
    backgroundColor: '#F0F9FF',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  messageText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1E293B',
    marginBottom: 12,
  },
  audioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 3,
  },
  waveBar: {
    width: 3,
    backgroundColor: '#3B82F6',
    borderRadius: 2,
    opacity: 0.6,
  },
  playButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#3B82F6',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#3B82F6',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
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
