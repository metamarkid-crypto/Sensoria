import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import { supabase } from '../services/db/supabase';
import { logger } from '../utils/logger';
import { useAACStore, resolveChildDeviceId } from '../store/useAACStore';
import { queueCloudOp } from '../services/db/sqlite';
import { useTranslation } from '../i18n';

export default function UserProfileScreen() {
  const navigation = useNavigation<any>();
  const { t } = useTranslation();
  const { childProfile, setChildProfile } = useAACStore();
  const role = useAACStore((state) => state.role);
  const deviceId = useAACStore((state) => state.deviceId);

  const [fullName, setFullName] = useState('');
  const [nickname, setNickname] = useState('');
  const [gender, setGender] = useState<'Boy' | 'Girl'>('Boy');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (childProfile) {
      setFullName(childProfile.full_name || childProfile.fullName || '');
      setNickname(childProfile.nickname || '');
      // SAFEGUARD 3: Ensure we strictly read the JSONB payload
      setGender(childProfile.gender ?? 'Boy');
    }
  }, [childProfile]);

  const handleSave = async () => {
    if (!fullName.trim() || !nickname.trim()) {
      Toast.show({ type: 'error', text1: t('profile.toastIncomplete'), text2: t('profile.toastIncompleteDesc') });
      return;
    }

    setIsSaving(true);
    try {
      // childProfile.device_id is the canonical target, but profiles written
      // by Onboarding / recovery historically carried NO device id — the old
      // strict check turned that into a hard 'Device ID tidak ditemukan'
      // failure on every save. Resolve flexibly instead: on the CHILD device
      // the store's own deviceId is always a valid fallback, and a plain
      // upsert (not update) heals a missing remote row in the same write.
      const targetDeviceId = resolveChildDeviceId(childProfile, deviceId, role);
      if (!targetDeviceId) throw new Error(t('profile.deviceIdMissing'));

      // SAFEGUARD 3: Strict Gender Payload
      const updatedSettings = { ...(childProfile?.settings || {}), childProfileGender: gender };
      // childVoiceGender is no longer needed

      // Upsert = UPDATE on conflict: heals a wiped/missing child_profiles row
      // (this is also the first write that backfills childProfile.device_id).
      const profilePayload = {
        device_id: targetDeviceId,
        full_name: fullName,
        nickname: nickname,
        settings: updatedSettings
      };
      const { error } = await supabase
        .from('child_profiles')
        .upsert(profilePayload);

      // Update Zustand FIRST and unconditionally — the local store is the
      // source of truth for this device (offline-first). The failed-cloud
      // path below queues a replay; UI must reflect the user's edit either way.
      setChildProfile({
        ...childProfile,
        device_id: targetDeviceId,
        full_name: fullName,
        fullName: fullName,
        nickname: nickname,
        gender: gender,
        settings: updatedSettings
      });

      if (error) {
        // Offline-first: the profile edit is REAL user data — queue for replay
        // and tell the user it landed locally, syncing later (NOT an error).
        await queueCloudOp('child_profiles.upsert', profilePayload);
        Toast.show({
          type: 'success',
          text1: t('profile.toastSaved'),
          text2: t('profile.toastSavedOfflineDesc'),
          position: 'top'
        });
      } else {
        Toast.show({
          type: 'success',
          text1: t('profile.toastSaved'),
          text2: t('profile.toastSavedDesc'),
          position: 'top'
        });
      }
      
      setTimeout(() => navigation.goBack(), 1000);
      
    } catch (err: any) {
      logger.logError('Failed to save User Profile', err);
      Toast.show({
        type: 'error',
        text1: t('profile.toastFailed'),
        text2: err.message || t('profile.toastSystemError'),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#1A2980" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('profile.title')}</Text>
        <TouchableOpacity style={styles.saveButton} onPress={handleSave} disabled={isSaving}>
          {isSaving ? <ActivityIndicator size="small" color="#2488FF" /> : <Text style={styles.saveButtonText}>{t('common.save')}</Text>}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        style={{ flex: 1 }}
      >
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
          {/* Avatar Placeholder */}
          <View style={styles.avatarContainer}>
            <View style={styles.avatarPlaceholder}>
              <Ionicons name={gender === 'Boy' ? 'person' : 'person-outline'} size={50} color="#94A3B8" />
              <TouchableOpacity style={styles.editAvatarBtn}>
                <Ionicons name="camera" size={16} color="#FFF" />
              </TouchableOpacity>
            </View>
            <Text style={styles.avatarLabel}>{t('profile.changePhoto')}</Text>
          </View>

          {/* Form Fields */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>{t('profile.fullName')}</Text>
            <View style={styles.inputContainer}>
              <Ionicons name="person-outline" size={20} color="#94A3B8" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={fullName}
                onChangeText={setFullName}
                placeholder={t('profile.fullNamePlaceholder')}
                placeholderTextColor="#94A3B8"
              />
            </View>
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>{t('profile.nickname')}</Text>
            <View style={styles.inputContainer}>
              <Ionicons name="happy-outline" size={20} color="#94A3B8" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                value={nickname}
                onChangeText={setNickname}
                placeholder={t('profile.nicknamePlaceholder')}
                placeholderTextColor="#94A3B8"
              />
            </View>
          </View>

          {/* Gender Toggle */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>{t('profile.gender')}</Text>
            <View style={styles.genderRow}>
              <TouchableOpacity 
                style={[styles.genderCard, gender === 'Boy' && styles.genderCardActive]}
                onPress={() => setGender('Boy')}
              >
                <Text style={{ fontSize: 32, marginBottom: 8 }}>👦🏻</Text>
                <Text style={[styles.genderText, gender === 'Boy' && styles.genderTextActive]}>{t('profile.boy')}</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.genderCard, gender === 'Girl' && styles.genderCardActiveFemale]}
                onPress={() => setGender('Girl')}
              >
                <Text style={{ fontSize: 32, marginBottom: 8 }}>👧🏻</Text>
                <Text style={[styles.genderText, gender === 'Girl' && styles.genderTextActiveFemale]}>{t('profile.girl')}</Text>
              </TouchableOpacity>
            </View>
          </View>

        </ScrollView>
      </KeyboardAvoidingView>
      <Toast />
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
    justifyContent: 'center', // Center the title
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    position: 'relative',
  },
  backButton: {
    position: 'absolute',
    left: 16,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'flex-start',
    zIndex: 10,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1A2980',
  },
  saveButton: {
    position: 'absolute',
    right: 16,
    height: 40,
    justifyContent: 'center',
    alignItems: 'flex-end',
    zIndex: 10,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2488FF',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 24,
  },
  avatarContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    position: 'relative',
  },
  avatarEmoji: {
    fontSize: 50,
  },
  editAvatarBtn: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#1A2980',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  avatarLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#2488FF',
  },
  formGroup: {
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#64748B',
    marginBottom: 8,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 16,
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    paddingVertical: 16,
    fontSize: 16,
    color: '#334155',
    fontWeight: '600',
  },
  genderRow: {
    flexDirection: 'row',
    gap: 16,
  },
  genderCard: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  genderCardActive: {
    borderColor: '#2488FF',
    backgroundColor: '#F0F8FF',
  },
  genderCardActiveFemale: {
    borderColor: '#FF2A7A',
    backgroundColor: '#FFF0F5',
  },
  genderText: {
    marginTop: 12,
    fontSize: 14,
    fontWeight: 'bold',
    color: '#94A3B8',
  },
  genderTextActive: {
    color: '#2488FF',
  },
  genderTextActiveFemale: {
    color: '#FF2A7A',
  }
});
