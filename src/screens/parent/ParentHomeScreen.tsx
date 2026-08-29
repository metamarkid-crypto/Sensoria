import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { supabase, sendAACMessage } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';
import { playTTS } from '../../services/ai/audioManager';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';

export default function ParentHomeScreen() {
  const navigation = useNavigation<any>();
  const { pairingCode, language, deviceId, childProfile } = useAACStore();
  
  const [recentMessage, setRecentMessage] = useState<any>(null);
  const [isOnline, setIsOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);

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

    const msgSub = supabase.channel('home_recent_message')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${pairingCode}`
      }, (payload) => {
        if (payload.new.sender_role === 'Child') {
          setRecentMessage(payload.new);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(msgSub);
    };
  }, [pairingCode]);

  useEffect(() => {
    // 2. Real-time Connection Status (Moved from Header to this Overlapping Card)
    let presenceSub: any = null;

    const checkStatus = async () => {
      if (!deviceId) return;
      const { data: link } = await supabase
        .from('family_links')
        .select('child_device_id')
        .eq('parent_device_id', deviceId)
        .single();
        
      if (!link) return;

      const fetchPresence = async () => {
        const { data } = await supabase.from('devices').select('last_seen').eq('id', link.child_device_id).single();
        if (data?.last_seen) updateOnlineStatus(data.last_seen);
      };
      await fetchPresence();

      presenceSub = supabase.channel('public:devices')
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'devices',
          filter: `id=eq.${link.child_device_id}`
        }, (payload) => {
          if (payload.new.last_seen) updateOnlineStatus(payload.new.last_seen);
        }).subscribe();
    };

    const updateOnlineStatus = (lastSeenTimestamp: string) => {
      const lastActive = new Date(lastSeenTimestamp);
      const diffMins = Math.floor((new Date().getTime() - lastActive.getTime()) / 60000);
      if (diffMins < 5) {
        setIsOnline(true);
      } else {
        setIsOnline(false);
        setLastSeen(`${diffMins} menit lalu`);
      }
    };

    checkStatus();
    return () => {
      if (presenceSub) supabase.removeChannel(presenceSub);
    };
  }, [deviceId]);

  const handleQuickReply = async (text: string) => {
    if (!pairingCode) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await sendAACMessage(pairingCode, {
      sender: 'Parent',
      senderName: 'Orang Tua',
      text: text,
      timestamp: Date.now()
    });
    Toast.show({ type: 'success', text1: 'Terkirim', text2: `Balasan "${text}" telah dikirim.`, position: 'top' });
  };

  const handleReplayTTS = () => {
    if (recentMessage) {
      Haptics.selectionAsync();
      playTTS(recentMessage.text_content, language, 'Child');
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent} bounces={false}>
      
      {/* CHILD STATUS OVERLAPPING CARD */}
      <View style={styles.overlappingCard}>
        <View style={styles.avatarContainer}>
          {/* Fallback to local boy/girl avatar based on childProfile */}
          <Image 
            source={childProfile?.gender === 'Girl' ? require('../../../assets/icon.png') : require('../../../assets/icon.png')} 
            style={styles.avatarImage} 
          />
        </View>
        <View style={styles.childInfo}>
          <Text style={styles.childName}>{childProfile?.nickname || childProfile?.fullName || 'Belum ditautkan'}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: isOnline ? '#34C759' : '#94A3B8' }]} />
            <Text style={[styles.statusText, { color: isOnline ? '#34C759' : '#94A3B8' }]}>
              {isOnline ? 'Terhubung sekarang' : 'Offline'}
            </Text>
          </View>
          <Text style={styles.lastSeenText}>
            Terakhir aktif: {isOnline ? 'Sekarang' : (lastSeen || 'Belum diketahui')}
          </Text>
        </View>
      </View>

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
              
              {/* Fake Waveform & Play Button */}
              <View style={styles.audioRow}>
                <View style={styles.waveform}>
                  <FontAwesome5 name="robot" size={24} color="#3B82F6" style={{marginRight: 10}} />
                  {/* Mocking waveform with vertical bars */}
                  {[...Array(15)].map((_, i) => (
                    <View key={i} style={[styles.waveBar, { height: 4 + Math.random() * 12 }]} />
                  ))}
                </View>
                <TouchableOpacity style={styles.playButton} onPress={handleReplayTTS}>
                  <FontAwesome5 name="play" size={12} color="#FFF" style={{ marginLeft: 3 }} />
                </TouchableOpacity>
              </View>
            </View>

            {/* Quick Replies (Flex 1) */}
            <View style={styles.quickReplyRow}>
              <TouchableOpacity style={styles.flexBtn} onPress={() => handleQuickReply('Oke')} activeOpacity={0.8}>
                <LinearGradient colors={['#FF9800', '#F57C00']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>👍 Oke</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity style={styles.flexBtn} onPress={() => handleQuickReply('Ya')} activeOpacity={0.8}>
                <LinearGradient colors={['#34D399', '#10B981']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>☑️ Ya</Text>
                </LinearGradient>
              </TouchableOpacity>
              <TouchableOpacity style={styles.flexBtn} onPress={() => handleQuickReply('Tidak')} activeOpacity={0.8}>
                <LinearGradient colors={['#F87171', '#EF4444']} style={styles.btnGradient}>
                  <Text style={styles.btnText}>❌ Tidak</Text>
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

      {/* WIDGET B: Lokasi & Aktivitas */}
      <View style={styles.row}>
        <View style={[styles.card, styles.halfCard]}>
          <View style={styles.summaryTop}>
            <View style={[styles.summaryIconBox, { backgroundColor: '#D1FAE5' }]}>
              <FontAwesome5 name="map-marker-alt" size={20} color="#059669" />
            </View>
            <Text style={styles.summaryTitle}>Lokasi Sekarang</Text>
          </View>
          <Text style={styles.summaryValue}>Rumah</Text>
          <Text style={styles.summarySub}>Area aman</Text>
        </View>

        <View style={[styles.card, styles.halfCard]}>
          <View style={styles.summaryTop}>
            <View style={[styles.summaryIconBox, { backgroundColor: '#E0F2FE', padding: 0 }]}>
              <FontAwesome5 name="chart-bar" size={20} color="#0284C7" />
            </View>
            <Text style={styles.summaryTitle}>Aktivitas Hari Ini</Text>
          </View>
          <Text style={styles.summaryValueDark}>24</Text>
          <Text style={styles.summarySubDark}>Pesan disampaikan</Text>
        </View>
      </View>

      {/* WIDGET C: Aksi Cepat */}
      <View style={[styles.card, { marginTop: 8 }]}>
        <Text style={[styles.widgetTitle, { marginBottom: 16 }]}>Aksi Cepat</Text>
        <View style={styles.grid}>
          
          <TouchableOpacity style={styles.gridItem}>
            <View style={[styles.gridIconBox, { backgroundColor: '#DCFCE7' }]}>
              <FontAwesome5 name="puzzle-piece" size={24} color="#16A34A" />
            </View>
            <Text style={[styles.gridText, { color: '#16A34A' }]}>Kosakata</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem}>
            <View style={[styles.gridIconBox, { backgroundColor: '#FFEDD5' }]}>
              <FontAwesome5 name="sun" size={24} color="#EA580C" />
            </View>
            <Text style={[styles.gridText, { color: '#EA580C' }]}>Rutinitas</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem} onPress={() => navigation.navigate('VoiceSettings')}>
            <View style={[styles.gridIconBox, { backgroundColor: '#F3E8FF' }]}>
              <FontAwesome5 name="volume-up" size={24} color="#9333EA" />
            </View>
            <Text style={[styles.gridText, { color: '#9333EA' }]}>Suara</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem}>
            <View style={[styles.gridIconBox, { backgroundColor: '#E0F2FE' }]}>
              <FontAwesome5 name="link" size={24} color="#0284C7" />
            </View>
            <Text style={[styles.gridText, { color: '#0284C7' }]}>Perangkat</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem}>
            <View style={[styles.gridIconBox, { backgroundColor: '#FCE7F3' }]}>
              <FontAwesome5 name="user" size={24} color="#DB2777" />
            </View>
            <Text style={[styles.gridText, { color: '#DB2777' }]}>Profil Anak</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.gridItem} onPress={() => navigation.navigate('AppearanceSettings')}>
            <View style={[styles.gridIconBox, { backgroundColor: '#EEF2FF' }]}>
              <FontAwesome5 name="palette" size={24} color="#4F46E5" />
            </View>
            <Text style={[styles.gridText, { color: '#4F46E5' }]}>Tampilan</Text>
          </TouchableOpacity>

        </View>
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F0F4F8', // Light slate background
  },
  scrollContent: {
    padding: 20,
    paddingTop: 0,
    paddingBottom: 40,
  },
  overlappingCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: -40, // Pull up to overlap the gradient header
    marginBottom: 20,
    
    // CRITICAL: Defeating Z-Index Clipping Bug
    zIndex: 10,
    elevation: 5, 
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  avatarContainer: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#E2E8F0',
    marginRight: 16,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#F1F5F9',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  childInfo: {
    flex: 1,
  },
  childName: {
    fontSize: 22,
    fontWeight: '900',
    color: '#11427B',
    marginBottom: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  statusText: {
    fontSize: 14,
    fontWeight: 'bold',
  },
  lastSeenText: {
    fontSize: 12,
    color: '#94A3B8',
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
    fontSize: 12,
    fontWeight: 'bold',
    color: '#11427B',
    flex: 1,
  },
  summaryValue: {
    fontSize: 18,
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
    fontSize: 12,
    color: '#64748B',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 16,
  },
  gridItem: {
    width: '30%',
    alignItems: 'center',
    marginBottom: 8,
  },
  gridIconBox: {
    width: 64,
    height: 64,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  gridText: {
    fontSize: 12,
    fontWeight: 'bold',
  },
  emptyText: {
    textAlign: 'center',
    color: '#94A3B8',
    fontStyle: 'italic',
    paddingVertical: 20,
  }
});
