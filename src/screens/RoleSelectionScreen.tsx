import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Image, TextInput, KeyboardAvoidingView, Platform, ImageBackground, ActivityIndicator } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAACStore, UserRole } from '../store/useAACStore';
import { queueCloudOp } from '../services/db/sqlite';
import * as Haptics from 'expo-haptics';
import { supabase } from '../services/db/supabase';
import { ensureTrialSubscription } from '../services/db/subscriptions';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import Toast from 'react-native-toast-message';
import { useTranslation } from '../i18n';
import LanguagePickerModal from '../components/i18n/LanguagePickerModal';
import { buildChildProfileFromRow } from '../utils/childProfileHelpers';

export default function RoleSelectionScreen() {
  const { t } = useTranslation();
  const setRole = useAACStore((state) => state.setRole);
  const deviceId = useAACStore((state) => state.deviceId);
  const setDeviceId = useAACStore((state) => state.setDeviceId);
  const setPairingCode = useAACStore((state) => state.setPairingCode);
  const setChildProfile = useAACStore((state) => state.setChildProfile);
  
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [loadingRole, setLoadingRole] = useState<UserRole | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);
  const [showLanguageModal, setShowLanguageModal] = useState(false);

  // Helper UUID for Secure Store initial generation
  const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  };

  const getOrGenerateDeviceId = async () => {
    try {
      let storedId = await SecureStore.getItemAsync('SENSORIA_DEVICE_ID');
      if (!storedId) {
        storedId = generateUUID();
        await SecureStore.setItemAsync('SENSORIA_DEVICE_ID', storedId);
      }
      return storedId;
    } catch (error) {
      console.warn('SecureStore error, fallback to random UUID', error);
      return generateUUID();
    }
  };

  const handleSelectRole = async (role: UserRole) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setLoadingRole(role);

    try {
      let currentDeviceId = deviceId;
      if (!currentDeviceId) {
        currentDeviceId = await getOrGenerateDeviceId();
        setDeviceId(currentDeviceId);
      }

      // Generate 6-digit pairing code for Child
      let pairingCode = null;
      if (role === 'Child') {
        pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
        setPairingCode(pairingCode);
      }

      // Register to Supabase — offline-first: queue for replay on failure.
      // Without the row the child never gets its trial injection, parent-slot
      // capacity or pairing-code lookup, so this is REAL setup data.
      const devicePayload = {
        id: currentDeviceId,
        role: role,
        pairing_code: pairingCode
      };
      const { error: regError } = await supabase.from('devices').upsert(devicePayload);
      if (regError) {
        await queueCloudOp('devices.upsert', devicePayload);
      }

      // Blueprint: inject the premium free trial right after a successful setup.
      // Child only — subscriptions are keyed by child_device_id and cover linked
      // Parents via the Combo rule. Idempotent + non-fatal: a billing hiccup must
      // never block onboarding, and an existing subscription is never overwritten.
      if (role === 'Child') {
        try {
          await ensureTrialSubscription(currentDeviceId);
        } catch (trialError) {
          console.warn('Trial injection skipped (non-fatal):', trialError);
        }
      }

      setRole(role);
    } catch (e) {
      console.error('Error registering device:', e);
      // Fallback: still let them in even if offline
      setRole(role);
    } finally {
      setLoadingRole(null);
    }
  };

  const handleRecoverProfile = async () => {
    if (!recoveryCode || recoveryCode.length !== 6) {
      Toast.show({ type: 'error', text1: t('common.failed'), text2: t('role.recoveryInvalidCode'), position: 'top' });
      return;
    }
    
    setIsRecovering(true);
    try {
      // Find the device with this pairing code
      const { data: devices, error: deviceError } = await supabase
        .from('devices')
        .select('id')
        .eq('pairing_code', recoveryCode)
        .eq('role', 'Child')
        .single();
        
      if (deviceError || !devices) {
        Toast.show({ type: 'error', text1: t('common.failed'), text2: t('role.recoveryCodeNotFound'), position: 'top' });
        return;
      }

      const recoveredId = devices.id;

      // Fetch the child profile
      const { data: profile, error: profileError } = await supabase
        .from('child_profiles')
        .select('*')
        .eq('device_id', recoveredId)
        .single();
        
      if (!profileError && profile) {
        // We found it! Set Secure Store to the recovered ID
        await SecureStore.setItemAsync('SENSORIA_DEVICE_ID', recoveredId);
        setDeviceId(recoveredId);
        setPairingCode(recoveryCode);
        const normalizedProfile = buildChildProfileFromRow(profile, null, recoveredId);
        setChildProfile(normalizedProfile);
        
        // Load remote settings to Zustand via whitelisted patch + default voice fallback
        if (profile.settings) {
          useAACStore.getState().applySettingsPatch(profile.settings);
          if (!profile.settings.selectedVoice) {
            useAACStore.getState().setSelectedVoice(
              normalizedProfile.gender === 'Girl' ? 'id-female-1' : 'id-male-1',
            );
          }
        } else {
          useAACStore.getState().setSelectedVoice(
            normalizedProfile.gender === 'Girl' ? 'id-female-1' : 'id-male-1',
          );
        }
        
        Toast.show({ type: 'success', text1: t('common.success'), text2: t('role.recoverySuccess'), position: 'top' });
        setShowRecovery(false);
        setRole('Child');
      } else {
         Toast.show({ type: 'error', text1: t('common.failed'), text2: t('role.recoveryProfileMissing'), position: 'top' });
      }
    } catch (err) {
      Toast.show({ type: 'error', text1: t('common.error'), text2: t('role.recoveryFailed'), position: 'top' });
    } finally {
      setIsRecovering(false);
    }
  };

  return (
    <ImageBackground source={require('../../assets/bg-peran.webp')} style={styles.bgContainer} resizeMode="cover">
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.contentWrapper}>
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.settingsBtn} onPress={() => setShowLanguageModal(true)}>
              <FontAwesome5 name="globe" size={24} color="#64748B" />
            </TouchableOpacity>
          </View>

          <View style={styles.headerSection}>
            <Image source={require('../../assets/sensoria.png')} style={styles.logo} resizeMode="contain" />
            <Text style={styles.descText}>
              {t('role.descStart')}<Text style={{color: '#00B5B8', fontWeight: 'bold'}}>{t('role.descAutism')}</Text>{t('role.descMid')}
              <Text style={{color: '#FF2A7A', fontWeight: 'bold'}}>{t('role.descSpeech')}</Text>{t('role.descEnd')}<Text style={{color: '#9C27B0', fontWeight: 'bold'}}>{t('role.descNonverbal')}</Text>{t('role.descDot')}
            </Text>

            <View style={styles.featuresBadge}>
              <View style={styles.featureItem}>
                <View style={[styles.featureIconBox, { backgroundColor: '#EBF4FF' }]}>
                  <FontAwesome5 name="smile" size={14} color="#2488FF" solid />
                </View>
                <Text style={styles.featureText}>{t('role.f1')}</Text>
              </View>
              <View style={styles.featureItem}>
                <View style={[styles.featureIconBox, { backgroundColor: '#FFF0F5' }]}>
                  <FontAwesome5 name="heart" size={14} color="#FF2A7A" solid />
                </View>
                <Text style={styles.featureText}><Text style={{color: '#FF2A7A'}}>{t('role.f2a')}</Text>{t('role.f2b')}</Text>
              </View>
              <View style={styles.featureItem}>
                <View style={[styles.featureIconBox, { backgroundColor: '#F0FDF4' }]}>
                  <FontAwesome5 name="brain" size={14} color="#4CAF50" solid />
                </View>
                <Text style={styles.featureText}><Text style={{color: '#4CAF50'}}>{t('role.f3a')}</Text>{t('role.f3b')}</Text>
              </View>
              <View style={styles.featureItem}>
                <View style={[styles.featureIconBox, { backgroundColor: '#F5F3FF' }]}>
                  <FontAwesome5 name="users" size={14} color="#9C27B0" solid />
                </View>
                <Text style={styles.featureText}>{t('role.f4')}</Text>
              </View>
            </View>
          </View>

          <View style={styles.titleSection}>
            <Text style={styles.titleText}>{t('role.title')}</Text>
            <Text style={styles.subtitleText}>{t('role.subtitle')}</Text>
          </View>

          <View style={styles.buttonSection}>
            <TouchableOpacity onPress={() => handleSelectRole('Child')} activeOpacity={0.9} style={styles.roleBtn} disabled={loadingRole !== null}>
              <Image source={require('../../assets/mode-anak.webp')} style={styles.roleImage} resizeMode="contain" />
              {loadingRole === 'Child' && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,255,255,0.6)', justifyContent: 'center', alignItems: 'center', borderRadius: 24 }]}>
                  <ActivityIndicator size="large" color="#00B5B8" />
                </View>
              )}
            </TouchableOpacity>

            <TouchableOpacity onPress={() => handleSelectRole('Parent')} activeOpacity={0.9} style={styles.roleBtn} disabled={loadingRole !== null}>
              <Image source={require('../../assets/mode-orangtua.webp')} style={styles.roleImage} resizeMode="contain" />
              {loadingRole === 'Parent' && (
                <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,255,255,0.6)', justifyContent: 'center', alignItems: 'center', borderRadius: 24 }]}>
                  <ActivityIndicator size="large" color="#00B5B8" />
                </View>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.bottomSection}>
            <TouchableOpacity onPress={() => setShowRecovery(true)} style={styles.recoveryBtnBox} disabled={loadingRole !== null}>
              <View style={styles.recoveryIconBox}>
                <FontAwesome5 name="sync-alt" size={20} color="#FFF" />
              </View>
              <View style={styles.recoveryTextBox}>
                <Text style={styles.recoveryTitleText}>{t('role.recoverTitle')}</Text>
                <Text style={styles.recoveryDescText}>{t('role.recoverDesc')}</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      <LanguagePickerModal visible={showLanguageModal} onClose={() => setShowLanguageModal(false)} />

      <Modal visible={showRecovery} transparent animationType="slide">
        <KeyboardAvoidingView 
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        >
          <View style={styles.recoveryContainer}>
            <Text style={styles.recoveryTitle}>{t('role.recoveryTitle')}</Text>
            <Text style={styles.recoveryDesc}>{t('role.recoveryDesc')}</Text>
            <TextInput 
              style={styles.pairingInput}
              placeholder={t('role.recoveryPlaceholder')}
              value={recoveryCode}
              onChangeText={setRecoveryCode}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus={true}
            />
            <TouchableOpacity style={styles.recoverySubmit} onPress={handleRecoverProfile} disabled={isRecovering}>
              {isRecovering ? <ActivityIndicator color="#FFF" /> : <Text style={styles.recoverySubmitText}>{t('role.recoverySubmit')}</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.recoveryCancel} onPress={() => setShowRecovery(false)} disabled={isRecovering}>
              <Text style={styles.recoveryCancelText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ImageBackground>
  );
}

const styles = StyleSheet.create({
  bgContainer: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  safeArea: {
    flex: 1,
  },
  contentWrapper: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: 20,
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingTop: 10,
  },
  settingsBtn: {
    backgroundColor: '#FFF',
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  headerSection: {
    alignItems: 'center',
  },
  logo: {
    width: '80%',
    height: 90,
    marginBottom: 5,
  },
  descText: {
    textAlign: 'center',
    fontSize: 11,
    color: '#1E293B',
    lineHeight: 16,
    marginBottom: 16,
    paddingHorizontal: 10,
  },
  featuresBadge: {
    flexDirection: 'row',
    backgroundColor: '#FFF',
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 8,
    justifyContent: 'space-between',
    width: '100%',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    paddingHorizontal: 2,
  },
  featureIconBox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  featureText: {
    fontSize: 7.5,
    color: '#334155',
    fontWeight: '700',
  },
  titleSection: {
    alignItems: 'center',
  },
  titleText: {
    fontSize: 26,
    fontWeight: '900',
    color: '#11427B',
  },
  subtitleText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#94A3B8',
  },
  buttonSection: {
    alignItems: 'center',
    gap: 0,
  },
  roleBtn: {
    width: '100%',
    height: 130,
    borderRadius: 24,
    overflow: 'hidden',
    marginTop: -8,
  },
  roleImage: {
    width: '100%',
    height: '100%',
  },
  bottomSection: {
    alignItems: 'center',
    paddingTop: 10,
  },
  recoveryBtnBox: {
    flexDirection: 'row',
    backgroundColor: '#FFF',
    padding: 14,
    borderRadius: 16,
    width: '100%',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
  },
  recoveryIconBox: {
    backgroundColor: '#2488FF',
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  recoveryTextBox: {
    flex: 1,
  },
  recoveryTitleText: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#00B5B8',
    marginBottom: 2,
  },
  recoveryDescText: {
    fontSize: 11,
    color: '#64748B',
    lineHeight: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  recoveryContainer: {
    backgroundColor: '#FFF',
    padding: 24,
    borderRadius: 20,
    elevation: 5,
  },
  recoveryTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#334155',
    marginBottom: 8,
  },
  recoveryDesc: {
    color: '#64748B',
    marginBottom: 16,
  },
  pairingInput: { 
    borderWidth: 1, 
    borderColor: '#CBD5E1', 
    borderRadius: 8, 
    padding: 12, 
    fontSize: 20, 
    letterSpacing: 4,
    textAlign: 'center',
    marginBottom: 16,
  },
  recoverySubmit: {
    backgroundColor: '#00B5B8',
    padding: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  recoverySubmitText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  recoveryCancel: {
    alignItems: 'center',
    padding: 10,
  },
  recoveryCancelText: {
    color: '#FF6B6B',
    fontWeight: 'bold',
  }
});
