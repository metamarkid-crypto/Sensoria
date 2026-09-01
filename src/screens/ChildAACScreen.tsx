import React, { useEffect, useState, useCallback } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, TouchableOpacity, ScrollView, Modal, TextInput, KeyboardAvoidingView, Platform, Image } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { useAACStore, AACWord } from '../store/useAACStore';
import { initDB, getAllWords, addCustomWord, updateWord } from '../services/db/sqlite';
import { tagImageWithBilingualNames } from '../services/ai/gemini';
import { logger } from '../utils/logger';
import Toast from 'react-native-toast-message';
import AACGrid from '../components/sensory/AACGrid';
import SentenceStrip from '../components/sensory/SentenceStrip';
import * as Speech from 'expo-speech';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { playTTS, clearAudioCache } from '../services/ai/audioManager';
import SettingsScreen from './SettingsScreen';
import { supabase, sendAACMessage, subscribeToAACMessages } from '../services/db/supabase';
import { FontAwesome5 } from '@expo/vector-icons';

export default function ChildAACScreen() {
  const navigation = useNavigation<any>();
  const { 
    currentSentence, clearSentence, addToSentence, setRole, 
    language, childProfile, pairingCode, deviceId, 
    setSpeechRate,
    cardSize, cardSpacing, speakOnTap
  } = useAACStore();
  const [words, setWords] = useState<AACWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [showPairing, setShowPairing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [linkedParents, setLinkedParents] = useState<any[]>([]);
  const insets = useSafeAreaInsets();
  
  // Word Options State
  const [selectedWord, setSelectedWord] = useState<AACWord | null>(null);
  const [showWordOptions, setShowWordOptions] = useState(false);
  const [showEditName, setShowEditName] = useState(false);
  const [editNameId, setEditNameId] = useState('');
  const [editNameZh, setEditNameZh] = useState('');

  useEffect(() => {
    loadDatabase();
    setupLocation();
    
    // Greet the child on first load!
    if (childProfile?.nickname) {
      setTimeout(() => {
        playTTS(`Halo ${childProfile.nickname}!`, language, 'Child');
      }, 1000);
    }

    // 1. CATCH-UP SYNC: Fetch latest settings from cloud on mount
    const catchUpSync = async () => {
      if (!deviceId) return;
      try {
        const { data, error } = await supabase
          .from('child_profiles')
          .select('settings')
          .eq('device_id', deviceId)
          .single();
          
        if (!error && data?.settings) {
          useAACStore.setState(data.settings);
        }
      } catch (err) {
        console.warn('Catch-up Sync failed (Offline Mode Active):', err);
        logger.logError('Catch-up Sync Failed', err);
      }
    };
    catchUpSync();

    if (!pairingCode) return;
    
    logger.setUserContext('Child', pairingCode);

    const channel = subscribeToAACMessages(pairingCode, (payload: any) => {
      if (payload.sender === 'Parent') {
        const senderName = payload.senderName || 'Parent';
        playTTS(payload.text, language, senderName);
        Toast.show({ type: 'info', text1: '👩‍👦 Pesan dari Orang Tua', text2: payload.text, position: 'top', visibilityTime: 4000 });
      }
    });

    const settingsChannel = supabase.channel('child-settings-update')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'child_profiles', filter: `device_id=eq.${deviceId}` },
        (payload: any) => {
          if (payload.new && payload.new.settings) {
            useAACStore.setState(payload.new.settings);
          }
        }
      )
      .subscribe();

    const familyLinksChannel = supabase.channel('child_family_links')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'family_links', filter: `child_device_id=eq.${deviceId}` },
        (payload) => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Toast.show({ 
            type: 'success', 
            text1: 'Perangkat Tertaut! 🎉', 
            text2: `Sensoria Orang Tua berhasil terhubung.`, 
            position: 'top',
            visibilityTime: 4000
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(settingsChannel);
      supabase.removeChannel(familyLinksChannel);
    };
  }, []);

  const setupLocation = async () => {
    let { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      let loc = await Location.getCurrentPositionAsync({});
      setLocation(loc);
      
      // The Pusher: Reverse Geocode once and update Supabase
      if (deviceId) {
        let addressStr = 'Lokasi tidak diketahui';
        try {
          const geocode = await Location.reverseGeocodeAsync({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude
          });
          if (geocode && geocode.length > 0) {
            addressStr = `${geocode[0].street || geocode[0].name}, ${geocode[0].city || geocode[0].region}`;
          }
        } catch (e) {}

        await supabase
          .from('devices')
          .update({ 
            latitude: loc.coords.latitude, 
            longitude: loc.coords.longitude,
            last_address: addressStr, // Push raw address string directly to DB
            last_seen: new Date().toISOString()
          })
          .eq('id', deviceId);
      }
    }
  };

  const loadDatabase = async () => {
    setLoading(true);
    await initDB();
    const data = await getAllWords();
    setWords(data);
    setLoading(false);
  };

  const handleCardPress = useCallback((word: AACWord) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const wordText = language === 'id' ? word.word_id : word.word_zh;
    
    if (speakOnTap) {
      playTTS(wordText, language, 'Child');
    }
    
    addToSentence(word);
  }, [language, speakOnTap, addToSentence]);

  const handleSpeakAll = () => {
    if (currentSentence.length === 0) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const fullText = currentSentence.map(w => language === 'id' ? w.word_id : w.word_zh).join(' ');
    playTTS(fullText, language, 'Child');
  };

  const handleSendToParent = async () => {
    if (currentSentence.length === 0) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    handleSpeakAll();
    
    // Clear sentence immediately for better UX
    const sentenceToWrap = [...currentSentence];
    clearSentence();
    
    let loc = location;
    try {
      // Safety Critical: 3-second strict timeout for GPS fetch
      const locationPromise = Location.getCurrentPositionAsync({});
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('GPS Timeout')), 3000)
      );
      
      loc = await Promise.race([locationPromise, timeoutPromise]);
      setLocation(loc);
    } catch(e) {
      console.warn("GPS fetch failed or timed out. Force sending message.");
      // loc remains as the last known location, or null. We don't block.
    }
    
    const fullText = sentenceToWrap.map(w => language === 'id' ? w.word_id : w.word_zh).join(' ');
    
    if (pairingCode) {
      await sendAACMessage(pairingCode, {
        sender: 'Child',
        senderName: childProfile?.nickname || 'Anak',
        text: fullText,
        timestamp: Date.now(),
        location: loc ? { latitude: loc.coords.latitude, longitude: loc.coords.longitude } : null
      });
      Toast.show({ type: 'success', text1: 'Terkirim', text2: 'Pesan terkirim ke Orang Tua', position: 'top' });
    } else {
      Toast.show({ type: 'error', text1: 'Gagal', text2: 'Belum tersambung ke perangkat orang tua.', position: 'top' });
    }
  };

  const handleAddCustomWord = async () => {
    let result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });

    if (!result.canceled && result.assets[0]) {
      setIsProcessingAI(true);
      try {
        const imageUri = result.assets[0].uri;
        const tags = await tagImageWithBilingualNames(imageUri);
        const newWord: AACWord = {
          id: Date.now().toString(),
          word_id: tags.id,
          word_zh: tags.zh,
          imageUrl: imageUri,
          categoryId: 'custom',
          isCustom: true
        };
        await addCustomWord(newWord);
        await loadDatabase(); 
        Toast.show({ type: 'success', text1: 'Berhasil', text2: `AI mengenali benda ini sebagai "${tags.id}" / "${tags.zh}"`, position: 'top' });
      } catch (e: any) {
        logger.logError('Failed to process image with AI', e);
        Toast.show({ type: 'error', text1: 'Error', text2: 'Gagal memproses gambar dengan AI.', position: 'top' });
      } finally {
        setIsProcessingAI(false);
      }
    }
  };

  const handleWordLongPress = useCallback((word: AACWord) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setSelectedWord(word);
    setShowWordOptions(true);
  }, []);

  const handleUpdateVoice = async () => {
    if (!selectedWord) return;
    setShowWordOptions(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const wordText = language === 'id' ? selectedWord.word_id : selectedWord.word_zh;
    await clearAudioCache(wordText, language, 'Child');
    playTTS(wordText, language, 'Child');
    Toast.show({ type: 'info', text1: 'Suara Diperbarui', text2: 'Sedang mengambil suara baru dari AI...', position: 'top' });
  };

  const handleToggleFavorite = async () => {
    if (!selectedWord) return;
    setShowWordOptions(false);
    await updateWord(selectedWord.id, { categoryId: 'favorit' });
    await loadDatabase();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleChangeImage = async () => {
    if (!selectedWord) return;
    setShowWordOptions(false);
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });

    if (!result.canceled && result.assets[0]) {
      await updateWord(selectedWord.id, { imageUrl: result.assets[0].uri });
      await loadDatabase();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const handleOpenEditName = () => {
    if (!selectedWord) return;
    setEditNameId(selectedWord.word_id);
    setEditNameZh(selectedWord.word_zh);
    setShowWordOptions(false);
    setShowEditName(true);
  };

  const handleSaveEditName = async () => {
    if (!selectedWord) return;
    if (!editNameId.trim() || !editNameZh.trim()) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Nama tidak boleh kosong', position: 'top' });
      return;
    }
    
    await clearAudioCache(selectedWord.word_id, 'id', 'Child');
    await clearAudioCache(selectedWord.word_zh, 'zh', 'Child');
    
    await updateWord(selectedWord.id, { word_id: editNameId.trim(), word_zh: editNameZh.trim() });
    await loadDatabase();
    
    setShowEditName(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  if (loading || isProcessingAI) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#00B5B8" />
        {isProcessingAI && <Text style={{marginTop: 10, color: '#11427B'}}>AI Sedang Menganalisis Gambar...</Text>}
      </View>
    );
  }

  const filteredWords = activeCategory === 'all' 
    ? words 
    : words.filter(w => w.categoryId === activeCategory);

  const categoriesConfig = [
    { id: 'all', label: 'Semua', icon: 'shapes', color: '#00B5B8', rgba: '0, 181, 184' },
    { id: 'favorit', label: 'Favorit', icon: 'star', color: '#FFD700', rgba: '255, 215, 0' },
    { id: 'pronoun', label: 'Orang', icon: 'user', color: '#FFB6C1', rgba: '255, 182, 193' },
    { id: 'verb', label: 'Aksi', icon: 'running', color: '#BBF7D0', rgba: '187, 247, 208' },
    { id: 'noun', label: 'Benda', icon: 'apple-alt', color: '#BFDBFE', rgba: '191, 219, 254' },
    { id: 'emotion', label: 'Sifat', icon: 'smile', color: '#FDE68A', rgba: '253, 230, 138' },
    { id: 'social', label: 'Sosial', icon: 'hands-helping', color: '#DDD6FE', rgba: '221, 214, 254' },
  ];

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.avatarMini}>
            {childProfile?.gender === 'Girl' ? (
              <Text style={{ fontSize: 16 }}>👧🏻</Text>
            ) : (
              <Text style={{ fontSize: 16 }}>👦🏻</Text>
            )}
          </View>
          <Text style={styles.title}>Hai, {childProfile?.nickname || 'Sensoria'}!</Text>
        </View>
        
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.iconButton} onPress={handleAddCustomWord}>
            <FontAwesome5 name="camera" size={20} color="#00B5B8" />
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.iconButton} 
            onPress={() => {
              Toast.show({
                type: 'info',
                text1: 'Akses Terkunci',
                text2: 'Tahan 3 detik untuk membuka Pengaturan',
                position: 'top',
                visibilityTime: 2000,
              });
            }}
            onLongPress={() => navigation.navigate('Settings')}
          >
            <FontAwesome5 name="cog" size={20} color="#94A3B8" />
          </TouchableOpacity>
        </View>
      </View>
      {/* Sentence Strip & Actions */}
      <View style={styles.topActionsContainer}>
        <SentenceStrip />
        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.actionBtnRed} onPress={clearSentence}>
            <Text style={styles.actionBtnText}>🗑️ Hapus</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtnBlue} onPress={handleSpeakAll}>
            <Text style={styles.actionBtnText}>🔊 Bicara</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtnOrange} onPress={handleSendToParent}>
            <Text style={styles.actionBtnText}>🚀 Kirim</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Grid */}
      <View style={styles.gridContainer}>
        <AACGrid words={filteredWords} onWordPress={handleCardPress} onWordLongPress={handleWordLongPress} />
      </View>

      {/* Word Options Modal */}
      <Modal visible={showWordOptions} transparent animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowWordOptions(false)}>
          <View style={styles.optionsModal}>
            <Text style={styles.optionsTitle}>Pengaturan Kata</Text>
            <TouchableOpacity style={styles.optionBtn} onPress={handleUpdateVoice}>
              <Text style={styles.optionEmoji}>🔊</Text>
              <Text style={styles.optionText}>Ubah / Segarkan Suara</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optionBtn} onPress={handleOpenEditName}>
              <Text style={styles.optionEmoji}>✏️</Text>
              <Text style={styles.optionText}>Ubah Nama</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optionBtn} onPress={handleChangeImage}>
              <Text style={styles.optionEmoji}>🖼️</Text>
              <Text style={styles.optionText}>Ubah Gambar</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optionBtn} onPress={handleToggleFavorite}>
              <Text style={styles.optionEmoji}>⭐</Text>
              <Text style={styles.optionText}>Jadikan Favorit</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Edit Name Modal */}
      <Modal visible={showEditName} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.editNameModal}>
            <Text style={styles.optionsTitle}>Ubah Nama Kata</Text>
            <Text style={styles.editLabel}>Bahasa Indonesia:</Text>
            <TextInput 
              style={styles.editInput} 
              value={editNameId} 
              onChangeText={setEditNameId} 
            />
            <Text style={styles.editLabel}>Mandarin:</Text>
            <TextInput 
              style={styles.editInput} 
              value={editNameZh} 
              onChangeText={setEditNameZh} 
            />
            <View style={styles.editActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowEditName(false)}>
                <Text style={styles.cancelBtnText}>Batal</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSaveEditName}>
                <Text style={styles.saveBtnText}>Simpan</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Category Tab Bar (Motor Planning Standard) */}
      <View style={styles.categoryBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryScroll}>
          {categoriesConfig.map((cat) => {
            const isActive = activeCategory === cat.id;
            return (
              <TouchableOpacity 
                key={cat.id} 
                style={[styles.catBtn, isActive && styles.catBtnActive]} 
                onPress={() => setActiveCategory(cat.id)}
              >
                {isActive && (
                  <LinearGradient
                    colors={[`rgba(${cat.rgba}, 0)`, `rgba(${cat.rgba}, 0.5)`]}
                    style={styles.activeHighlight}
                  />
                )}
                <FontAwesome5 name={cat.icon} size={22} color="#FFF" solid style={{ marginBottom: 6 }} />
                <Text style={[styles.catText, isActive && { fontWeight: '900' }]}>{cat.label}</Text>
                {isActive && <View style={[styles.activeIndicator, { backgroundColor: cat.color }]} />}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F0F8FF' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F0F8FF' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' },
  header: { 
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16, 
    paddingVertical: 12,
    backgroundColor: '#FFF',
    borderBottomWidth: 1, 
    borderBottomColor: '#E2E8F0',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarMini: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  title: { fontSize: 18, fontWeight: '900', color: '#11427B' },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  gridContainer: {
    flex: 1,
    padding: 10,
    backgroundColor: '#F8FAFC',
  },
  topActionsContainer: {
    backgroundColor: '#F8FAFC',
    borderBottomWidth: 1,
    borderColor: '#E2E8F0',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: 10,
    backgroundColor: '#FFF',
    borderTopWidth: 1,
    borderColor: '#E2E8F0',
  },
  actionBtnRed: { backgroundColor: '#FF6B6B', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, flex: 1, marginHorizontal: 4, alignItems: 'center' },
  actionBtnBlue: { backgroundColor: '#00B5B8', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, flex: 1, marginHorizontal: 4, alignItems: 'center' },
  actionBtnOrange: { backgroundColor: '#FF9800', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, flex: 1, marginHorizontal: 4, alignItems: 'center' },
  actionBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  
  categoryBar: {
    backgroundColor: '#11427B',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    elevation: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  categoryScroll: {
    paddingHorizontal: 8,
  },
  catBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 70,
    paddingVertical: 14,
    opacity: 0.6,
  },
  catBtnActive: {
    opacity: 1,
  },
  activeHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  activeIndicator: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  catText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },
  
  optionsModal: { backgroundColor: '#FFF', padding: 20, borderRadius: 24, width: '80%', alignSelf: 'center', elevation: 10, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10 },
  optionsTitle: { fontSize: 20, fontWeight: '900', color: '#11427B', textAlign: 'center', marginBottom: 20 },
  optionBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  optionEmoji: { fontSize: 24, marginRight: 16 },
  optionText: { fontSize: 16, fontWeight: 'bold', color: '#334155' },

  editNameModal: { backgroundColor: '#FFF', padding: 24, borderRadius: 24, width: '85%', alignSelf: 'center' },
  editLabel: { fontSize: 14, fontWeight: 'bold', color: '#64748B', marginBottom: 8, marginTop: 12 },
  editInput: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 12, padding: 12, fontSize: 16, color: '#0F172A' },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 24, gap: 12 },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 20 },
  cancelBtnText: { color: '#94A3B8', fontWeight: 'bold', fontSize: 16 },
  saveBtn: { backgroundColor: '#00B5B8', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12 },
  saveBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 }
});
