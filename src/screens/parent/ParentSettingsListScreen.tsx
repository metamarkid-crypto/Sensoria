import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import PairingBottomSheet from '../../components/PairingBottomSheet';

export default function ParentSettingsListScreen() {
  const navigation = useNavigation<any>();
  const [showPairing, setShowPairing] = useState(false);

  const settingsItems = [
    { id: '1', title: 'Profil Pengguna', icon: 'user', route: 'UserProfile' },
    { id: '2', title: 'Suara & Bicara', icon: 'volume-up', route: 'VoiceSettings' },
    { id: '3', title: 'Tampilan', icon: 'palette', route: 'AppearanceSettings' },
    { id: '4', title: 'Aksesibilitas', icon: 'universal-access', route: 'AccessibilitySettings' },
    { id: '5', title: 'Koneksi & Perangkat', icon: 'link', route: 'ConnectionModal' },
    { id: '6', title: 'Tentang Sensoria AAC', icon: 'info-circle', route: 'AboutScreen' },
  ];

  const handlePress = (route: string) => {
    if (route === 'ConnectionModal') {
      setShowPairing(true);
    } else if (route) {
      navigation.navigate(route);
    }
  };

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        
        <View style={styles.card}>
          {settingsItems.map((item, index) => (
            <TouchableOpacity 
              key={item.id} 
              style={[styles.itemRow, index !== settingsItems.length - 1 && styles.borderBottom]}
              onPress={() => handlePress(item.route)}
              activeOpacity={0.7}
            >
              <View style={styles.itemLeft}>
                <View style={styles.iconBox}>
                  <FontAwesome5 name={item.icon} size={16} color="#11427B" />
                </View>
                <Text style={styles.itemTitle}>{item.title}</Text>
              </View>
              <FontAwesome5 name="chevron-right" size={14} color="#CBD5E1" />
            </TouchableOpacity>
          ))}
        </View>
        
      </ScrollView>

      {/* The Exception: Connections and Devices uses the existing Modal Bottom Sheet */}
      <PairingBottomSheet 
        isVisible={showPairing} 
        onClose={() => setShowPairing(false)} 
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingTop: 32, // Some top padding so it doesn't hug the header
    paddingBottom: 100, // Room for bottom tabs
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    paddingHorizontal: 16,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 18,
  },
  borderBottom: {
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  itemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: '#F0F9FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  itemTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0F172A',
  }
});
