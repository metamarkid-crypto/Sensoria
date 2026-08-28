import React, { useState, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch, ScrollView, Platform, ActionSheetIOS } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import Slider from '@react-native-community/slider';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';
import { playTTS } from '../services/ai/audioManager';

const AVAILABLE_VOICES = [
  { id: 'id-female-1', label: 'Perempuan 1 (Lembut)' },
  { id: 'id-female-2', label: 'Perempuan 2 (Ceria)' },
  { id: 'id-male-1', label: 'Laki-laki 1 (Tenang)' },
  { id: 'id-male-2', label: 'Laki-laki 2 (Tegas)' },
];

export default function VoiceSettingsScreen() {
  const navigation = useNavigation<any>();
  const { 
    childProfile, 
    language,
    selectedVoice, setSelectedVoice,
    speechRate, setSpeechRate,
    volume, setVolume,
    speakOnTap, setSpeakOnTap,
    soundFeedback, setSoundFeedback
  } = useAACStore();

  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  const syncToDatabase = useCallback(async (newSettings: any) => {
    if (!childProfile?.device_id) return;
    
    try {
      const mergedSettings = { ...(childProfile.settings || {}), ...newSettings };
      
      const { error } = await supabase
        .from('child_profiles')
        .update({ settings: mergedSettings })
        .eq('device_id', childProfile.device_id);
        
      if (error) throw error;
      
      useAACStore.setState({
        childProfile: { ...childProfile, settings: mergedSettings }
      });
      
    } catch (error) {
      console.error('Failed to sync voice settings', error);
    }
  }, [childProfile]);

  const debouncedSync = useCallback((newSettings: any) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      syncToDatabase(newSettings);
    }, 800);
  }, [syncToDatabase]);

  // Handlers
  const handleSelectVoice = () => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Batal', ...AVAILABLE_VOICES.map(v => v.label)],
          cancelButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) return;
          const voice = AVAILABLE_VOICES[buttonIndex - 1];
          setSelectedVoice(voice.id);
          debouncedSync({ selectedVoice: voice.id });
        }
      );
    } else {
      // For Android, a simple cyclic toggle or we'd build a custom modal. 
      // Keeping it simple for the MVP: cycle through options
      const currentIndex = AVAILABLE_VOICES.findIndex(v => v.id === selectedVoice);
      const nextIndex = (currentIndex + 1) % AVAILABLE_VOICES.length;
      const voice = AVAILABLE_VOICES[nextIndex];
      setSelectedVoice(voice.id);
      debouncedSync({ selectedVoice: voice.id });
    }
  };

  const handleSpeechRate = (val: number) => {
    setSpeechRate(val);
    debouncedSync({ speechRate: val });
  };

  const handleVolume = (val: number) => {
    setVolume(val);
    debouncedSync({ volume: val });
  };

  const toggleSpeakOnTap = (val: boolean) => {
    setSpeakOnTap(val);
    debouncedSync({ speakOnTap: val });
  };

  const toggleSoundFeedback = (val: boolean) => {
    setSoundFeedback(val);
    debouncedSync({ soundFeedback: val });
  };

  const handleTestVoice = () => {
    playTTS('Halo, ini suara saya.', language, 'Child');
  };

  const activeVoiceLabel = AVAILABLE_VOICES.find(v => v.id === selectedVoice)?.label || 'Pilih Suara';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#1A2980" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Suara & Bicara</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        
        {/* Pilih Suara */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Pilih Suara</Text>
          <TouchableOpacity style={styles.dropdownBtn} onPress={handleSelectVoice}>
            <View style={styles.dropdownLeft}>
              <View style={styles.avatarIconBox}>
                <Text style={{ fontSize: 20 }}>{selectedVoice.includes('female') ? '👧🏻' : '👦🏻'}</Text>
              </View>
              <Text style={styles.dropdownText}>{activeVoiceLabel}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#94A3B8" />
          </TouchableOpacity>
        </View>

        {/* Kecepatan Bicara */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Kecepatan Bicara</Text>
          <Slider
            style={styles.slider}
            minimumValue={0.5}
            maximumValue={2.0}
            step={0.1}
            value={speechRate}
            onValueChange={handleSpeechRate}
            minimumTrackTintColor="#2488FF"
            maximumTrackTintColor="#E2E8F0"
            thumbTintColor="#2488FF"
          />
          <View style={styles.sliderLabels}>
            <Text style={styles.sliderLabelText}>Lambat</Text>
            <Text style={styles.sliderLabelText}>Cepat</Text>
          </View>
        </View>

        {/* Volume */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Volume</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={1.0}
            step={0.1}
            value={volume}
            onValueChange={handleVolume}
            minimumTrackTintColor="#2488FF"
            maximumTrackTintColor="#E2E8F0"
            thumbTintColor="#2488FF"
          />
        </View>

        <View style={styles.divider} />

        {/* Toggles */}
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Baca Saat Tombol Ditekan</Text>
          <Switch
            value={speakOnTap}
            onValueChange={toggleSpeakOnTap}
            trackColor={{ false: '#E2E8F0', true: '#2488FF' }}
            thumbColor={'#FFFFFF'}
          />
        </View>

        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Bunyi Feedback</Text>
          <Switch
            value={soundFeedback}
            onValueChange={toggleSoundFeedback}
            trackColor={{ false: '#E2E8F0', true: '#2488FF' }}
            thumbColor={'#FFFFFF'}
          />
        </View>

      </ScrollView>

      {/* Test Button Footer */}
      <View style={styles.footer}>
        <TouchableOpacity style={styles.testBtn} onPress={handleTestVoice}>
          <Ionicons name="volume-medium" size={20} color="#FFFFFF" style={{ marginRight: 8 }} />
          <Text style={styles.testBtnText}>Tes Suara</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1A2980',
  },
  content: {
    padding: 20,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#64748B',
    marginBottom: 12,
  },
  dropdownBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    padding: 12,
  },
  dropdownLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarIconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  dropdownText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#334155',
  },
  slider: {
    width: '100%',
    height: 40,
  },
  sliderLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  sliderLabelText: {
    fontSize: 12,
    color: '#94A3B8',
    fontWeight: 'bold',
  },
  divider: {
    height: 1,
    backgroundColor: '#E2E8F0',
    marginVertical: 12,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
  },
  toggleLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#334155',
  },
  footer: {
    padding: 20,
    paddingBottom: Platform.OS === 'ios' ? 0 : 20,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  testBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2488FF',
    borderRadius: 16,
    paddingVertical: 16,
  },
  testBtnText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
});
