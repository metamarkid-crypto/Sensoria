import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, Modal, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';
import * as Haptics from 'expo-haptics';
import { TextInput, Alert, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';

interface Props {
  isVisible: boolean;
  onClose: () => void;
}

export default function PairingBottomSheet({ isVisible, onClose }: Props) {
  const [linkedParents, setLinkedParents] = useState<any[]>([]);
  const [inputCode, setInputCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const insets = useSafeAreaInsets();
  const { deviceId, pairingCode, role, childProfile, setPairingCode, setChildProfile, localParentName } = useAACStore();

  useEffect(() => {
    if (!isVisible || !deviceId) return;

    const fetchLinkedParents = async () => {
      if (role !== 'Child') return; // Only child fetches list of parents
      const { data, error } = await supabase
        .from('family_links')
        .select('*')
        .eq('child_device_id', deviceId);
      if (!error && data) {
        setLinkedParents(data);
      }
    };
    
    fetchLinkedParents();

    let channel: any = null;
    if (role === 'Child') {
      channel = supabase.channel('family_links_updates_sheet')
        .on(
          'postgres_changes', 
          { event: '*', schema: 'public', table: 'family_links', filter: `child_device_id=eq.${deviceId}` }, 
          (payload) => {
            fetchLinkedParents();
          }
        )
        .subscribe();
    }

    // SAFEGUARD 1: Strict cleanup to prevent memory leaks
    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [isVisible, deviceId, role]);

  const handleLinkDevice = async () => {
    if (!inputCode || inputCode.length !== 6) {
      Alert.alert('Gagal', 'Masukkan 6 digit kode yang valid.');
      return;
    }

    setIsLoading(true);
    try {
      const { data: childDevice, error: deviceError } = await supabase
        .from('devices')
        .select('id')
        .eq('pairing_code', inputCode)
        .eq('role', 'Child')
        .single();
        
      if (deviceError || !childDevice) {
        Alert.alert('Gagal', 'Kode tidak valid atau perangkat anak tidak ditemukan.');
        setIsLoading(false);
        return;
      }

      const parentName = localParentName || 'Orang Tua';

      await supabase.from('family_links').upsert({
        parent_device_id: deviceId,
        child_device_id: childDevice.id,
        parent_label: parentName
      });

      const { data: profile } = await supabase
        .from('child_profiles')
        .select('*')
        .eq('device_id', childDevice.id)
        .single();
        
      if (profile) {
        setChildProfile({
          device_id: childDevice.id,
          fullName: profile.full_name,
          nickname: profile.nickname,
          gender: profile.settings?.childVoiceGender?.toLowerCase() === 'girl' ? 'Girl' : 'Boy',
          settings: profile.settings
        });
      }

      setPairingCode(inputCode);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Berhasil', 'Perangkat berhasil ditautkan!');
      setInputCode('');
      onClose();

    } catch (err) {
      Alert.alert('Error', 'Gagal menautkan perangkat.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleUnlink = () => {
    Alert.alert(
      'Putuskan Tautan',
      'Apakah Anda yakin ingin memutuskan tautan perangkat ini?',
      [
        { text: 'Batal', style: 'cancel' },
        { 
          text: 'Putuskan', 
          style: 'destructive',
          onPress: async () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            // We just clear local state for simplicity in MVP. 
            // In a real app, we would also DELETE from family_links table.
            if (deviceId) {
               await supabase.from('family_links').delete().eq('parent_device_id', deviceId);
            }
            setPairingCode(null as any);
            setChildProfile(null);
          }
        }
      ]
    );
  };

  const renderChildModeContent = () => (
    <>
      <Image source={require('../../assets/cover-pairing.png')} style={styles.sheetCoverImage} resizeMode="contain" />
      <View style={styles.sheetCodeBox}>
        <Text style={styles.sheetCodeLabel}>Kode Pairing Anda</Text>
        {linkedParents.length >= 1 ? (
          <View style={styles.sheetObfuscatedBox}>
            <FontAwesome5 name="lock" size={24} color="#94A3B8" style={{ marginRight: 12 }} />
            <Text style={styles.sheetObfuscatedText}>* * * * * *</Text>
          </View>
        ) : (
          <View style={styles.sheetCodeRow}>
            {pairingCode?.split('').map((digit, index) => {
              const colors = ['#2488FF', '#FF2A7A', '#FF9800', '#4CAF50', '#9C27B0', '#00BCD4'];
              return <Text key={index} style={[styles.sheetCodeDigit, { color: colors[index % colors.length] }]}>{digit}</Text>;
            })}
          </View>
        )}
        {linkedParents.length < 1 && (
          <Text style={styles.sheetCodeDesc}>Masukkan kode ini pada perangkat keluarga untuk mulai terhubung.</Text>
        )}
      </View>
      <View style={styles.sheetDevicesSection}>
        <Text style={styles.sheetDevicesTitle}>Perangkat Terhubung</Text>
        {linkedParents.length === 0 ? (
          <Text style={styles.sheetDevicesEmpty}>Belum ada perangkat yang tertaut.</Text>
        ) : (
          linkedParents.map(parent => (
            <View key={parent.id} style={styles.sheetDeviceRow}>
              <View style={styles.sheetDeviceIconBox}>
                <FontAwesome5 name="tablet-alt" size={20} color="#94A3B8" />
              </View>
              <Text style={styles.sheetDeviceName}>Sensoria {parent.parent_label}</Text>
              <View style={styles.sheetDeviceStatus}>
                <View style={styles.sheetDeviceDot} />
                <Text style={styles.sheetDeviceStatusText}>Terhubung</Text>
              </View>
            </View>
          ))
        )}
      </View>
    </>
  );

  const renderParentModeContent = () => (
    <View>
      <Image source={require('../../assets/cover-pairing.png')} style={styles.sheetCoverImage} resizeMode="contain" />
      
      {pairingCode && childProfile ? (
        // Already Linked
        <View style={styles.sheetCodeBox}>
          <Text style={styles.sheetCodeLabel}>Perangkat Anak Terhubung</Text>
          <View style={[styles.sheetDeviceRow, { width: '100%', backgroundColor: '#F8FAFC', marginBottom: 20 }]}>
            <View style={[styles.sheetDeviceIconBox, { backgroundColor: '#E0F2FE' }]}>
              <FontAwesome5 name="child" size={20} color="#0EA5E9" />
            </View>
            <Text style={styles.sheetDeviceName}>{childProfile.fullName || childProfile.nickname}</Text>
            <View style={styles.sheetDeviceStatus}>
              <View style={styles.sheetDeviceDot} />
              <Text style={styles.sheetDeviceStatusText}>Terhubung</Text>
            </View>
          </View>
          <TouchableOpacity style={[styles.sheetAddButton, { borderColor: '#EF4444', backgroundColor: '#FEF2F2' }]} onPress={handleUnlink}>
            <FontAwesome5 name="unlink" size={14} color="#EF4444" />
            <Text style={[styles.sheetAddButtonText, { color: '#EF4444' }]}>Putuskan Tautan</Text>
          </TouchableOpacity>
        </View>
      ) : (
        // Needs Linking
        <View style={styles.sheetCodeBox}>
          <Text style={styles.sheetCodeLabel}>Masukkan Kode Pairing Anak</Text>
          
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.pairingInput}
              placeholder="123456"
              placeholderTextColor="#CBD5E1"
              value={inputCode}
              onChangeText={setInputCode}
              keyboardType="number-pad"
              maxLength={6}
            />
          </View>
          
          <Text style={styles.sheetCodeDesc}>Dapatkan 6-digit kode ini dari perangkat anak.</Text>
          
          <TouchableOpacity 
            style={[styles.linkButton, (!inputCode || inputCode.length !== 6) && styles.linkButtonDisabled]}
            onPress={handleLinkDevice}
            disabled={isLoading || inputCode.length !== 6}
          >
            {isLoading ? <ActivityIndicator color="#FFF" /> : (
              <>
                <FontAwesome5 name="link" size={14} color="#FFF" />
                <Text style={styles.linkButtonText}>Tautkan Sekarang</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  return (
    <Modal visible={isVisible} animationType="slide" transparent onRequestClose={onClose}>
      <TouchableOpacity 
        style={styles.bottomSheetOverlay} 
        activeOpacity={1} 
        onPress={onClose}
      >
        <View 
          style={[styles.bottomSheetContainer, { paddingBottom: Math.max(insets.bottom, 20) }]}
          onStartShouldSetResponder={() => true}
        >
          
          {/* Header */}
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleContainer}>
              <Text style={styles.sheetTitle}>Tautkan Perangkat</Text>
              <Text style={styles.sheetSubtitle}>Hubungkan Sensoria dengan perangkat keluarga</Text>
            </View>
            <TouchableOpacity style={styles.sheetCloseBtn} onPress={onClose}>
              <FontAwesome5 name="times" size={18} color="#FF2A7A" />
            </TouchableOpacity>
          </View>

          {role === 'Child' ? renderChildModeContent() : renderParentModeContent()}

        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bottomSheetOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  bottomSheetContainer: {
    backgroundColor: '#FAFAFF',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingHorizontal: 24,
    paddingTop: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 20,
  },
  sheetHeader: {
    alignItems: 'center',
    marginBottom: 20,
    position: 'relative',
  },
  sheetCloseBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#FFE3E3',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  sheetTitleContainer: {
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  sheetTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#11427B',
  },
  sheetSubtitle: {
    fontSize: 13,
    color: '#64748B',
    marginTop: 2,
  },
  sheetCoverImage: {
    width: '100%',
    height: 180,
    marginBottom: 20,
  },
  sheetCodeBox: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 5,
    marginBottom: 24,
  },
  sheetCodeLabel: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#1A2980',
    marginBottom: 16,
  },
  sheetCodeRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  sheetCodeDigit: {
    fontSize: 48,
    fontWeight: '900',
    letterSpacing: 4,
  },
  sheetObfuscatedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 16,
    marginBottom: 16,
    width: '100%',
  },
  sheetObfuscatedText: {
    fontSize: 32,
    fontWeight: '900',
    color: '#94A3B8',
    letterSpacing: 8,
  },
  sheetCodeDesc: {
    fontSize: 13,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
  },
  sheetDevicesSection: {
    marginBottom: 10,
  },
  sheetDevicesTitle: {
    fontSize: 16,
    fontWeight: '900',
    color: '#94A3B8',
    marginBottom: 12,
  },
  sheetDevicesEmpty: {
    fontSize: 14,
    color: '#94A3B8',
    textAlign: 'center',
    marginBottom: 16,
  },
  sheetDeviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  sheetDeviceIconBox: {
    width: 40,
    height: 40,
    backgroundColor: '#F1F5F9',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  sheetDeviceName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '900',
    color: '#64748B',
  },
  sheetDeviceStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0FDF4',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  sheetDeviceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4CAF50',
    marginRight: 6,
  },
  sheetDeviceStatusText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#4CAF50',
  },
  sheetAddButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F0F8FF',
    borderWidth: 1,
    borderColor: '#2488FF',
    borderRadius: 16,
    paddingVertical: 16,
    gap: 8,
  },
  sheetAddButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#2488FF',
  },
  pairingInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 2,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    padding: 16,
    fontSize: 32,
    fontWeight: '900',
    textAlign: 'center',
    letterSpacing: 12,
    color: '#0F172A',
  },
  inputContainer: {
    width: '100%',
    marginBottom: 16,
  },
  linkButton: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2488FF',
    borderRadius: 16,
    paddingVertical: 16,
    marginTop: 16,
    gap: 8,
  },
  linkButtonDisabled: {
    backgroundColor: '#94A3B8',
  },
  linkButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFF',
  }
});
