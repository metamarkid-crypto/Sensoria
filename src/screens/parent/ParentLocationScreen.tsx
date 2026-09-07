import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Image, Modal, TextInput, KeyboardAvoidingView, Platform, Alert, ActivityIndicator, LayoutChangeEvent } from 'react-native';
import MapView, { Marker, Circle, PROVIDER_GOOGLE } from 'react-native-maps';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { supabase } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';
import { useTranslation, translate } from '../../i18n';
import AvatarPin from '../../components/parent/AvatarPin';
import LocationBottomSheet from '../../components/parent/LocationBottomSheet';

// No Dimensions.get('window') anywhere on purpose (Android map-stability rule).
// All layers are percentage/absolute against measured onLayout heights.

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

/** "Sekarang" / "X menit lalu" — mirrors the dashboard's presence formatting. */
function formatLastSeen(iso: string | null): string {
  const lang = useAACStore.getState().language;
  if (!iso) return translate(lang, 'common.unknown');
  const diffMins = Math.floor((new Date().getTime() - new Date(iso).getTime()) / 60000);
  if (diffMins < 1) return translate(lang, 'header.now');
  return translate(lang, 'header.minutesAgo', { n: diffMins });
}

const DEFAULT_COORD = { latitude: -6.200000, longitude: 106.816666 };

// Header geometry mirrors the shared gradient header used on the other tabs
// (see DynamicGlobalHeader: '#181824/#11427B/#007C92', 24px bottom radii,
// paddingHorizontal 24). Height reserves enough room below the title so the
// 24px curvature renders smooth over the map, and the floating info card
// clears it by CARD_TOP_OFFSET below the header's bottom edge.
const HEADER_BASE_HEIGHT = 72;
const CARD_TOP_OFFSET = 16;

export default function ParentLocationScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const { childProfile, childStatus, deviceId, role, setChildStatus } = useAACStore();

  // JSONB Global State: Read from childProfile.settings.safeZones
  const safeZones = childProfile?.settings?.safeZones || [];

  // ── Realtime live location (Roadmap #3) ─────────────────────────────────
  const mapRef = useRef<MapView | null>(null);
  const channelRef = useRef<any>(null);
  const childIdRef = useRef<string | null>(null);
  // Latest payload kept in a ref so the realtime callback never goes stale.
  const coordsRef = useRef<{ latitude: number; longitude: number } | null>(
    childStatus.lat && childStatus.lng
      ? { latitude: childStatus.lat, longitude: childStatus.lng }
      : null,
  );

  const [areaHeight, setAreaHeight] = useState(0);
  const [liveAddress, setLiveAddress] = useState<string | null>(childStatus.lastAddress);
  const [liveTimestamp, setLiveTimestamp] = useState<string | null>(childStatus.lastSeen);
  const [markerReady, setMarkerReady] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [isAddModalVisible, setAddModalVisible] = useState(false);
  const [newZoneName, setNewZoneName] = useState('');
  const [newZoneRadius, setNewZoneRadius] = useState('100');
  const [newZoneLat, setNewZoneLat] = useState(childStatus.lat ? childStatus.lat.toString() : '');
  const [newZoneLng, setNewZoneLng] = useState(childStatus.lng ? childStatus.lng.toString() : '');

  const currentCoord = coordsRef.current ?? DEFAULT_COORD;
  const avatarSource = require('../../../assets/icon.png');
  const fullName = childProfile?.fullName || childProfile?.full_name || childProfile?.nickname || t('aac.childFallback');

  // Bottom tab bar floats absolutely over this screen (see ParentDashboardScreen).
  const tabBarHeight = 70 + insets.bottom;

  // ── Resolve linked child + subscribe to its `locations` INSERTs ─────────
  useEffect(() => {
    if (role !== 'Parent' || !deviceId) return;

    const resolveChild = async () => {
      // .limit(1) (NOT .single()): a multi-parent setup with several link rows
      // makes .single() return an error object — the whole pipeline would die
      // silently. We only need one link to subscribe to.
      const { data: links } = await supabase
        .from('family_links')
        .select('child_device_id')
        .eq('parent_device_id', deviceId)
        .limit(1);
      const link = links?.[0];
      if (!link) return;
      childIdRef.current = link.child_device_id;

      // Initial map load: fetch the child's last known location so the marker
      // renders real history instead of defaulting to the Jakarta fallback
      // when the child has rows in the `locations` table.
      const { data: lastLoc } = await supabase
        .from('locations')
        .select('latitude, longitude, address, recorded_at')
        .eq('child_device_id', link.child_device_id)
        .order('recorded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (
        lastLoc &&
        typeof lastLoc.latitude === 'number' &&
        typeof lastLoc.longitude === 'number'
      ) {
        const coord = { latitude: lastLoc.latitude, longitude: lastLoc.longitude };
        coordsRef.current = coord;
        setLiveAddress(lastLoc.address ?? null);
        setLiveTimestamp(formatLastSeen(lastLoc.recorded_at ?? null));
        setChildStatus({
          lastSeen: formatLastSeen(lastLoc.recorded_at ?? null),
          lat: lastLoc.latitude,
          lng: lastLoc.longitude,
          lastAddress: lastLoc.address ?? null,
        });
        mapRef.current?.animateToRegion(
          { ...coord, latitudeDelta: 0.005, longitudeDelta: 0.005 },
          800,
        );
      }

      const channel = supabase
        .channel(`parent-locations-${link.child_device_id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'locations',
            filter: `child_device_id=eq.${link.child_device_id}`,
          },
          (payload: any) => {
            const row = payload.new;
            if (typeof row.latitude !== 'number' || typeof row.longitude !== 'number') return;
            const coord = { latitude: row.latitude, longitude: row.longitude };
            coordsRef.current = coord;
            setLiveAddress(row.address ?? null);
            setLiveTimestamp(formatLastSeen(row.recorded_at ?? null));
            // Keep the shared store fresh for the other tabs + global header.
            setChildStatus({
              isOnline: true,
              lastSeen: formatLastSeen(row.recorded_at ?? null),
              lat: row.latitude,
              lng: row.longitude,
              lastAddress: row.address ?? null,
            });
            // Animate the marker via the ref — the MapView itself never
            // re-renders, so a new payload costs no React reconciliation.
            mapRef.current?.animateToRegion(
              { ...coord, latitudeDelta: 0.005, longitudeDelta: 0.005 },
              1200,
            );
          },
        )
        .subscribe((status) => {
          // Visibility into the previously-silent realtime transport: RLS
          // blocks or a missing publication used to fail with zero signal.
          if (status === 'SUBSCRIBED') {
            console.log('[Realtime] locations channel SUBSCRIBED for', link.child_device_id);
          } else if (status !== 'CLOSED') {
            console.warn('[Realtime] locations channel status:', status);
          }
        });
      channelRef.current = channel;
    };

    void resolveChild();
    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    };
  }, [role, deviceId, setChildStatus]);

  // ── Refresh button: real Supabase Broadcast ping to the Child node ──────
  const handleRefreshLocation = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsRefreshing(true);

    const ping = async () => {
      let childId = childIdRef.current;
      if (!childId && deviceId) {
        const { data: links } = await supabase
          .from('family_links')
          .select('child_device_id')
          .eq('parent_device_id', deviceId)
          .limit(1);
        childId = links?.[0]?.child_device_id ?? null;
        childIdRef.current = childId;
      }
      if (childId) {
        // Broadcast ping — the channel name MUST match the child's listener
        // exactly: `location-ping-${deviceId}` with NO timestamp suffix. The
        // child subscribes once at mount, so a suffixed name broadcasts into
        // an empty room (the original bug).
        const pingChannel = supabase.channel(`location-ping-${childId}`);
        pingChannel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            void pingChannel.send({ type: 'broadcast', event: 'refresh-location', payload: {} });
            setTimeout(() => supabase.removeChannel(pingChannel), 2000);
          }
        });
        Alert.alert(t('location.requestSent'), t('location.requestSentDesc'));
      } else {
        Alert.alert(t('location.notLinked'), t('location.notLinkedDesc'));
      }
    };

    void ping().finally(() => setTimeout(() => setIsRefreshing(false), 1200));
  };

  // ── Geofencing Logic (client-side Haversine, live coords) ───────────────
  let activeZone: any = null;
  for (const zone of safeZones) {
    const dist = getDistanceFromLatLonInMeters(
      currentCoord.latitude, currentCoord.longitude, zone.lat, zone.lng,
    );
    if (dist <= zone.radius) {
      activeZone = zone;
      break;
    }
  }

  const openAddModal = () => {
    Haptics.selectionAsync();
    if (currentCoord) {
      setNewZoneLat(currentCoord.latitude.toString());
      setNewZoneLng(currentCoord.longitude.toString());
    }
    setNewZoneName('');
    setNewZoneRadius('100');
    setAddModalVisible(true);
  };

  const handleSaveZone = async () => {
    if (!newZoneName.trim() || !newZoneLat || !newZoneLng || !newZoneRadius) {
      Alert.alert(t('common.error'), t('location.fillAllFields'));
      return;
    }

    if (!childProfile?.device_id) {
      Alert.alert(t('common.error'), t('location.childProfileMissing'));
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
      console.error('Failed to sync Safe Zones:', error);
      Alert.alert(t('common.failed'), t('location.saveFailedDesc'));
    }

    setAddModalVisible(false);
  };

  const handleDeleteZone = async (zoneId: string) => {
    Alert.alert(
      t('location.deleteZoneTitle'),
      t('location.deleteZoneConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('location.delete'),
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
              Alert.alert(t('common.failed'), t('location.deleteFailedDesc'));
            }
          }
        }
      ]
    );
  };

  const onAreaLayout = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0 && h !== areaHeight) setAreaHeight(h);
  };

  const zonesHeader = (
    <View style={styles.zonesHeaderRow}>
      <Text style={styles.zonesTitle}>{t('location.safeZones')}</Text>
      <TouchableOpacity style={styles.manageBtn} onPress={openAddModal}>
        <Text style={styles.manageBtnText}>{t('location.manage')}</Text>
        <FontAwesome5 name="cog" size={12} color="#3B82F6" />
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>

      {/* ================================================================
          LAYER 0 — CURVED GRADIENT HEADER (absolute, floats over the map)
          Replicates the app-wide header used on Beranda/Pesan/Atur
          (DynamicGlobalHeader): same gradient, same 24px bottom curvature,
          and a single left-aligned title. overflow:'hidden' clips the
          gradient crisply to the curvature over the native map surface.
          The refresh action lives on the floating child info card only.
          ================================================================ */}
      <LinearGradient
        colors={['#181824', '#11427B', '#007C92']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.header, { paddingTop: insets.top + 10, height: insets.top + HEADER_BASE_HEIGHT }]}
      >
        <Text style={styles.headerTitle}>{t('header.locationTitle')}</Text>
      </LinearGradient>

      {/* ================================================================
          LAYER 1 — MAP (full-bleed, behind header + sheet)
          ================================================================ */}
      <View style={StyleSheet.absoluteFill} onLayout={onAreaLayout}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_GOOGLE}
          initialRegion={{
            latitude: currentCoord.latitude,
            longitude: currentCoord.longitude,
            latitudeDelta: 0.005,
            longitudeDelta: 0.005,
          }}
        >
          {/* Fixed Avatar Pin marker — tracksViewChanges flips off once painted. */}
          <Marker
            coordinate={currentCoord}
            anchor={{ x: 0.5, y: 1 }}
            tracksViewChanges={!markerReady}
          >
            <AvatarPin source={avatarSource} onReady={() => setMarkerReady(true)} />
          </Marker>

          {safeZones.map((zone: any) => (
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

        {/* Floating Child Info Card — sits below the curved header with a
            clear top margin so it never collides with the curvature. */}
        <View
          style={[
            styles.infoCard,
            { top: insets.top + HEADER_BASE_HEIGHT + CARD_TOP_OFFSET },
          ]}
        >
          <View style={styles.cardTopRow}>
            <View style={styles.cardAvatarWrap}>
              <Image source={avatarSource} style={styles.cardAvatar} />
            </View>
            <View style={styles.cardHeaderInfo}>
              <Text style={styles.cardName} numberOfLines={1}>{fullName}</Text>
              <View style={styles.statusBadgeRow}>
                {activeZone ? (
                  <>
                    <FontAwesome5 name="check-circle" size={13} color="#059669" />
                    <Text style={styles.statusBadgeTextSafe} numberOfLines={1}>{t('location.inSafeZone', { zone: activeZone.name })}</Text>
                  </>
                ) : (
                  <>
                    <FontAwesome5 name="exclamation-circle" size={13} color="#DC2626" />
                    <Text style={styles.statusBadgeTextDanger} numberOfLines={1}>{t('location.outsideSafeZone')}</Text>
                  </>
                )}
              </View>
            </View>
            <TouchableOpacity style={styles.refreshButton} onPress={handleRefreshLocation} disabled={isRefreshing} activeOpacity={0.8}>
              {isRefreshing ? (
                <ActivityIndicator size="small" color="#FFF" />
              ) : (
                <FontAwesome5 name="sync-alt" size={16} color="#FFF" />
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.divider} />

          <Text style={styles.locationLabel}>{t('location.lastLocation')}</Text>
          <Text style={styles.locationAddress} numberOfLines={1}>
            {liveAddress || t('location.noAddress')}
          </Text>
          <Text style={styles.timestamp} numberOfLines={1}>
            {t('location.lastUpdate', { time: liveTimestamp || t('common.unknown') })}
          </Text>
        </View>
      </View>

      {/* ================================================================
          LAYER 2 — DRAGGABLE BOTTOM SHEET (snap 25% / 50%, above tab bar)
          The ONLY ScrollView on this screen lives inside this sheet.
          ================================================================ */}
      <LocationBottomSheet
        snapFractions={[0.25, 0.5]}
        viewportHeight={areaHeight}
        bottomOffset={tabBarHeight}
        header={zonesHeader}
      >
        <ScrollView
          contentContainerStyle={styles.sheetScrollContent}
          showsVerticalScrollIndicator={false}
        >
          {safeZones.map((zone: any) => {
            const isCurrentlyHere = activeZone?.id === zone.id;
            return (
              <View key={zone.id} style={styles.zoneItem}>
                <View style={styles.zoneIconWrap}>
                  <FontAwesome5 name="shield-alt" size={16} color={isCurrentlyHere ? "#059669" : "#64748B"} />
                </View>
                <View style={styles.zoneInfo}>
                  <Text style={styles.zoneName}>{zone.name}</Text>
                  <Text style={styles.zoneRadius}>{t('location.radius', { n: zone.radius })}</Text>
                </View>
                {isCurrentlyHere && (
                  <View style={styles.activeZoneTag}>
                    <Text style={styles.activeZoneText}>{t('location.active')}</Text>
                  </View>
                )}
                <TouchableOpacity onPress={() => handleDeleteZone(zone.id)} style={styles.deleteZoneBtn}>
                  <FontAwesome5 name="trash" size={14} color="#EF4444" />
                </TouchableOpacity>
              </View>
            );
          })}
        </ScrollView>
      </LocationBottomSheet>

      {/* Smart Add Modal */}
      <Modal visible={isAddModalVisible} transparent animationType="fade">
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t('location.addZone')}</Text>
              <TouchableOpacity onPress={() => setAddModalVisible(false)}>
                <FontAwesome5 name="times" size={20} color="#94A3B8" />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>{t('location.placeName')}</Text>
            <TextInput
              style={styles.modalInput}
              placeholder={t('location.placeNamePlaceholder')}
              value={newZoneName}
              onChangeText={setNewZoneName}
            />

            <View style={styles.rowInputs}>
              <View style={styles.flex1}>
                <Text style={styles.inputLabel}>{t('location.latitude')}</Text>
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
                <Text style={styles.inputLabel}>{t('location.longitude')}</Text>
                <TextInput
                  style={[styles.modalInput, styles.inputDisabled]}
                  value={newZoneLng}
                  onChangeText={setNewZoneLng}
                  keyboardType="numeric"
                  editable={false} // Auto-filled
                />
              </View>
            </View>

            <Text style={styles.inputLabel}>{t('location.radiusLabel')}</Text>
            <TextInput
              style={styles.modalInput}
              value={newZoneRadius}
              onChangeText={setNewZoneRadius}
              keyboardType="numeric"
            />

            <TouchableOpacity style={styles.saveBtn} onPress={handleSaveZone}>
              <Text style={styles.saveBtnText}>{t('location.saveZone')}</Text>
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
    backgroundColor: '#F8FAFC',
  },
  /* --- LAYER 0: CURVED GRADIENT HEADER --- */
  // Same curvature recipe as the shared DynamicGlobalHeader (Pengaturan):
  // 24px bottom radii + overflow hidden so the gradient clips smoothly to
  // the curve instead of bleeding square corners over the map surface.
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 24,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    overflow: 'hidden',
    zIndex: 5,
    // No elevation: the header floats over the map; shadows near the surface
    // are unnecessary and the gradient + curvature carry the design.
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  /* --- LAYER 1: MAP + FLOATING INFO CARD --- */
  infoCard: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 14,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardAvatarWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 2,
    borderColor: '#DBEAFE',
    overflow: 'hidden',
    marginRight: 12,
  },
  cardAvatar: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
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
  /* --- LAYER 2: BOTTOM SHEET CONTENT --- */
  zonesHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: 2,
    marginBottom: 4,
    paddingHorizontal: 16,
    paddingVertical: 6,
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
  sheetScrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 16,
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