import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import Toast from 'react-native-toast-message';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width } = Dimensions.get('window');

export default function DynamicParentHeader() {
  const insets = useSafeAreaInsets();
  const handleSettingsPress = () => {
    Toast.show({
      type: 'info',
      text1: 'Segera Hadir',
      text2: 'Pengaturan akun Orang Tua sedang dalam tahap pengembangan.',
      position: 'top',
    });
  };

  return (
    <LinearGradient 
      colors={['#181824', '#11427B', '#007C92']} 
      style={[styles.container, { paddingTop: insets.top + 20 }]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
    >
      <View style={styles.headerTop}>
        <Text style={styles.title}>Beranda</Text>
        
        <View style={styles.iconGroup}>
          <TouchableOpacity style={styles.iconButton}>
            <FontAwesome5 name="bell" size={20} color="#FFFFFF" />
            <View style={styles.badge}>
              <Text style={styles.badgeText}>2</Text>
            </View>
          </TouchableOpacity>

          <TouchableOpacity style={styles.iconButton} onPress={handleSettingsPress}>
            <FontAwesome5 name="cog" size={22} color="#FFFFFF" />
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
    height: 220, // Fixed height for overlap math
    paddingHorizontal: 24,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    zIndex: 1,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.5,
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
