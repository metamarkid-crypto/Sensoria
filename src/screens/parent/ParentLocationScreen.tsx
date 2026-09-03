import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Modal, TextInput, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import MapView, { Marker, Circle, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';
import * as Haptics from 'expo-haptics';

// NOTE (Android stability): No Dimensions.get('window') here on purpose.
// Both regions below are sized with percentage offsets resolved against the
// parent container, so nothing can be pushed off-screen by a stale window size.

// 1. Haversine Distance Utility
function getDistanceFromLatLonInMeters(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3; // Radius of the earth in m
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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

  // Bottom tab bar floats absolutely over this screen (see ParentDashboardScreen),
  // so scrolling content must reserve room for it.
  const bottomBarHeight = 70 + insets.bottom;

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

      {/* ================================================================
          LAYER 1 — MAP (Android-safe, dedicated native surface region)
          Absolutely positioned to the TOP band only. Percentage-sized so
          it always lands on-screen. Nothing scrolls over it, nothing
          transparent covers it, and no sibling has elevation over it.
          ================================================================ */}
      <View style={styles.mapRegion} pointerEvents="auto">
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

      {/* ================================================================
          LAYER 2 — SOLID BOTTOM SHEET
          Fully opaque, bounded height, rounded top corners, overflow
          hidden. Its top edge overlaps the map by a small opaque margin
          (the rounded corners "float" over the map, Google-Maps style).
          The ONLY ScrollView on this screen lives inside this sheet.
          ================================================================ */}
      <View style={styles.bottomSheet}>

        {/* STATIC Child Info Card — sibling of the ScrollView, anchored to
            the top of the sheet. It never crosses into the map region, so
            it needs no negative margins or boundary elevation. */}
        <View style={styles.infoCard}>
          <View style={styles.cardTopRow}>
            <Image source={avatarSource} style={styles.cardAvatar} />
            <View style={styles.cardHeaderInfo}>
              <Text style={styles.cardName} numberOfLines={1}>{fullName}</Text>
              <View style={styles.statusBadgeRow}>
                {activeZone ? (
                  <>
                    <FontAwesome5 name="check-circle" size={13} color="#059669" />
                    <Text style={styles.statusBadgeTextSafe} numberOfLines={1}>Di area aman: {activeZone.name}</Text>
                  </>
                ) : (
                  <>
                    <FontAwesome5 name="exclamation-circle" size={13} color="#DC2626" />
                    <Text style={styles.statusBadgeTextDanger} numberOfLines={1}>Di luar area aman</Text>
                  </>
                )}
              </View>
            </View>
            <TouchableOpacity style={styles.refreshButton} onPress={handleRefreshLocation} activeOpacity={0.8}>
              <FontAwesome5 name="sync-alt" size={16} color="#FFF" />
            </TouchableOpacity>
          </View>

          <View style={styles.divider} />

          <Text style={styles.locationLabel}>Lokasi Terakhir</Text>
          <Text style={styles.locationAddress} numberOfLines={1}>
            {childStatus.lastAddress || 'Belum ada data alamat'}
          </Text>
          <Text style={styles.timestamp} numberOfLines={1}>
            Pembaruan terakhir: {childStatus.lastSeen ? childStatus.lastSeen : 'Belum diketahui'}
          </Text>
        </View>

        {/* Safe Zone list — scrolls ONLY inside the opaque sheet. */}
        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={[styles.sheetScrollContent, { paddingBottom: bottomBarHeight + 12 }]}
          showsVerticalScrollIndicator={false}
        >
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
        </ScrollView>
      </View>

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
    backgroundColor: '#F8FAFC', // Matches the sheet so the scene edges blend
  },
  /* --- LAYER 1: MAP (top band, its own native surface) --- */
  mapRegion: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // Map ends ~8% BELOW the sheet's top edge: the sheet is opaque there, so
    // this hidden overlap only exists to give the sheet's rounded top corners
    // real map pixels to float over (no transparent spacer over the map).
    bottom: '44%',
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
  },
  map: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  /* --- LAYER 2: SOLID BOTTOM SHEET --- */
  bottomSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '52%', // Bounded height — never grows past this
    backgroundColor: '#F8FAFC', // FULLY OPAQUE: no alpha blending over the map surface
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: 'hidden',
  },
  /* Static child info card (NOT inside the ScrollView) */
  infoCard: {
    marginTop: 14,
    marginHorizontal: 16,
    backgroundColor: '#FFF',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#EDF1F7',
    padding: 14,
    // Deliberately no elevation/shadow: the card sits at the top of the sheet
    // and must never render a translucent edge near the map boundary.
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#F1F5F9',
    marginRight: 12,
  },
  cardHeaderInfo: {
    flex: 1,
    marginRight: 10,
  },
  cardName: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#0F172A',
    marginBottom: 2,
  },
  statusBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusBadgeTextSafe: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#059669',
    flexShrink: 1,
  },
  statusBadgeTextDanger: {
    fontSize: 13,
    fontWeight: 'bold',
    color: '#DC2626',
    flexShrink: 1,
  },
  refreshButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginVertical: 10,
  },
  locationLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#94A3B8',
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  locationAddress: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1E293B',
    marginBottom: 2,
  },
  timestamp: {
    fontSize: 11,
    color: '#64748B',
  },
  /* Scrolling list — confined to the sheet */
  sheetScroll: {
    flex: 1,
  },
  sheetScrollContent: {
    paddingHorizontal: 16,
  },
  zonesHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    marginBottom: 12,
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
    // Elevation is safe here: zone items sit mid-sheet, far from the map boundary.
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
  /* Map marker */
  customMarker: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 3,
    borderColor: '#FFF',
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  markerAvatar: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  /* Smart Add Modal */
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
