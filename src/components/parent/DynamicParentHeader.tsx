import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';

import { useTranslation } from '../../i18n';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'react-native';

const { width } = Dimensions.get('window');

interface HeaderProps {
  childProfile: any;
  isOnline: boolean;
  lastSeen: string | null;
}

export default function DynamicParentHeader({ childProfile, isOnline, lastSeen }: HeaderProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  return (
    <LinearGradient 
      colors={['#181824', '#11427B', '#007C92']} 
      style={[styles.container, { paddingTop: insets.top + 20 }]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
    >
      <View style={styles.headerTop}>
        <View style={styles.profileSection}>
          <View style={styles.avatarContainer}>
            <Image 
              source={childProfile?.gender === 'Girl' ? require('../../../assets/icon.png') : require('../../../assets/icon.png')} 
              style={styles.avatarImage} 
            />
          </View>
          <View style={styles.childInfo}>
            <Text style={styles.childName} numberOfLines={1} ellipsizeMode="tail">
              {childProfile?.fullName || childProfile?.name || childProfile?.nickname || t('header.childFallback')}
            </Text>
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: isOnline ? '#34C759' : '#94A3B8' }]} />
              <Text style={[styles.statusText, { color: isOnline ? '#34C759' : '#94A3B8' }]}>
                {isOnline ? t('common.online') : t('common.offline')}
              </Text>
            </View>
            <Text style={styles.lastSeenText}>
              {t('header.lastActive', { time: isOnline ? t('header.now') : (lastSeen || t('common.unknown')) })}
            </Text>
          </View>
        </View>
        
        <View style={styles.iconGroup}>
          <TouchableOpacity style={[styles.iconButton, { alignSelf: 'flex-start', marginTop: 4 }]}>
            <FontAwesome5 name="bell" size={20} color="#FFFFFF" />
            <View style={styles.badge}>
              <Text style={styles.badgeText}>2</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>
      
      {/* Empty space to allow the overlapping card to sit on top of the gradient */}
      <View style={{ height: 60 }} /> 
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    width: width,
    height: 180, // Reduced from 220
    paddingHorizontal: 24,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    zIndex: 1,
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
    maxWidth: width - 130, // Prevent text from pushing the bell icon off screen
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
  }
});
