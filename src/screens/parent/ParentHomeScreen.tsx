import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { supabase, sendAACMessage } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';

export default function ParentHomeScreen() {
  const navigation = useNavigation<any>();
  const { pairingCode, language } = useAACStore();
  const [recentMessage, setRecentMessage] = useState<any>(null);

  useEffect(() => {
    if (!pairingCode) return;

    // Fetch the most recent message from child
    const fetchRecent = async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', pairingCode)
        .eq('sender_role', 'Child')
        .order('timestamp', { ascending: false })
        .limit(1)
        .single();
        
      if (data) {
        setRecentMessage(data);
      }
    };

    fetchRecent();

    // Subscribe to new messages from child for Widget A
    const subscription = supabase.channel('home_recent_message')
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
      supabase.removeChannel(subscription);
    };
  }, [pairingCode]);

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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      
      {/* WIDGET A: Pesan Terbaru */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Pesan Terbaru</Text>
        <View style={styles.card}>
          {recentMessage ? (
            <>
              <View style={styles.messageHeader}>
                <FontAwesome5 name="child" size={16} color="#11427B" />
                <Text style={styles.messageTime}>
                  {new Date(recentMessage.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
              <Text style={styles.messageText}>"{recentMessage.text_content}"</Text>
              
              {/* Mini Quick Replies */}
              <View style={styles.quickRepliesContainer}>
                <TouchableOpacity style={styles.miniBtn} onPress={() => handleQuickReply('Oke')}>
                  <Text style={styles.miniBtnText}>👍 Oke</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.miniBtn} onPress={() => handleQuickReply('Ya')}>
                  <Text style={styles.miniBtnText}>✅ Ya</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.miniBtn} onPress={() => handleQuickReply('Tidak')}>
                  <Text style={styles.miniBtnText}>❌ Tidak</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={styles.linkContainer} onPress={() => navigation.navigate('Pesan')}>
                <Text style={styles.linkText}>Lihat semua ➔</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={styles.emptyText}>Belum ada pesan dari anak hari ini.</Text>
          )}
        </View>
      </View>

      {/* WIDGET B: Contextual Overview */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Ringkasan</Text>
        <View style={styles.row}>
          <View style={[styles.card, styles.halfCard]}>
            <FontAwesome5 name="map-marker-alt" size={24} color="#00B5B8" style={{marginBottom: 8}} />
            <Text style={styles.statLabel}>Lokasi</Text>
            <Text style={styles.statValue}>📍 Area Aman</Text>
          </View>
          <View style={[styles.card, styles.halfCard]}>
            <FontAwesome5 name="chart-bar" size={24} color="#FF9800" style={{marginBottom: 8}} />
            <Text style={styles.statLabel}>Aktivitas</Text>
            <Text style={styles.statValue}>📊 24 Pesan</Text>
          </View>
        </View>
      </View>

      {/* WIDGET C: Aksi Cepat (Quick Actions Grid) */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Aksi Cepat</Text>
        <View style={styles.gridContainer}>
          <TouchableOpacity style={styles.gridItem}>
            <View style={[styles.iconCircle, {backgroundColor: '#E0F2FE'}]}>
              <FontAwesome5 name="puzzle-piece" size={20} color="#0284C7" />
            </View>
            <Text style={styles.gridText}>Kosakata</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.gridItem} onPress={() => navigation.navigate('VoiceSettings')}>
            <View style={[styles.iconCircle, {backgroundColor: '#FEF3C7'}]}>
              <FontAwesome5 name="volume-up" size={20} color="#D97706" />
            </View>
            <Text style={styles.gridText}>Suara</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.gridItem} onPress={() => navigation.navigate('AppearanceSettings')}>
            <View style={[styles.iconCircle, {backgroundColor: '#F3E8FF'}]}>
              <FontAwesome5 name="palette" size={20} color="#9333EA" />
            </View>
            <Text style={styles.gridText}>Tampilan</Text>
          </TouchableOpacity>
        </View>
      </View>
      
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  content: {
    padding: 20,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#64748B',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
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
    marginBottom: 8,
  },
  messageTime: {
    fontSize: 12,
    color: '#94A3B8',
    fontWeight: 'bold',
  },
  messageText: {
    fontSize: 20,
    color: '#11427B',
    fontWeight: 'bold',
    fontStyle: 'italic',
    marginBottom: 16,
  },
  emptyText: {
    color: '#94A3B8',
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 10,
  },
  quickRepliesContainer: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 16,
  },
  miniBtn: {
    backgroundColor: '#F1F5F9',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  miniBtnText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#334155',
  },
  linkContainer: {
    alignItems: 'center',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  linkText: {
    color: '#00B5B8',
    fontWeight: 'bold',
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  halfCard: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
  },
  statLabel: {
    fontSize: 12,
    color: '#94A3B8',
    fontWeight: 'bold',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#334155',
  },
  gridContainer: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    justifyContent: 'space-around',
  },
  gridItem: {
    alignItems: 'center',
  },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  gridText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#475569',
  }
});
