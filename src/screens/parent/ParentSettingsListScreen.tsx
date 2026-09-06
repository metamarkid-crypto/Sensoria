import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import PairingBottomSheet from '../../components/PairingBottomSheet';
import { useAACStore } from '../../store/useAACStore';
import { formatDate } from '../../utils/format';

type FontAwesomeIconName = React.ComponentProps<typeof FontAwesome5>['name'];

interface SettingsItem {
  id: string;
  title: string;
  subtitle?: string;
  icon: FontAwesomeIconName;
  iconColor: string;
  iconBg: string;
  route?: string;
  /** Review-mode placeholder row: rendered but never navigates. */
  disabled?: boolean;
}

export default function ParentSettingsListScreen() {
  const navigation = useNavigation<any>();
  const [showPairing, setShowPairing] = useState(false);

  // ── Stealth kill-switch (App Review mandate) ───────────────────────────────
  // Reads the SHARED store flag, refreshed by the app lifecycle on boot and
  // every foreground resume (see App.tsx / useAACStore). Fails safe to the
  // inert placeholder below — an unknown state NEVER surfaces the paywall.
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

  // Live mode → tappable row that opens the Paywall (which independently
  // re-verifies the kill-switch before ever showing pricing).
  // Review mode → inert, non-clickable placeholder. No route, no navigation.
  const subscriptionItem: SettingsItem = liveMode
    ? {
        id: 'premium',
        title: 'Status Langganan',
        subtitle: subscriptionSubtitle,
        icon: 'crown',
        iconColor: '#D97706',
        iconBg: '#FFFBEB',
        route: 'Paywall',
      }
    : {
        id: 'premium',
        title: 'Premium',
        subtitle: subscriptionSubtitle,
        icon: 'lock',
        iconColor: '#94A3B8',
        iconBg: '#F8FAFC',
        disabled: true,
      };

  // Hierarchy: billing sits LOW in the list — directly above "Tentang Sensoria
  // AAC" and slightly separated from the functional settings — so an
  // accessibility/medical app never opens on a sales pitch.
  const mainSettingsItems: SettingsItem[] = [
    { id: '1', title: 'Profil Pengguna', icon: 'user', iconColor: '#11427B', iconBg: '#F0F9FF', route: 'UserProfile' },
    { id: '2', title: 'Suara & Bicara', icon: 'volume-up', iconColor: '#11427B', iconBg: '#F0F9FF', route: 'VoiceSettings' },
    { id: '3', title: 'Tampilan', icon: 'palette', iconColor: '#11427B', iconBg: '#F0F9FF', route: 'AppearanceSettings' },
    { id: '4', title: 'Aksesibilitas', icon: 'universal-access', iconColor: '#11427B', iconBg: '#F0F9FF', route: 'AccessibilitySettings' },
    { id: '5', title: 'Koneksi & Perangkat', icon: 'link', iconColor: '#11427B', iconBg: '#F0F9FF', route: 'ConnectionModal' },
  ];

  const aboutItem: SettingsItem = {
    id: '6',
    title: 'Tentang Sensoria AAC',
    icon: 'info-circle',
    iconColor: '#11427B',
    iconBg: '#F0F9FF',
    route: 'AboutScreen',
  };

  const handlePress = (item: SettingsItem) => {
    if (item.disabled || !item.route) return;
    if (item.route === 'ConnectionModal') {
      setShowPairing(true);
    } else {
      navigation.navigate(item.route);
    }
  };

  const renderRow = (item: SettingsItem, showDivider: boolean) => (
    <TouchableOpacity
      key={item.id}
      style={[styles.itemRow, showDivider && styles.borderBottom]}
      onPress={() => handlePress(item)}
      activeOpacity={0.7}
      disabled={item.disabled}
    >
      <View style={styles.itemLeft}>
        <View style={[styles.iconBox, { backgroundColor: item.iconBg }]}>
          <FontAwesome5 name={item.icon} size={16} color={item.iconColor} />
        </View>
        <View style={styles.itemText}>
          <Text style={[styles.itemTitle, item.disabled && styles.itemTitleDisabled]}>{item.title}</Text>
          {item.subtitle ? (
            <Text style={styles.itemSubtitle} numberOfLines={1}>{item.subtitle}</Text>
          ) : null}
        </View>
      </View>
      {item.disabled ? (
        <View style={styles.soonBadge}>
          <Text style={styles.soonBadgeText}>Segera</Text>
        </View>
      ) : (
        <FontAwesome5 name="chevron-right" size={14} color="#CBD5E1" />
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        
        {/* Functional settings — the core of the app, first. */}
        <View style={styles.card}>
          {mainSettingsItems.map((item, index) =>
            renderRow(item, index !== mainSettingsItems.length - 1)
          )}
        </View>

        {/* Account & billing, deliberately quiet and low in the hierarchy. */}
        <View style={[styles.card, styles.groupGap]}>
          {renderRow(subscriptionItem, true)}
          {renderRow(aboutItem, false)}
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
    backgroundColor: '#F8FAFC', // Or #FFFFFF depending on design
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    marginTop: -60,
    zIndex: 10,
    elevation: 5,
  },
  content: {
    padding: 20,
    paddingTop: 32, 
    paddingBottom: 100, 
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
  },
  itemText: {
    flex: 1,
  },
  itemSubtitle: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 2,
  },
  itemTitleDisabled: {
    color: '#94A3B8',
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
  }
});
