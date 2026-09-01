import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Dimensions, Image, TouchableOpacity } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { FontAwesome5, Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAACStore } from '../../store/useAACStore';
import { supabase } from '../../services/db/supabase';

const { width } = Dimensions.get('window');

interface HeaderProps {
  routeName: string;
}

export default function DynamicGlobalHeader({ routeName }: HeaderProps) {
  const insets = useSafeAreaInsets();
  const { childProfile, childStatus } = useAACStore();
  const { isOnline, lastSeen } = childStatus;

  const fullName = childProfile?.fullName || childProfile?.name || childProfile?.nickname || 'Belum ditautkan';
  const avatarSource = childProfile?.gender === 'Girl' ? require('../../../assets/icon.png') : require('../../../assets/icon.png');

  // Height Shapeshifting logic
  const isHome = routeName === 'Beranda';
  const headerHeight = isHome ? 180 : 120 + insets.top;

  const renderHomeContent = () => (
    <View style={styles.headerTop}>
      <View style={styles.profileSection}>
        <View style={styles.avatarContainer}>
          <Image source={avatarSource} style={styles.avatarImage} />
        </View>
        <View style={styles.childInfo}>
          <Text style={styles.childName} numberOfLines={1} ellipsizeMode="tail">
            {fullName}
          </Text>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: isOnline ? '#34C759' : '#94A3B8' }]} />
            <Text style={[styles.statusText, { color: isOnline ? '#34C759' : '#94A3B8' }]}>
              {isOnline ? 'Online' : 'Offline'}
            </Text>
          </View>
          <Text style={styles.lastSeenText}>
            Terakhir aktif: {isOnline ? 'Sekarang' : (lastSeen || 'Belum diketahui')}
          </Text>
        </View>
      </View>
      <View style={styles.iconGroup}>
        <TouchableOpacity style={[styles.iconButton, { alignSelf: 'flex-start', marginTop: 4 }]}>
          <FontAwesome5 name="bell" size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderMessagesContent = () => (
    <View style={styles.rowHeader}>
      <View style={styles.smallAvatarContainer}>
        <Image source={avatarSource} style={styles.smallAvatarImage} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.smallTitle} numberOfLines={1} ellipsizeMode="tail">{fullName}</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { width: 6, height: 6, borderRadius: 3, backgroundColor: isOnline ? '#34C759' : '#94A3B8' }]} />
          <Text style={[styles.statusText, { fontSize: 11, color: isOnline ? '#34C759' : '#94A3B8' }]}>
            {isOnline ? 'Online' : lastSeen ? `Aktif ${lastSeen} lalu` : 'Offline'}
          </Text>
        </View>
      </View>
    </View>
  );

  const renderLocationContent = () => (
    <View style={styles.rowHeaderBetween}>
      <Text style={styles.centerTitle}>Lokasi</Text>
      <TouchableOpacity style={styles.iconButton}>
        <Ionicons name="reload" size={22} color="#FFFFFF" />
      </TouchableOpacity>
    </View>
  );

  const renderSettingsContent = () => (
    <View style={styles.rowHeader}>
      <Text style={styles.centerTitle}>Pengaturan</Text>
    </View>
  );

  return (
    <LinearGradient 
      colors={['#181824', '#11427B', '#007C92']} 
      style={[styles.container, { paddingTop: insets.top + (isHome ? 20 : 10), height: headerHeight }]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
    >
      {routeName === 'Beranda' && renderHomeContent()}
      {routeName === 'Pesan' && renderMessagesContent()}
      {routeName === 'Lokasi' && renderLocationContent()}
      {routeName === 'Atur' && renderSettingsContent()}
      <View style={{ height: 60 }} />
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    width: width,
    paddingHorizontal: 24,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    zIndex: 1,
    justifyContent: 'flex-start',
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  profileSection: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarContainer: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    borderWidth: 2,
    borderColor: '#4F46E5',
    overflow: 'hidden',
  },
  avatarImage: {
    width: 46,
    height: 46,
    borderRadius: 23,
    resizeMode: 'cover',
  },
  childInfo: {
    justifyContent: 'center',
    maxWidth: width - 130,
  },
  childName: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginBottom: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  lastSeenText: {
    fontSize: 11,
    color: '#CBD5E1',
  },
  iconGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  iconButton: {
    position: 'relative',
    padding: 4,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#FF3B30',
    width: 18,
    height: 18,
    borderRadius: 9,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#11427B',
  },
  badgeText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: 'bold',
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  rowHeaderBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flex: 1,
  },
  rowHeaderCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  smallAvatarContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginRight: 12,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: '#4F46E5',
    backgroundColor: '#FFF',
  },
  smallAvatarImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  smallTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  centerTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#FFFFFF',
  }
});
