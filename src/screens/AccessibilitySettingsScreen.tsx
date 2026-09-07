import React, { useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import Slider from '@react-native-community/slider';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';
import { useTranslation } from '../i18n';

export default function AccessibilitySettingsScreen() {
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { 
    childProfile, 
    holdDuration, setHoldDuration,
    ignoreRepeat, setIgnoreRepeat,
    releaseToSpeak, setReleaseToSpeak
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
      console.error('Failed to sync accessibility settings', error);
    }
  }, [childProfile]);

  const debouncedSync = useCallback((newSettings: any) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      syncToDatabase(newSettings);
    }, 800);
  }, [syncToDatabase]);

  const handleHoldDuration = (val: number) => {
    setHoldDuration(val);
    debouncedSync({ holdDuration: val });
  };

  const toggleIgnoreRepeat = (val: boolean) => {
    setIgnoreRepeat(val);
    debouncedSync({ ignoreRepeat: val });
  };

  const toggleReleaseToSpeak = (val: boolean) => {
    setReleaseToSpeak(val);
    debouncedSync({ releaseToSpeak: val });
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#1A2980" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('accessibility.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        
        {/* Waktu Tahan */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('accessibility.holdDuration')}</Text>
          <Text style={styles.sectionDesc}>{t('accessibility.holdDurationDesc')}</Text>
          
          <View style={styles.sliderHeader}>
            <Text style={styles.sliderValueText}>
              {holdDuration > 0 ? t('accessibility.seconds', { n: holdDuration.toFixed(1) }) : t('accessibility.off')}
            </Text>
          </View>
          
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={2.0}
            step={0.5}
            value={holdDuration}
            onValueChange={handleHoldDuration}
            minimumTrackTintColor="#2488FF"
            maximumTrackTintColor="#E2E8F0"
            thumbTintColor="#2488FF"
          />
        </View>

        <View style={styles.divider} />

        {/* Toggles */}
        <View style={styles.toggleRow}>
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleLabel}>{t('accessibility.ignoreRepeat')}</Text>
            <Text style={styles.toggleDesc}>{t('accessibility.ignoreRepeatDesc')}</Text>
          </View>
          <Switch
            value={ignoreRepeat}
            onValueChange={toggleIgnoreRepeat}
            trackColor={{ false: '#E2E8F0', true: '#2488FF' }}
            thumbColor={'#FFFFFF'}
          />
        </View>

        <View style={styles.toggleRow}>
          <View style={styles.toggleTextContainer}>
            <Text style={styles.toggleLabel}>{t('accessibility.releaseToSpeak')}</Text>
            <Text style={styles.toggleDesc}>{t('accessibility.releaseToSpeakDesc')}</Text>
          </View>
          <Switch
            value={releaseToSpeak}
            onValueChange={toggleReleaseToSpeak}
            trackColor={{ false: '#E2E8F0', true: '#2488FF' }}
            thumbColor={'#FFFFFF'}
            disabled={holdDuration > 0} // Usually mutually exclusive conceptually, but handled in logic
          />
        </View>

      </ScrollView>
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
    fontSize: 16,
    fontWeight: 'bold',
    color: '#334155',
    marginBottom: 4,
  },
  sectionDesc: {
    fontSize: 13,
    color: '#64748B',
    marginBottom: 16,
  },
  sliderHeader: {
    alignItems: 'center',
    marginBottom: 12,
  },
  sliderValueText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2488FF',
  },
  slider: {
    width: '100%',
    height: 40,
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
  toggleTextContainer: {
    flex: 1,
    paddingRight: 16,
  },
  toggleLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#334155',
    marginBottom: 4,
  },
  toggleDesc: {
    fontSize: 13,
    color: '#94A3B8',
  },
});
