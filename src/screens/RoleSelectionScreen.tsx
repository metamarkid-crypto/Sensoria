import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Image, TextInput, KeyboardAvoidingView, Platform, ImageBackground, ScrollView, ActivityIndicator } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAACStore, UserRole } from '../store/useAACStore';
import * as Haptics from 'expo-haptics';
import SettingsScreen from './SettingsScreen';
import { LinearGradient } from 'expo-linear-gradient';
import { supabase } from '../services/db/supabase';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import Toast from 'react-native-toast-message';

export default function RoleSelectionScreen() {
  const setRole = useAACStore((state) => state.setRole);
  const deviceId = useAACStore((state) => state.deviceId);
  const setDeviceId = useAACStore((state) => state.setDeviceId);
  const setPairingCode = useAACStore((state) => state.setPairingCode);
  const setChildProfile = useAACStore((state) => state.setChildProfile);
  
  const [showSettings, setShowSettings] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);

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
    setIsLoading(true);

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

      // Register to Supabase
      await supabase.from('devices').upsert({
        id: currentDeviceId,
        role: role,
        pairing_code: pairingCode
      });
      
      setRole(role);
    } catch (e) {
      console.error('Error registering device:', e);
      // Fallback: still let them in even if offline
      setRole(role);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRecoverProfile = async () => {
    if (!recoveryCode || recoveryCode.length !== 6) {
      Toast.show({ type: 'error', text1: 'Gagal', text2: 'Masukkan 6 digit kode pemulihan yang valid.', position: 'top' });
      return;
    }
    
    setIsLoading(true);
    try {
      // Find the device with this pairing code
      const { data: devices, error: deviceError } = await supabase
        .from('devices')
        .select('id')
        .eq('pairing_code', recoveryCode)
        .eq('role', 'Child')
        .single();
        
      if (deviceError || !devices) {
        Toast.show({ type: 'error', text1: 'Gagal', text2: 'Kode tidak ditemukan atau salah.', position: 'top' });
        setIsLoading(false);
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
        setChildProfile({
          fullName: profile.full_name,
          nickname: profile.nickname,
          gender: profile.settings?.childVoiceGender?.toLowerCase() === 'girl' ? 'girl' : 'boy'
        });
        
        // Load remote settings to Zustand
        if (profile.settings) {
          useAACStore.getState().setSpeechRate(profile.settings.speechRate || 1.0);
          useAACStore.getState().setChildVoiceGender(profile.settings.childVoiceGender || 'Boy');
        }
        
        Toast.show({ type: 'success', text1: 'Berhasil', text2: 'Profil Anak berhasil dipulihkan!', position: 'top' });
        setShowRecovery(false);
        setRole('Child');
      } else {
         Toast.show({ type: 'error', text1: 'Gagal', text2: 'Profil Anak tidak ditemukan.', position: 'top' });
      }
    } catch (err) {
      Toast.show({ type: 'error', text1: 'Error', text2: 'Gagal memulihkan data.', position: 'top' });
    } finally {
      setIsLoading(false);
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
            <Image source={require('../../assets/logo.png')} style={styles.logo} resizeMode="contain" />
            <Text style={styles.descText}>
              Aplikasi komunikasi AAC yang dapat disesuaikan{'\n'}
              untuk pengguna <Text style={{color: '#00B5B8', fontWeight: 'bold'}}>Autism</Text>, pengguna dengan{'\n'}
              <Text style={{color: '#FF2A7A', fontWeight: 'bold'}}>gangguan bicara & pendengaran</Text> serta pengguna <Text style={{color: '#9C27B0', fontWeight: 'bold'}}>nonverbal</Text>.
            </Text>

            <View style={styles.featuresBadge}>
              <View style={styles.featureItem}>
                <View style={[styles.featureIconBox, { backgroundColor: '#EBF4FF' }]}>
                  <FontAwesome5 name="smile" size={14} color="#2488FF" solid />
                </View>
                <Text style={styles.featureText}>Komunikasi{'\n'}Mudah</Text>
              </View>
              <View style={styles.featureItem}>
                <View style={[styles.featureIconBox, { backgroundColor: '#FFF0F5' }]}>
                  <FontAwesome5 name="heart" size={14} color="#FF2A7A" solid />
                </View>
                <Text style={styles.featureText}><Text style={{color: '#FF2A7A'}}>Interaktif</Text>{'\n'}& Menyenangkan</Text>
              </View>
              <View style={styles.featureItem}>
                <View style={[styles.featureIconBox, { backgroundColor: '#F0FDF4' }]}>
                  <FontAwesome5 name="brain" size={14} color="#4CAF50" solid />
                </View>
                <Text style={styles.featureText}><Text style={{color: '#4CAF50'}}>Cerdas</Text> &{'\n'}Adaptif</Text>
              </View>
              <View style={styles.featureItem}>
                <View style={[styles.featureIconBox, { backgroundColor: '#F5F3FF' }]}>
                  <FontAwesome5 name="users" size={14} color="#9C27B0" solid />
                </View>
                <Text style={styles.featureText}>Untuk Semua,{'\n'}Setiap Suara Berarti</Text>
              </View>
            </View>
          </View>

          <View style={styles.titleSection}>
            <Text style={styles.helloText}>Hai!</Text>
            <Text style={styles.titleText}>Pilih peran Anda</Text>
            <Text style={styles.subtitleText}>untuk melanjutkan</Text>
          </View>

          <View style={styles.buttonSection}>
            <TouchableOpacity onPress={() => handleSelectRole('Child')} activeOpacity={0.9} style={styles.roleBtn} disabled={isLoading}>
              <Image source={require('../../assets/mode-anak.webp')} style={styles.roleImage} resizeMode="contain" />
            </TouchableOpacity>

            <TouchableOpacity onPress={() => handleSelectRole('Parent')} activeOpacity={0.9} style={styles.roleBtn} disabled={isLoading}>
              <Image source={require('../../assets/mode-orangtua.webp')} style={styles.roleImage} resizeMode="contain" />
            </TouchableOpacity>
          </View>

          <View style={styles.bottomSection}>
            <TouchableOpacity onPress={() => setShowRecovery(true)} style={styles.recoveryBtnBox} disabled={isLoading}>
              <View style={styles.recoveryIconBox}>
                <FontAwesome5 name="sync-alt" size={20} color="#FFF" />
              </View>
              <View style={styles.recoveryTextBox}>
                <Text style={styles.recoveryTitleText}>Pulihkan Profil Anak Lama</Text>
                <Text style={styles.recoveryDescText}>Lanjutkan dengan memulihkan data yang{'\n'}sebelumnya sudah dibuat.</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      <Modal visible={showLanguageModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.languageContainer}>
            <Text style={styles.languageTitle}>Pilih Bahasa Aplikasi</Text>
            
            <TouchableOpacity 
              style={[styles.langBtn, currentLanguage === 'id' && styles.langBtnActive]} 
              onPress={() => handleLanguageSelect('id')}
            >
              <Text style={[styles.langBtnText, currentLanguage === 'id' && styles.langBtnTextActive]}>🇮🇩 Indonesia</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.langBtn, currentLanguage === 'en' && styles.langBtnActive]} 
              onPress={() => handleLanguageSelect('en')}
            >
              <Text style={[styles.langBtnText, currentLanguage === 'en' && styles.langBtnTextActive]}>🇬🇧 English</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
              style={[styles.langBtn, currentLanguage === 'zh' && styles.langBtnActive]} 
              onPress={() => handleLanguageSelect('zh')}
            >
              <Text style={[styles.langBtnText, currentLanguage === 'zh' && styles.langBtnTextActive]}>🇨🇳 Mandarin (中文)</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.languageCancel} onPress={() => setShowLanguageModal(false)}>
              <Text style={styles.languageCancelText}>Batal</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showRecovery} transparent animationType="slide">
        <KeyboardAvoidingView 
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.recoveryContainer}>
            <Text style={styles.recoveryTitle}>Pulihkan Profil Anak</Text>
            <Text style={styles.recoveryDesc}>Masukkan 6-digit Family Pairing Code dari perangkat sebelumnya untuk memulihkan profil.</Text>
            <TextInput 
              style={styles.pairingInput}
              placeholder="Contoh: 123456"
              value={recoveryCode}
              onChangeText={setRecoveryCode}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus={true}
            />
            <TouchableOpacity style={styles.recoverySubmit} onPress={handleRecoverProfile} disabled={isLoading}>
              {isLoading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.recoverySubmitText}>Pulihkan</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.recoveryCancel} onPress={() => setShowRecovery(false)} disabled={isLoading}>
              <Text style={styles.recoveryCancelText}>Batal</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <Toast />
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
  helloText: {
    fontSize: 20,
    fontWeight: '900',
    color: '#11427B',
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
  languageContainer: {
    backgroundColor: '#FFF',
    padding: 24,
    borderRadius: 20,
    elevation: 5,
  },
  languageTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#334155',
    marginBottom: 16,
    textAlign: 'center',
  },
  langBtn: {
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    marginBottom: 12,
    alignItems: 'center',
  },
  langBtnActive: {
    borderColor: '#2488FF',
    backgroundColor: '#EFF6FF',
  },
  langBtnText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#64748B',
  },
  langBtnTextActive: {
    color: '#2488FF',
  },
  languageCancel: {
    marginTop: 8,
    alignItems: 'center',
    padding: 10,
  },
  languageCancelText: {
    color: '#94A3B8',
    fontWeight: 'bold',
    fontSize: 16,
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
