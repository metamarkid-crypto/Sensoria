import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Text, TouchableOpacity, Modal, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';

interface Props {
  isVisible: boolean;
  onClose: () => void;
}

export default function PairingBottomSheet({ isVisible, onClose }: Props) {
  const [linkedParents, setLinkedParents] = useState<any[]>([]);
  const insets = useSafeAreaInsets();
  const { deviceId, pairingCode } = useAACStore();

  useEffect(() => {
    if (!isVisible || !deviceId) return;

    const fetchLinkedParents = async () => {
      const { data, error } = await supabase
        .from('family_links')
        .select('*')
        .eq('child_device_id', deviceId);
      if (!error && data) {
        setLinkedParents(data);
      }
    };
    
    fetchLinkedParents();

    const channel = supabase.channel('family_links_updates_sheet')
      .on(
        'postgres_changes', 
        { event: '*', schema: 'public', table: 'family_links', filter: `child_device_id=eq.${deviceId}` }, 
        (payload) => {
          fetchLinkedParents();
        }
      )
      .subscribe();

    // SAFEGUARD 1: Strict cleanup to prevent memory leaks
    return () => {
      supabase.removeChannel(channel);
    };
  }, [isVisible, deviceId]);

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

          {/* Illustration */}
          <Image source={require('../../assets/cover-pairing.png')} style={styles.sheetCoverImage} resizeMode="contain" />

          {/* Code Display */}
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

          {/* Connected Devices */}
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

            {linkedParents.length >= 1 && (
              <TouchableOpacity style={styles.sheetAddButton}>
                <FontAwesome5 name="plus" size={14} color="#2488FF" />
                <Text style={styles.sheetAddButtonText}>Tambah Perangkat</Text>
              </TouchableOpacity>
            )}
          </View>

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
});
