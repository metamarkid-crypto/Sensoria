import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView, Modal, KeyboardAvoidingView, Platform, TextInput } from 'react-native';
import { useAACStore } from '../../store/useAACStore';
import { sendAACMessage, subscribeToAACMessages, getAACMessagesHistory, supabase } from '../../services/db/supabase';
import { playTTS } from '../../services/ai/audioManager';
import { logger } from '../../utils/logger';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';

export default function ParentMessagesScreen() {
  const { language, deviceId, pairingCode, setPairingCode, setSpeechRate, setChildVoiceGender } = useAACStore();
  const [messages, setMessages] = useState<{ senderRole: string; senderName: string; text: string; time: string; location: any; isSelf: boolean }[]>([]);
  const [pairingRole, setPairingRole] = useState('Ayah');
  const [showPairing, setShowPairing] = useState(false);
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [isLinking, setIsLinking] = useState(false);

  useEffect(() => {
    const loadHistoryAndChild = async () => {
      if (deviceId) {
        const { data: links } = await supabase
          .from('family_links')
          .select('child_device_id')
          .eq('parent_device_id', deviceId)
          .single();
        if (links) {
          const { data: profile } = await supabase
            .from('child_profiles')
            .select('settings')
            .eq('device_id', links.child_device_id)
            .single();
          if (profile?.settings) {
            setSpeechRate(profile.settings.speechRate || 1.0);
            setChildVoiceGender(profile.settings.childVoiceGender || 'Boy');
          }
          
          const { data: childDevice } = await supabase
            .from('devices')
            .select('pairing_code')
            .eq('id', links.child_device_id)
            .single();
            
          if (childDevice?.pairing_code) {
            setPairingCode(childDevice.pairing_code);
            return childDevice.pairing_code;
          }
        }
      }
      return pairingCode;
    };

    const loadData = async () => {
      const activeChannel = await loadHistoryAndChild();
      if (!activeChannel) return;

      const historyData = await getAACMessagesHistory(activeChannel);
      const formattedHistory = historyData.map((msg: any) => ({
        senderRole: msg.sender_role,
        senderName: msg.sender_name,
        text: msg.text_content,
        time: new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        location: msg.location_lat ? { latitude: msg.location_lat, longitude: msg.location_lng } : null,
        isSelf: msg.sender_role === 'Parent' && msg.sender_name === pairingRole
      }));
      setMessages(formattedHistory);
    };
    loadData();

    if (!pairingCode) return;
    
    logger.setUserContext(pairingRole, pairingCode);
    
    const channel = subscribeToAACMessages(pairingCode, (payload) => {
      try {
        const timeStr = new Date(payload.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const isSelf = payload.sender === 'Parent' && payload.senderName === pairingRole;

        setMessages(prev => [{ 
          senderRole: payload.sender, 
          senderName: payload.senderName || payload.sender, 
          text: payload.text, 
          time: timeStr, 
          location: payload.location,
          isSelf
        }, ...prev]);

        if (!isSelf) {
          playTTS(payload.text, language, payload.sender === 'Child' ? 'Child' : 'Parent');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      } catch (err) {
        console.error('Error handling incoming AAC message:', err);
      }
    });

    return () => {
      channel.unsubscribe();
    };
  }, [pairingRole, language, deviceId, pairingCode]);

  const handleQuickReply = async (idText: string, zhText: string) => {
    if (!pairingCode) {
      Toast.show({ type: 'error', text1: 'Gagal', text2: 'Anda belum terhubung ke perangkat anak.', position: 'top' });
      setShowPairing(true);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    const textToSend = language === 'id' ? idText : zhText;
    
    await sendAACMessage(pairingCode, {
      sender: 'Parent',
      senderName: pairingRole,
      text: textToSend,
      timestamp: Date.now()
    });
    Toast.show({ type: 'success', text1: 'Terkirim', text2: `Balasan "${textToSend}" telah dikirim ke obrolan.`, position: 'top' });
  };

  const handleLinkDevice = async () => {
    if (!pairingCodeInput || pairingCodeInput.length < 6) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Masukkan 6 digit kode dari perangkat anak.', position: 'top' });
      return;
    }
    
    if (!deviceId) return;
    
    setIsLinking(true);
    try {
      const { data, error } = await supabase.rpc('link_device', {
        p_child_code: pairingCodeInput,
        p_parent_device_id: deviceId,
        p_parent_label: pairingRole
      });

      if (error) {
        if (error.message.includes('KODE_TIDAK_VALID')) {
          Toast.show({ type: 'error', text1: 'Gagal', text2: 'Kode sambung tidak valid atau sudah kadaluarsa.', position: 'top' });
        } else if (error.message.includes('SLOT_PENUH')) {
          Toast.show({ type: 'info', text1: '🌟 Upgrade ke Premium', text2: 'Slot keluarga sudah penuh! Akun gratis hanya mendukung 1 perangkat Orang Tua.', position: 'top' });
        } else {
          Toast.show({ type: 'error', text1: 'Gagal', text2: 'Terjadi kesalahan sistem.', position: 'top' });
        }
      } else {
        setPairingCode(pairingCodeInput);
        Toast.show({ type: 'success', text1: 'Berhasil! 🎉', text2: 'Perangkat berhasil terhubung dengan akun Anak.', position: 'top' });
        setShowPairing(false);
      }
    } catch (e) {
      console.error(e);
      Toast.show({ type: 'error', text1: 'Error', text2: 'Gagal menyambungkan perangkat.', position: 'top' });
    } finally {
      setIsLinking(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* INBOX CHAT */}
      <View style={styles.chatSection}>
        {messages.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>Belum ada riwayat obrolan.</Text>
            {!pairingCode && (
              <TouchableOpacity style={styles.linkButton} onPress={() => setShowPairing(true)}>
                <Text style={styles.linkButtonText}>🔗 Sambungkan dengan Anak</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <FlatList
            data={messages}
            keyExtractor={(_, index) => index.toString()}
            inverted
            contentContainerStyle={{ paddingBottom: 20 }}
            style={styles.inbox}
            renderItem={({ item: msg }) => {
              const bubbleStyle = msg.isSelf ? styles.bubbleSelf : (msg.senderRole === 'Child' ? styles.bubbleChild : styles.bubbleOtherParent);
              const textStyle = msg.isSelf ? styles.messageTextSelf : styles.messageTextOther;
              const timeStyle = msg.isSelf ? styles.timeTextSelf : styles.timeTextOther;
              
              return (
                <View style={[styles.messageBubbleContainer, msg.isSelf ? styles.containerSelf : styles.containerOther]}>
                  <Text style={styles.senderNameText}>
                    {msg.senderName} {msg.senderRole === 'Child' ? '🧒' : (msg.isSelf ? '(Anda)' : '👩‍👦')}
                  </Text>
                  <View style={[styles.messageBubble, bubbleStyle]}>
                    <Text style={textStyle}>{msg.text}</Text>
                    <Text style={timeStyle}>{msg.time}</Text>
                  </View>
                </View>
              );
            }}
          />
        )}
      </View>

      {/* QUICK REPLIES */}
      <View style={styles.quickReplyWrapper}>
        <Text style={styles.replySectionTitle}>Balas Cepat (Quick Reply)</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickReplyScroll}>
          <TouchableOpacity onPress={() => handleQuickReply('Oke', '好的')} activeOpacity={0.8}>
            <LinearGradient colors={['#FF9800', '#F57C00']} style={styles.replyChip}>
              <Text style={styles.replyText}>👍 Oke</Text>
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleQuickReply('Ya', '是')} activeOpacity={0.8}>
            <LinearGradient colors={['#00B5B8', '#008C8F']} style={styles.replyChip}>
              <Text style={styles.replyText}>✅ Ya</Text>
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleQuickReply('Tidak', '不是')} activeOpacity={0.8}>
            <LinearGradient colors={['#FF6B6B', '#E74C3C']} style={styles.replyChip}>
              <Text style={styles.replyText}>❌ Tidak</Text>
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => handleQuickReply('Tunggu sebentar', '稍等一下')} activeOpacity={0.8}>
            <LinearGradient colors={['#11427B', '#2C3E50']} style={styles.replyChip}>
              <Text style={styles.replyText}>⏳ Tunggu</Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </View>

      {/* PAIRING MODAL */}
      <Modal visible={showPairing} animationType="slide" transparent>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.pairingModalContainer}>
            <View style={styles.pairingHeader}>
              <Text style={styles.pairingHeaderTitle}>Tautkan Perangkat</Text>
              <TouchableOpacity onPress={() => setShowPairing(false)}>
                <Text style={styles.pairingHeaderClose}>Tutup</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.pairingTopSection}>
              <Text style={styles.pairingLabel}>1. Siapa Anda?</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.roleScroll}>
                {['Ayah', 'Ibu', 'Kakek', 'Nenek', 'Kakak'].map(role => (
                  <TouchableOpacity key={role} style={[styles.roleBtn, pairingRole === role && styles.roleBtnActive]} onPress={() => setPairingRole(role)}>
                    <Text style={[styles.roleText, pairingRole === role && styles.roleTextActive]}>{role}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              
              <Text style={[styles.pairingLabel, { marginTop: 20 }]}>2. Masukkan 6 Digit Kode Anak</Text>
              <View style={styles.pairingInputWrapper}>
                <TextInput 
                  style={styles.pairingInputLarge} placeholder="------" value={pairingCodeInput} onChangeText={setPairingCodeInput}
                  keyboardType="number-pad" maxLength={6} autoFocus={true} selectionColor="#00B5B8"
                />
                <TouchableOpacity style={styles.pairingSubmitLarge} onPress={handleLinkDevice} disabled={isLinking}>
                  <Text style={styles.pairingSubmitTextLarge}>{isLinking ? 'Menautkan...' : 'Tautkan Sekarang'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ECE5DD' },
  chatSection: { flex: 1, paddingTop: 16 },
  inbox: { flex: 1, paddingHorizontal: 16 },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  emptyText: { color: '#94A3B8', fontStyle: 'italic', textAlign: 'center', marginBottom: 20 },
  linkButton: { backgroundColor: '#FF9800', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12 },
  linkButtonText: { color: '#FFF', fontWeight: 'bold' },
  
  messageBubbleContainer: { marginBottom: 12, maxWidth: '85%' },
  containerSelf: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  containerOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  senderNameText: { fontSize: 11, fontWeight: 'bold', color: '#11427B', marginBottom: 2, paddingHorizontal: 4 },
  messageBubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, elevation: 1 },
  bubbleSelf: { backgroundColor: '#DCF8C6', borderTopRightRadius: 4 },
  bubbleChild: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 4 },
  bubbleOtherParent: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 4, borderWidth: 1, borderColor: '#E2E8F0' },
  messageTextSelf: { fontSize: 16, color: '#303030' },
  messageTextOther: { fontSize: 16, color: '#303030' },
  timeTextSelf: { fontSize: 11, color: '#667781', marginTop: 4, textAlign: 'right' },
  timeTextOther: { fontSize: 11, color: '#667781', marginTop: 4, textAlign: 'right' },
  
  quickReplyWrapper: { paddingVertical: 16, backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, elevation: 10 },
  replySectionTitle: { fontSize: 14, fontWeight: 'bold', color: '#64748B', paddingHorizontal: 16, paddingBottom: 10 },
  quickReplyScroll: { paddingHorizontal: 16, gap: 12 },
  replyChip: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 24, marginRight: 12 },
  replyText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  pairingModalContainer: { backgroundColor: '#F8FAFC', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40 },
  pairingHeader: { flexDirection: 'row', justifyContent: 'space-between', padding: 20, backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  pairingHeaderTitle: { fontSize: 20, fontWeight: 'bold', color: '#11427B' },
  pairingHeaderClose: { fontSize: 16, color: '#FF6B6B', fontWeight: 'bold' },
  pairingTopSection: { padding: 20, backgroundColor: '#FFF' },
  pairingLabel: { fontSize: 16, fontWeight: 'bold', color: '#334155', marginBottom: 12 },
  pairingInputWrapper: { marginTop: 8 },
  pairingInputLarge: { borderWidth: 2, borderColor: '#CBD5E1', borderRadius: 12, padding: 16, fontSize: 32, letterSpacing: 8, textAlign: 'center', fontWeight: 'bold', color: '#11427B', backgroundColor: '#F1F5F9', marginBottom: 16 },
  pairingSubmitLarge: { backgroundColor: '#00B5B8', padding: 16, borderRadius: 12, alignItems: 'center' },
  pairingSubmitTextLarge: { color: '#FFF', fontWeight: 'bold', fontSize: 18 },
  roleScroll: { gap: 10, paddingBottom: 8 },
  roleBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 20, borderWidth: 1, borderColor: '#CBD5E1', backgroundColor: '#F8FAFC' },
  roleBtnActive: { borderColor: '#11427B', backgroundColor: '#E0F2FE' },
  roleText: { color: '#64748B', fontWeight: 'bold' },
  roleTextActive: { color: '#11427B' }
});
