import React, { useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Toast from 'react-native-toast-message';
import { useAACStore } from '../store/useAACStore';
import { supabase } from '../services/db/supabase';
import { useTranslation } from '../i18n';

export default function OnboardingScreen({ navigation }: any) {
  const { t } = useTranslation();
  const [fullName, setFullName] = useState('');
  const [nickname, setNickname] = useState('');
  const [gender, setGender] = useState<'boy' | 'girl' | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const { setChildProfile, deviceId } = useAACStore();

  const handleSave = async () => {
    if (!fullName.trim() || !nickname.trim() || !gender) {
      Toast.show({ type: 'error', text1: t('onboarding.toastIncomplete'), text2: t('onboarding.toastIncompleteDesc') });
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIsSubmitting(true);

    try {
      // 1. Simpan ke local store
      setChildProfile({ fullName: fullName.trim(), nickname: nickname.trim(), gender: gender === 'boy' ? 'Boy' : 'Girl' });
      
      // 2. Simpan ke Supabase (jika sudah ada koneksi)
      if (deviceId) {
        await supabase.from('child_profiles').upsert({
          device_id: deviceId,
          full_name: fullName.trim(),
          nickname: nickname.trim(),
          settings: {
            speechRate: 1.0,
            childProfileGender: gender === 'boy' ? 'Boy' : 'Girl'
          }
        });
      }
      
      // 3. Navigasi ke ChildAAC
      navigation.replace('ChildAAC');
    } catch (error) {
      console.error('Error saving profile:', error);
      Toast.show({ type: 'error', text1: t('common.failed'), text2: t('onboarding.toastFailedDesc') });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={['#F0F8FF', '#E0FFFF']} style={StyleSheet.absoluteFill} />
      
      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        style={styles.container}
      >
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Text style={styles.title}>{t('onboarding.title')}</Text>
          <Text style={styles.subtitle}>{t('onboarding.subtitle')}</Text>

          <View style={styles.inputContainer}>
            <Text style={styles.label}>{t('onboarding.fullName')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('onboarding.fullNamePlaceholder')}
              value={fullName}
              onChangeText={setFullName}
              placeholderTextColor="#999"
            />
          </View>

          <View style={styles.inputContainer}>
            <Text style={styles.label}>{t('onboarding.nickname')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('onboarding.nicknamePlaceholder')}
              value={nickname}
              onChangeText={setNickname}
              placeholderTextColor="#999"
            />
          </View>

          <View style={styles.inputContainer}>
            <Text style={styles.label}>{t('onboarding.gender')}</Text>
            <View style={styles.genderRow}>
              <TouchableOpacity 
                style={[styles.genderBtn, gender === 'boy' && styles.genderBtnActive]} 
                onPress={() => setGender('boy')}
              >
                <Text style={styles.genderEmoji}>👦🏻</Text>
                <Text style={[styles.genderText, gender === 'boy' && styles.genderTextActive]}>{t('profile.boy')}</Text>
              </TouchableOpacity>
              
              <TouchableOpacity 
                style={[styles.genderBtn, gender === 'girl' && styles.genderBtnActive]} 
                onPress={() => setGender('girl')}
              >
                <Text style={styles.genderEmoji}>👧🏻</Text>
                <Text style={[styles.genderText, gender === 'girl' && styles.genderTextActive]}>{t('profile.girl')}</Text>
              </TouchableOpacity>
            </View>
          </View>

          <TouchableOpacity 
            style={[styles.button, (!fullName || !nickname || !gender) && styles.buttonDisabled]} 
            onPress={handleSave}
            disabled={isSubmitting || !fullName || !nickname || !gender}
          >
            <Text style={styles.buttonText}>{t('onboarding.startButton')}</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: '#11427B',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: '#444',
    marginBottom: 40,
    textAlign: 'center',
    lineHeight: 24,
  },
  inputContainer: {
    marginBottom: 24,
  },
  label: {
    fontSize: 16,
    fontWeight: '700',
    color: '#11427B',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#FFF',
    borderWidth: 1,
    borderColor: '#CCC',
    borderRadius: 12,
    padding: 16,
    fontSize: 18,
    color: '#333',
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
  },
  genderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  genderBtn: {
    flex: 1,
    backgroundColor: '#FFF',
    borderWidth: 2,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    elevation: 1,
  },
  genderBtnActive: {
    borderColor: '#00B5B8',
    backgroundColor: '#F0FDF4',
    elevation: 4,
  },
  genderEmoji: {
    fontSize: 40,
    marginBottom: 8,
  },
  genderText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#64748B',
  },
  genderTextActive: {
    color: '#00B5B8',
  },
  button: {
    backgroundColor: '#00B5B8',
    paddingVertical: 18,
    borderRadius: 30,
    alignItems: 'center',
    marginTop: 20,
    elevation: 4,
    shadowColor: '#00B5B8',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  buttonDisabled: {
    backgroundColor: '#A0D8D9',
    elevation: 0,
  },
  buttonText: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: 'bold',
  },
});
