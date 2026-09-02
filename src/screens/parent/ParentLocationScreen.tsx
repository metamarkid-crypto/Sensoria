import React, { useState } from 'react';
import { View, Text, StyleSheet, Dimensions, ScrollView, TouchableOpacity, Image, Modal, TextInput, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import MapView, { Marker, Circle, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';
import * as Haptics from 'expo-haptics';

const { width, height } = Dimensions.get('window');

// 1. Haversine Distance Utility
function getDistanceFromLatLonInMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3; // Radius of the earth in m
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  const d = R * c; // Distance in m
  return d;
}

export default function ParentLocationScreen() {
  const insets = useSafeAreaInsets();
  const { childProfile, childStatus } = useAACStore();
  
  // JSONB Global State: Read from childProfile.settings.safeZones
  const safeZones = childProfile?.settings?.safeZones || [];
  
  const [isAddModalVisible, setAddModalVisible] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [newZoneRadius, setNewZoneRadius] = useState('100');
  
  // Smart Add Modal auto-fills with current child coordinates
  const [newZoneLat, setNewZoneLat] = useState(childStatus.lat ? childStatus.lat.toString() : '');
  const [newZoneLng, setNewZoneLng] = useState(childStatus.lng ? childStatus.lng.toString() : '');

  const childLat = childStatus.lat || -6.200000;
  const childLng = childStatus.lng || 106.816666;
  const avatarSource = childProfile?.gender === 'Girl' ? require('../../../assets/icon.png') : require('../../../assets/icon.png');
  const fullName = childProfile?.fullName || childProfile?.name || childProfile?.nickname || 'Anak';

  // Geofencing Logic
  let activeZone = null;
  if (childStatus.lat && childStatus.lng) {
    for (const zone of safeZones) {
      const dist = getDistanceFromLatLonInMeters(childStatus.lat, childStatus.lng, zone.lat, zone.lng);
      if (dist <= zone.radius) {
        activeZone = zone;
        break;
      }
    }
  }

  const handleRefreshLocation = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // In a real app, this would ping the child's device via Supabase Broadcast to force a GPS update.
    Alert.alert('Permintaan Terkirim', 'Meminta pembaruan lokasi dari perangkat anak...');
  };

  const openAddModal = () => {
    Haptics.selectionAsync();
    // CRITICAL UX: Auto-fill coordinates
    if (childStatus.lat && childStatus.lng) {
      setNewZoneLat(childStatus.lat.toString());
      setNewZoneLng(childStatus.lng.toString());
    }
    setNewZoneName('');
    setNewZoneRadius('100');
    setAddModalVisible(true);
  };

  const handleSaveZone = async () => {
    if (!newZoneName.trim() || !newZoneLat || !newZoneLng || !newZoneRadius) {
      Alert.alert('Error', 'Harap isi semua kolom.');
      return;
    }
    
    if (!childProfile?.device_id) {
      Alert.alert('Error', 'Profil anak tidak ditemukan.');
      return;
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    
    const newZone = {
      id: Date.now().toString(),
      name: newZoneName.trim(),
      lat: parseFloat(newZoneLat),
      lng: parseFloat(newZoneLng),
      radius: parseFloat(newZoneRadius)
    };

    const updatedSafeZones = [...safeZones, newZone];
    const mergedSettings = { ...(childProfile.settings || {}), safeZones: updatedSafeZones };

    // The Universal Sync Mutation (CRUD for Safe Zones)
    try {
      const { error } = await supabase
        .from('child_profiles')
        .update({ settings: mergedSettings })
        .eq('device_id', childProfile.device_id);
        
      if (error) throw error;
      
      // Update local state to reflect immediately before Supabase Postgres Changes kicks in
      useAACStore.setState({
        childProfile: { ...childProfile, settings: mergedSettings }
      });
      
    } catch (error) {
      console.error('Failed to sync Safe Zones:', error);
      Alert.alert('Gagal', 'Tidak dapat menyimpan Area Aman ke server.');
    }
    
    setAddModalVisible(false);
  };

  const handleDeleteZone = async (zoneId: string) => {
    Alert.alert(
      'Hapus Area Aman',
      'Apakah Anda yakin ingin menghapus area ini?',
      [
        { text: 'Batal', style: 'cancel' },
        { 
          text: 'Hapus', 
          style: 'destructive',
          onPress: async () => {
            if (!childProfile?.device_id) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

            const updatedSafeZones = safeZones.filter((z: any) => z.id !== zoneId);
            const mergedSettings = { ...(childProfile.settings || {}), safeZones: updatedSafeZones };

            try {
              const { error } = await supabase
                .from('child_profiles')
                .update({ settings: mergedSettings })
                .eq('device_id', childProfile.device_id);
                
              if (error) throw error;
              
              useAACStore.setState({
                childProfile: { ...childProfile, settings: mergedSettings }
              });
              
            } catch (error) {
              console.error('Failed to delete Safe Zone:', error);
              Alert.alert('Gagal', 'Tidak dapat menghapus Area Aman dari server.');
            }
          }
        }
      ]
    );
  };

  return (
    <View style={styles.container}>
      
      {/* 1. BACKGROUND MAP (Absolute at the bottom layer) */}
      <View style={styles.mapContainer}>
        <MapView
          style={styles.map}
          provider={PROVIDER_GOOGLE}
          region={{
            latitude: Number(childLat) || -6.200000,
            longitude: Number(childLng) || 106.816666,
            latitudeDelta: 0.005,
            longitudeDelta: 0.005,
          }}
        >
          <Marker coordinate={{ latitude: Number(childLat) || -6.200000, longitude: Number(childLng) || 106.816666 }}>
            <View style={styles.customMarker}>
              <Image source={avatarSource} style={styles.markerAvatar} />
            </View>
          </Marker>

          {safeZones.map(zone => (
            <Circle
              key={zone.id}
              center={{ latitude: Number(zone.lat), longitude: Number(zone.lng) }}
              radius={Number(zone.radius)}
              fillColor="rgba(59, 130, 246, 0.2)"
              strokeColor="rgba(59, 130, 246, 0.8)"
              strokeWidth={2}
            />
          ))}
        </MapView>
      </View>

      {/* 2. FOREGROUND SCROLLVIEW (Naturally renders on top) */}
      <ScrollView 
        style={styles.scrollView} 
        showsVerticalScrollIndicator={false}
      >
        {/* Spacer to push content down and reveal the map */}
        <View style={styles.transparentSpacer} />

        {/* Solid Bottom Sheet (Provides the rounded corners over the map) */}
        <View style={styles.solidBottomSheet}>
          
          {/* The Overlapping Card (Breaks out of the bottom sheet to overlap) */}
          <View style={styles.overlappingCard}>
          <View style={styles.cardTopRow}>
              <Image source={avatarSource} style={styles.cardAvatar} />
              <View style={styles.cardHeaderInfo}>
                <Text style={styles.cardName} numberOfLines={1}>{fullName}</Text>
                <View style={styles.statusBadgeRow}>
                  {activeZone ? (
                    <>
                      <FontAwesome5 name="check-circle" size={14} color="#059669" />
                      <Text style={styles.statusBadgeTextSafe}>Di area aman: {activeZone.name}</Text>
                    </>
                  ) : (
                    <>
                      <FontAwesome5 name="exclamation-circle" size={14} color="#DC2626" />
                      <Text style={styles.statusBadgeTextDanger}>Di luar area aman</Text>
                    </>
                  )}
                </View>
              </View>
            </View>

          <View style={styles.divider} />

            <Text style={styles.locationLabel}>Lokasi Terakhir</Text>
            <Text style={styles.locationAddress} numberOfLines={2}>
              {childStatus.lastAddress || 'Belum ada data alamat'}
            </Text>
            <Text style={styles.timestamp}>
              Pembaruan terakhir: {childStatus.lastSeen ? childStatus.lastSeen : 'Belum diketahui'}
            </Text>

            <TouchableOpacity style={styles.refreshButton} onPress={handleRefreshLocation} activeOpacity={0.8}>
              <FontAwesome5 name="sync-alt" size={14} color="#FFF" style={{ marginRight: 8 }} />
              <Text style={styles.refreshButtonText}>Perbarui Lokasi</Text>
            </TouchableOpacity>
          </View>

        {/* Safe Zone List */}
        <View style={styles.zonesHeaderRow}>
            <Text style={styles.zonesTitle}>Area Aman</Text>
            <TouchableOpacity style={styles.manageBtn} onPress={openAddModal}>
              <Text style={styles.manageBtnText}>Kelola</Text>
              <FontAwesome5 name="cog" size={12} color="#3B82F6" />
            </TouchableOpacity>
        </View>

        {safeZones.map(zone => {
            const isCurrentlyHere = activeZone?.id === zone.id;
            return (
              <View key={zone.id} style={styles.zoneItem}>
                <View style={styles.zoneIconWrap}>
                  <FontAwesome5 name="shield-alt" size={16} color={isCurrentlyHere ? "#059669" : "#64748B"} />
                </View>
                <View style={styles.zoneInfo}>
                  <Text style={styles.zoneName}>{zone.name}</Text>
                  <Text style={styles.zoneRadius}>Radius: {zone.radius} meter</Text>
                </View>
                {isCurrentlyHere && (
                  <View style={styles.activeZoneTag}>
                    <Text style={styles.activeZoneText}>Aktif</Text>
                  </View>
                )}
                <TouchableOpacity onPress={() => handleDeleteZone(zone.id)} style={styles.deleteZoneBtn}>
                  <FontAwesome5 name="trash" size={14} color="#EF4444" />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      </ScrollView>

      {/* Smart Add Modal */}
      <Modal visible={isAddModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Tambah Area Aman</Text>
              <TouchableOpacity onPress={() => setAddModalVisible(false)}>
                <FontAwesome5 name="times" size={20} color="#94A3B8" />
              </TouchableOpacity>
            </View>
            
            <Text style={styles.inputLabel}>Nama Tempat</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Misal: Rumah Nenek"
              value={newZoneName}
              onChangeText={setNewZoneName}
            />
            
            <View style={styles.rowInputs}>
              <View style={styles.flex1}>
                <Text style={styles.inputLabel}>Latitude</Text>
                <TextInput
                  style={[styles.modalInput, styles.inputDisabled]}
                  value={newZoneLat}
                  onChangeText={setNewZoneLat}
                  keyboardType="numeric"
                  editable={false} // Auto-filled
                />
              </View>
              <View style={{ width: 12 }} />
              <View style={styles.flex1}>
                <Text style={styles.inputLabel}>Longitude</Text>
                <TextInput
                  style={[styles.modalInput, styles.inputDisabled]}
                  value={newZoneLng}
                  onChangeText={setNewZoneLng}
                  keyboardType="numeric"
                  editable={false} // Auto-filled
                />
              </View>
            </View>

            <Text style={styles.inputLabel}>Radius (Meter)</Text>
            <TextInput
              style={styles.modalInput}
              value={newZoneRadius}
              onChangeText={setNewZoneRadius}
              keyboardType="numeric"
            />

            <TouchableOpacity style={styles.saveBtn} onPress={handleSaveZone}>
              <Text style={styles.saveBtnText}>Simpan Area</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>


    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC', // Base background
  },
  mapContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: height * 0.5, // Map takes exactly 50% of the screen height
    backgroundColor: '#E2E8F0', 
  },
  map: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  transparentSpacer: {
    height: (height * 0.5) - 60, // Pushes the solid sheet down, leaving 60px for overlap
  },
  solidBottomSheet: {
    backgroundColor: '#F8FAFC',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    minHeight: height, // Ensures the list background covers the map when scrolled up
    paddingHorizontal: 16,
    // NO overflow: hidden! So the card can pop out freely.
  },
  overlappingCard: {
    marginTop: -40, // Magically pulls the card UP to overlap the map and the sheet
    backgroundColor: '#FFF',
    borderRadius: 24,
    padding: 20,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    marginBottom: 24,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardAvatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#F1F5F9',
    marginRight: 16,
  },
  cardHeaderInfo: {
    flex: 1,
  },
  cardName: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#0F172A',
    marginBottom: 4,
  },
  statusBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusBadgeTextSafe: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#059669',
  },
  statusBadgeTextDanger: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#DC2626',
  },
  divider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginVertical: 16,
  },
  locationLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#94A3B8',
    textTransform: 'uppercase',
    marginBottom: 4,
  },
  locationAddress: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1E293B',
    marginBottom: 8,
  },
  timestamp: {
    fontSize: 12,
    color: '#64748B',
    marginBottom: 16,
  },
  refreshButton: {
    backgroundColor: '#2563EB',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: 16,
  },
  refreshButtonText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 16,
  },
  zonesHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  zonesTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0F172A',
  },
  manageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    gap: 6,
  },
  manageBtnText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#3B82F6',
  },
  zoneItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF',
    padding: 16,
    borderRadius: 16,
    marginBottom: 12,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
  },
  zoneIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#F8FAFC',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  zoneInfo: {
    flex: 1,
  },
  zoneName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1E293B',
    marginBottom: 2,
  },
  zoneRadius: {
    fontSize: 12,
    color: '#64748B',
  },
  activeZoneTag: {
    backgroundColor: '#D1FAE5',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  activeZoneText: {
    color: '#059669',
    fontWeight: 'bold',
    fontSize: 12,
  },
  deleteZoneBtn: {
    padding: 8,
    marginLeft: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: '#FFF',
    width: '90%',
    borderRadius: 24,
    padding: 24,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#0F172A',
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#64748B',
    marginBottom: 6,
    marginLeft: 4,
  },
  modalInput: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    color: '#0F172A',
    marginBottom: 16,
  },
  inputDisabled: {
    backgroundColor: '#F1F5F9',
    color: '#94A3B8',
  },
  rowInputs: {
    flexDirection: 'row',
  },
  flex1: {
    flex: 1,
  },
  saveBtn: {
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  saveBtnText: {
    color: '#FFF',
    fontWeight: 'bold',
    fontSize: 16,
  }
});
