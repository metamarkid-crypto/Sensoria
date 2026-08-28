import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5, Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import PairingBottomSheet from '../components/PairingBottomSheet';

export default function SettingsScreen() {
  const navigation = useNavigation<any>();
  const [showPairing, setShowPairing] = useState(false);

  const MENU_ITEMS = [
    { id: 'profile', title: 'Profil Pengguna', icon: 'person', type: 'Ionicons', action: () => navigation.navigate('UserProfile') },
    { id: 'audio', title: 'Suara & Bicara', icon: 'volume-high', type: 'Ionicons', action: () => navigation.navigate('VoiceSettings') },
    { id: 'display', title: 'Tampilan', icon: 'color-palette', type: 'Ionicons', action: () => navigation.navigate('AppearanceSettings') },
    { id: 'accessibility', title: 'Aksesibilitas', icon: 'accessibility', type: 'Ionicons', action: () => navigation.navigate('AccessibilitySettings') },
    { id: 'pairing', title: 'Koneksi & Perangkat', icon: 'link', type: 'Ionicons', action: () => setShowPairing(true) },
    { id: 'about', title: 'Tentang Sensoria AAC', icon: 'information-circle', type: 'Ionicons', action: () => navigation.navigate('AboutScreen') },
  ];

  const showComingSoon = () => {
    Toast.show({
      type: 'info',
      text1: 'Segera Hadir',
      text2: 'Fitur ini sedang dalam tahap pengembangan.',
      position: 'bottom',
    });
  };

  const renderIcon = (type: string, name: string) => {
    if (type === 'Ionicons') return <Ionicons name={name as any} size={22} color="#2488FF" />;
    if (type === 'MaterialIcons') return <MaterialIcons name={name as any} size={22} color="#2488FF" />;
    return <FontAwesome5 name={name} size={20} color="#2488FF" />;
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#1A2980" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Pengaturan</Text>
        <View style={{ width: 40 }} /> {/* Spacer */}
      </View>

      {/* Menu List */}
      <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scrollContent}>
        <View style={styles.card}>
          {MENU_ITEMS.map((item, index) => (
            <TouchableOpacity 
              key={item.id} 
              style={[styles.menuItem, index === MENU_ITEMS.length - 1 && styles.lastMenuItem]}
              onPress={item.action}
            >
              <View style={styles.menuItemLeft}>
                <View style={styles.iconBox}>
                  {renderIcon(item.type, item.icon)}
                </View>
                <Text style={styles.menuItemTitle}>{item.title}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color="#CBD5E1" />
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {/* Reusable Pairing Bottom Sheet */}
      <PairingBottomSheet 
        isVisible={showPairing} 
        onClose={() => setShowPairing(false)} 
      />
      
      <Toast />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1A2980',
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 3,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  lastMenuItem: {
    borderBottomWidth: 0,
  },
  menuItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#F0F8FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  menuItemTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#334155',
  },
});
