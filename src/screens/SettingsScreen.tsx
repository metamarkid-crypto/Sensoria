import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5, Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import Toast from 'react-native-toast-message';
import PairingBottomSheet from '../components/PairingBottomSheet';
import { useAACStore } from '../store/useAACStore';
import { formatDate } from '../utils/format';

export default function SettingsScreen() {
  const navigation = useNavigation<any>();
  const [showPairing, setShowPairing] = useState(false);

  // ── Stealth kill-switch — EXACT mirror of ParentSettingsListScreen ─────────
  // Reads the SHARED store flag, refreshed by the app lifecycle on boot and
  // every foreground resume (see App.tsx / useAACStore). Fails safe to the
  // inert placeholder below — an unknown state NEVER surfaces the paywall.
  //
  // Protocol note: this is a PROACTIVE entry only. It never appears as a
  // forced lock response — the Child's expired/grace soft-lock path
  // (ChildAACScreen) stays free of pricing, preserving "Compassionate Child".
  const webPaymentActive = useAACStore((s) => s.webPaymentActive);
  const webPaymentLoaded = useAACStore((s) => s.webPaymentLoaded);
  const premium = useAACStore((s) => s.premium);

  const liveMode = webPaymentActive === true && webPaymentLoaded;

  // Optional status subtitle (live mode only — never surfaces in review).
  const subscriptionSubtitle = liveMode
    ? premium.status === 'trial' && premium.isPremium
      ? `Masa Coba Gratis · aktif sampai ${formatDate(premium.trialEndsAt)}`
      : premium.status === 'active' && premium.isPremium
        ? `Aktif sampai ${formatDate(premium.expiresAt)}`
        : premium.loaded
          ? 'Langganan belum aktif'
          : 'Lihat paket langganan'
    : 'Segera Hadir';

  const MENU_ITEMS = [
    { id: 'profile', title: 'Profil Pengguna', icon: 'person', type: 'Ionicons', action: () => navigation.navigate('UserProfile') },
    { id: 'audio', title: 'Suara & Bicara', icon: 'volume-high', type: 'Ionicons', action: () => navigation.navigate('VoiceSettings') },
    { id: 'display', title: 'Tampilan', icon: 'color-palette', type: 'Ionicons', action: () => navigation.navigate('AppearanceSettings') },
    { id: 'accessibility', title: 'Aksesibilitas', icon: 'accessibility', type: 'Ionicons', action: () => navigation.navigate('AccessibilitySettings') },
    { id: 'pairing', title: 'Koneksi & Perangkat', icon: 'link', type: 'Ionicons', action: () => setShowPairing(true) },
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
        {/* Functional settings — the core of the app, first. */}
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
                <View style={styles.menuItemText}>
                  <Text style={styles.menuItemTitle}>{item.title}</Text>
                </View>
              </View>
              <Ionicons name="chevron-forward" size={20} color="#CBD5E1" />
            </TouchableOpacity>
          ))}
        </View>

        {/* Account & billing — mirrored from ParentSettingsListScreen: billing
            sits LOW in the hierarchy, directly above "Tentang Sensoria AAC",
            slightly separated from the functional settings. */}
        <View style={[styles.card, styles.groupGap]}>
          {/* Live mode → tappable row that opens the Paywall modal (registered
              on the Child stack in AppNavigator). Review mode → inert,
              non-clickable placeholder. No navigation, no pricing. */}
          <TouchableOpacity
            style={styles.menuItem}
            onPress={() => navigation.navigate('Paywall')}
            activeOpacity={0.7}
            disabled={!liveMode}
          >
            <View style={styles.menuItemLeft}>
              <View
                style={[
                  styles.iconBox,
                  liveMode ? styles.iconBoxPremium : styles.iconBoxLocked,
                ]}
              >
                {liveMode ? (
                  <FontAwesome5 name="crown" size={16} color="#D97706" />
                ) : (
                  <FontAwesome5 name="lock" size={16} color="#94A3B8" />
                )}
              </View>
              <View style={styles.menuItemText}>
                <Text style={[styles.menuItemTitle, !liveMode && styles.menuItemTitleDisabled]}>
                  {liveMode ? 'Status Langganan' : 'Premium'}
                </Text>
                <Text style={styles.menuItemSubtitle} numberOfLines={1}>
                  {subscriptionSubtitle}
                </Text>
              </View>
            </View>
            {liveMode ? (
              <Ionicons name="chevron-forward" size={20} color="#CBD5E1" />
            ) : (
              <View style={styles.soonBadge}>
                <Text style={styles.soonBadgeText}>Segera</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.menuItem, styles.lastMenuItem]}
            onPress={() => navigation.navigate('AboutScreen')}
          >
            <View style={styles.menuItemLeft}>
              <View style={styles.iconBox}>
                <Ionicons name="information-circle" size={22} color="#2488FF" />
              </View>
              <View style={styles.menuItemText}>
                <Text style={styles.menuItemTitle}>Tentang Sensoria AAC</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#CBD5E1" />
          </TouchableOpacity>
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
    // Overflow guard (same fix as ParentSettingsListScreen): bound the left
    // cluster so a long subtitle truncates instead of pushing the chevron /
    // badge off-screen.
    flex: 1,
    marginRight: 8,
  },
  menuItemText: {
    flex: 1,
  },
  menuItemSubtitle: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 2,
  },
  menuItemTitleDisabled: {
    color: '#94A3B8',
  },
  iconBoxPremium: {
    backgroundColor: '#FFFBEB', // amber-50 behind the amber-600 crown
  },
  iconBoxLocked: {
    backgroundColor: '#F8FAFC',
  },
  soonBadge: {
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    paddingVertical: 3,
    paddingHorizontal: 10,
  },
  soonBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
  },
  groupGap: {
    marginTop: 16,
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
