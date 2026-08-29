import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Dimensions, ActivityIndicator } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';
import * as Location from 'expo-location';

const { width, height } = Dimensions.get('window');

export default function ParentLocationScreen() {
  const insets = useSafeAreaInsets();
  const { deviceId, childProfile } = useAACStore();
  
  const [childLocation, setChildLocation] = useState<any>(null);
  const [address, setAddress] = useState<string>('Mencari lokasi...');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!deviceId) return;

    const fetchChildLocation = async () => {
      // Find linked child
      const { data: link } = await supabase
        .from('family_links')
        .select('child_device_id')
        .eq('parent_device_id', deviceId)
        .single();
        
      if (!link) {
        setLoading(false);
        return;
      }

      // Fetch location
      const { data: device } = await supabase
        .from('devices')
        .select('latitude, longitude, last_seen')
        .eq('id', link.child_device_id)
        .single();

      if (device && device.latitude && device.longitude) {
        setChildLocation(device);
        // Reverse geocode
        try {
          const geocode = await Location.reverseGeocodeAsync({
            latitude: device.latitude,
            longitude: device.longitude
          });
          
          if (geocode && geocode.length > 0) {
            const addr = geocode[0];
            setAddress(`${addr.street || addr.name}, ${addr.city || addr.region}`);
          } else {
            setAddress('Lokasi ditemukan');
          }
        } catch (e) {
          setAddress('Koordinat GPS tersedia');
        }
      }
      setLoading(false);
    };

    fetchChildLocation();

    // Set up real-time listener for location updates
    let presenceSub: any = null;
    const setupListener = async () => {
      const { data: link } = await supabase.from('family_links').select('child_device_id').eq('parent_device_id', deviceId).single();
      if (!link) return;

      presenceSub = supabase.channel('location_updates')
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'devices',
          filter: `id=eq.${link.child_device_id}`
        }, async (payload) => {
          if (payload.new.latitude && payload.new.longitude) {
            setChildLocation(payload.new);
            try {
              const geocode = await Location.reverseGeocodeAsync({
                latitude: payload.new.latitude,
                longitude: payload.new.longitude
              });
              if (geocode && geocode.length > 0) {
                const addr = geocode[0];
                setAddress(`${addr.street || addr.name}, ${addr.city || addr.region}`);
              }
            } catch (e) {}
          }
        }).subscribe();
    };

    setupListener();

    return () => {
      if (presenceSub) supabase.removeChannel(presenceSub);
    };
  }, [deviceId]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#00B5B8" />
        <Text style={{ marginTop: 12, color: '#11427B', fontWeight: 'bold' }}>Melacak Perangkat Anak...</Text>
      </View>
    );
  }

  if (!childLocation) {
    return (
      <View style={styles.center}>
        <FontAwesome5 name="map-marker-slash" size={48} color="#94A3B8" />
        <Text style={styles.emptyText}>Data lokasi anak belum tersedia.</Text>
        <Text style={styles.emptySubText}>Pastikan aplikasi anak sedang aktif.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        initialRegion={{
          latitude: childLocation.latitude,
          longitude: childLocation.longitude,
          latitudeDelta: 0.005,
          longitudeDelta: 0.005,
        }}
        showsUserLocation={true} // Shows parent's location too
      >
        <Marker
          coordinate={{
            latitude: childLocation.latitude,
            longitude: childLocation.longitude,
          }}
          title={childProfile?.nickname || "Anak"}
          description="Lokasi Terakhir"
        >
          <View style={styles.customMarker}>
            <Text style={styles.markerEmoji}>{childProfile?.gender === 'Girl' ? '👧🏻' : '👦🏻'}</Text>
          </View>
          <View style={styles.markerTriangle} />
        </Marker>
      </MapView>

      {/* Floating Info Card */}
      <View style={[styles.infoCard, { bottom: insets.bottom + 80 }]}>
        <View style={styles.cardHeader}>
          <FontAwesome5 name="map-marker-alt" size={20} color="#00B5B8" />
          <Text style={styles.cardTitle}>Lokasi Terakhir</Text>
        </View>
        <Text style={styles.addressText}>{address}</Text>
        
        <View style={styles.statusRow}>
          <View style={styles.safeZoneBadge}>
            <View style={styles.dot} />
            <Text style={styles.safeZoneText}>Area Aman</Text>
          </View>
          <Text style={styles.timeText}>
            Diperbarui: {new Date(childLocation.last_seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
  },
  map: {
    width: width,
    height: height,
  },
  customMarker: {
    backgroundColor: '#FFF',
    padding: 8,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: '#00B5B8',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  markerEmoji: {
    fontSize: 24,
  },
  markerTriangle: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 12,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#00B5B8',
    alignSelf: 'center',
    transform: [{ rotate: '180deg' }],
    marginTop: -2,
  },
  infoCard: {
    position: 'absolute',
    left: 20,
    right: 20,
    backgroundColor: '#FFF',
    borderRadius: 20,
    padding: 20,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 10,
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#64748B',
    textTransform: 'uppercase',
  },
  addressText: {
    fontSize: 20,
    fontWeight: '900',
    color: '#11427B',
    marginBottom: 16,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 16,
  },
  safeZoneBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#D1FAE5',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#059669',
    marginRight: 6,
  },
  safeZoneText: {
    color: '#059669',
    fontWeight: 'bold',
    fontSize: 12,
  },
  timeText: {
    fontSize: 12,
    color: '#94A3B8',
    fontWeight: 'bold',
  },
  emptyText: {
    marginTop: 16,
    fontSize: 18,
    fontWeight: 'bold',
    color: '#334155',
  },
  emptySubText: {
    marginTop: 8,
    fontSize: 14,
    color: '#94A3B8',
  }
});
