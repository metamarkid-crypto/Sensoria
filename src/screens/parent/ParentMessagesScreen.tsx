import React, { useState, useEffect, useRef } from 'react';
import { 
  View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, 
  KeyboardAvoidingView, Platform, ScrollView, Modal, Alert 
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase, sendAACMessage } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';

export default function ParentMessagesScreen() {
  const insets = useSafeAreaInsets();
  const { pairingCode, customQuickReplies, addCustomQuickReply, removeCustomQuickReply } = useAACStore();
  
  const [messages, setMessages] = useState<any[]>([]);
  const [inputText, setInputText] = useState('');
  
  // Custom Reply Modal State
  const [isModalVisible, setModalVisible] = useState(false);
  const [newReplyText, setNewReplyText] = useState('');
  
  const flatListRef = useRef<FlatList>(null);

  // 1. Data Fetching and Real-Time Sync (SAFE - NO TTS TRIGGER)
  useEffect(() => {
    if (!pairingCode) return;

    const fetchMessages = async () => {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('channel_id', pairingCode)
        .order('timestamp', { ascending: false }); // Newest to oldest for inverted FlatList
      if (data) setMessages(data);
    };

    fetchMessages();

    // Visual localized listener only
    const msgSub = supabase.channel('parent_messages_screen')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${pairingCode}`
      }, (payload) => {
        // Only append visually (to the top since inverted), TTS is handled by ParentDashboardScreen
        setMessages((prev) => [payload.new, ...prev]);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(msgSub);
    };
  }, [pairingCode]);

  const handleSend = async (text: string) => {
    if (!text.trim() || !pairingCode) return;
    
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await sendAACMessage(pairingCode, {
      sender: 'Parent',
      senderName: 'Orang Tua',
      text: text.trim(),
      timestamp: Date.now()
    });
    
    setInputText('');
  };

  const handleSaveQuickReply = () => {
    if (newReplyText.trim()) {
      addCustomQuickReply(newReplyText.trim());
      setNewReplyText('');
      setModalVisible(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      Alert.alert('Kosong', 'Masukkan teks balasan favorit Anda.');
    }
  };

  const handleLongPressReply = (reply: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(
      'Hapus Balasan Cepat',
      `Apakah Anda yakin ingin menghapus "${reply}"?`,
      [
        { text: 'Batal', style: 'cancel' },
        { 
          text: 'Hapus', 
          style: 'destructive', 
          onPress: () => {
            removeCustomQuickReply(reply);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        }
      ]
    );
  };

  const renderMessage = ({ item }: { item: any }) => {
    const isChild = item.sender_role === 'Child';
    return (
      <View style={[styles.messageBubbleWrapper, isChild ? styles.wrapperLeft : styles.wrapperRight]}>
        <View style={[styles.messageBubble, isChild ? styles.bubbleChild : styles.bubbleParent]}>
          <Text style={[styles.messageText, isChild ? styles.textChild : styles.textParent]}>
            {item.text_content}
          </Text>
          <Text style={[styles.timestamp, isChild ? styles.timeChild : styles.timeParent]}>
            {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <LinearGradient colors={['#181824', '#11427B']} style={styles.header}>
        <Text style={styles.headerTitle}>Pesan</Text>
      </LinearGradient>

      <KeyboardAvoidingView 
        style={styles.flex1} 
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id.toString()}
          renderItem={renderMessage}
          contentContainerStyle={styles.listContent}
          inverted={true}
          showsVerticalScrollIndicator={false}
        />

        <View style={styles.inputSection}>
          {/* Custom Quick Replies */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.quickReplyScroll} contentContainerStyle={styles.quickReplyContent}>
            {customQuickReplies.map((reply, index) => (
              <TouchableOpacity 
                key={index} 
                style={styles.quickReplyPill} 
                onPress={() => handleSend(reply)}
                onLongPress={() => handleLongPressReply(reply)}
                delayLongPress={500}
              >
                <Text style={styles.quickReplyText}>{reply}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity 
              style={[styles.quickReplyPill, styles.addPill]} 
              onPress={() => setModalVisible(true)}
            >
              <FontAwesome5 name="plus" size={12} color="#00B5B8" style={{marginRight: 4}} />
              <Text style={[styles.quickReplyText, { color: '#00B5B8', fontWeight: 'bold' }]}>Tambah</Text>
            </TouchableOpacity>
          </ScrollView>

          {/* Main Input Area */}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.textInput}
              placeholder="Tulis pesan..."
              placeholderTextColor="#94A3B8"
              value={inputText}
              onChangeText={setInputText}
              onSubmitEditing={() => handleSend(inputText)}
            />
            <TouchableOpacity 
              style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]} 
              onPress={() => handleSend(inputText)}
              disabled={!inputText.trim()}
            >
              <FontAwesome5 name="paper-plane" size={18} color="#FFF" />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* Add Custom Quick Reply Modal */}
      <Modal visible={isModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Balasan Favorit Baru</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Misal: Kakak sedang di jalan..."
              value={newReplyText}
              onChangeText={setNewReplyText}
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalBtnCancel} onPress={() => setModalVisible(false)}>
                <Text style={styles.modalBtnCancelText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalBtnSave} onPress={handleSaveQuickReply}>
                <Text style={styles.modalBtnSaveText}>Simpan</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    paddingBottom: 60, // Padding for Tab Bar
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 20,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFF',
  },
  flex1: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    paddingBottom: 24,
  },
  messageBubbleWrapper: {
    marginBottom: 12,
    flexDirection: 'row',
  },
  wrapperLeft: {
    justifyContent: 'flex-start',
  },
  wrapperRight: {
    justifyContent: 'flex-end',
  },
  messageBubble: {
    maxWidth: '75%',
    padding: 12,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  bubbleChild: {
    backgroundColor: '#E0F2FE', // Soft pastel blue
    borderBottomLeftRadius: 4,
  },
  bubbleParent: {
    backgroundColor: '#11427B', // Navy Blue
    borderBottomRightRadius: 4,
  },
  messageText: {
    fontSize: 16,
    marginBottom: 4,
  },
  textChild: {
    color: '#0F172A',
  },
  textParent: {
    color: '#FFFFFF',
  },
  timestamp: {
    fontSize: 10,
    alignSelf: 'flex-end',
  },
  timeChild: {
    color: '#64748B',
  },
  timeParent: {
    color: '#93C5FD',
  },
  inputSection: {
    backgroundColor: '#FFF',
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    paddingTop: 12,
    paddingBottom: 16,
  },
  quickReplyScroll: {
    maxHeight: 40,
    marginBottom: 12,
  },
  quickReplyContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  quickReplyPill: {
    backgroundColor: '#F1F5F9',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
  },
  addPill: {
    backgroundColor: '#E0F2FE',
    borderColor: '#BAE6FD',
  },
  quickReplyText: {
    color: '#334155',
    fontSize: 14,
  },
  inputRow: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#F1F5F9',
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 12,
    fontSize: 16,
    color: '#0F172A',
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: '#11427B',
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 12,
  },
  sendButtonDisabled: {
    backgroundColor: '#94A3B8',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#FFF',
    width: '85%',
    borderRadius: 20,
    padding: 24,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#11427B',
    marginBottom: 16,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    marginBottom: 20,
    backgroundColor: '#F8FAFC',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
  },
  modalBtnCancel: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  modalBtnCancelText: {
    color: '#64748B',
    fontWeight: 'bold',
    fontSize: 16,
  },
  modalBtnSave: {
    backgroundColor: '#00B5B8',
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 12,
  },
  modalBtnSaveText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 16,
  }
});
