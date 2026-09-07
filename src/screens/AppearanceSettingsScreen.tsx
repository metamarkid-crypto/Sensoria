import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Switch, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import Slider from '@react-native-community/slider';
import Toast from 'react-native-toast-message';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';
import { useTranslation } from '../i18n';

export default function AppearanceSettingsScreen() {
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { 
    childProfile, 
    cardSize, setCardSize, 
    textSize, setTextSize, 
    cardSpacing, setCardSpacing,
    enableCategoryColors, setEnableCategoryColors,
    highContrast, setHighContrast
  } = useAACStore();

  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  // Load from DB initially if needed, but Zustand already handles persistence.
  // We still ensure the DB is synced when values change.
  
  const syncToDatabase = useCallback(async (newSettings: any) => {
    if (!childProfile?.device_id) return;
    
    try {
      const mergedSettings = { ...(childProfile.settings || {}), ...newSettings };
      
      const { error } = await supabase
        .from('child_profiles')
        .update({ settings: mergedSettings })
        .eq('device_id', childProfile.device_id);
        
      if (error) throw error;
      
      // Update local childProfile context quietly
      useAACStore.setState({
        childProfile: { ...childProfile, settings: mergedSettings }
      });
      
    } catch (error) {
      console.error('Failed to sync settings', error);
    }
  }, [childProfile]);

  const debouncedSync = useCallback((newSettings: any) => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      syncToDatabase(newSettings);
    }, 800);
  }, [syncToDatabase]);

  // Handlers for optimistic updates + debounced sync
  const handleCardSize = (size: 'S' | 'M' | 'L' | 'XL') => {
    setCardSize(size);
    debouncedSync({ cardSize: size });
  };

  const handleTextSize = (size: 'A-' | 'A' | 'A+') => {
    setTextSize(size);
    debouncedSync({ textSize: size });
  };

  const handleSpacingChange = (val: number) => {
    setCardSpacing(val);
    debouncedSync({ cardSpacing: val });
  };

  const toggleCategoryColors = (val: boolean) => {
    setEnableCategoryColors(val);
    debouncedSync({ enableCategoryColors: val });
  };

  const toggleHighContrast = (val: boolean) => {
    setHighContrast(val);
    debouncedSync({ highContrast: val });
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#1A2980" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('appearance.title')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        
        {/* Ukuran Kartu */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('appearance.cardSize')}</Text>
          <View style={styles.segmentedControl}>
            {['S', 'M', 'L', 'XL'].map((size) => (
              <TouchableOpacity 
                key={size}
                style={[styles.segmentBtn, cardSize === size && styles.segmentBtnActive]}
                onPress={() => handleCardSize(size as any)}
              >
                <Text style={[styles.segmentText, cardSize === size && styles.segmentTextActive]}>{size}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Ukuran Teks */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('appearance.textSize')}</Text>
          <View style={styles.segmentedControl}>
            {['A-', 'A', 'A+'].map((size) => (
              <TouchableOpacity 
                key={size}
                style={[styles.segmentBtn, textSize === size && styles.segmentBtnActive]}
                onPress={() => handleTextSize(size as any)}
              >
                <Text style={[styles.segmentText, textSize === size && styles.segmentTextActive]}>{size}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Jarak Kartu */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('appearance.cardSpacing')}</Text>
          <Slider
            style={styles.slider}
            minimumValue={0}
            maximumValue={40}
            step={2}
            value={cardSpacing}
            onValueChange={handleSpacingChange}
            minimumTrackTintColor="#2488FF"
            maximumTrackTintColor="#E2E8F0"
            thumbTintColor="#2488FF"
          />
        </View>

        <View style={styles.divider} />

        {/* Toggles */}
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>{t('appearance.categoryColors')}</Text>
          <Switch
            value={enableCategoryColors}
            onValueChange={toggleCategoryColors}
            trackColor={{ false: '#E2E8F0', true: '#2488FF' }}
            thumbColor={'#FFFFFF'}
          />
        </View>

        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>{t('appearance.highContrast')}</Text>
          <Switch
            value={highContrast}
            onValueChange={toggleHighContrast}
            trackColor={{ false: '#E2E8F0', true: '#2488FF' }}
            thumbColor={'#FFFFFF'}
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
    marginBottom: 12,
  },
  segmentedControl: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRightWidth: 1,
    borderRightColor: '#E2E8F0',
  },
  segmentBtnActive: {
    backgroundColor: '#2488FF',
  },
  segmentText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#64748B',
  },
  segmentTextActive: {
    color: '#FFFFFF',
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
  toggleLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#334155',
  },
});
