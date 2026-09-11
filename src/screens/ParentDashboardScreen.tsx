import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { FontAwesome5 } from '@expo/vector-icons';
import { evaluateAccess } from '../services/db/entitlement';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';
import { playTTS } from '../services/ai/audioManager';
import * as Haptics from 'expo-haptics';
import { useTranslation } from '../i18n';

import ParentHomeScreen from './parent/ParentHomeScreen';
import ParentMessagesScreen from './parent/ParentMessagesScreen';
import ParentLocationScreen from './parent/ParentLocationScreen';
import ParentSettingsListScreen from './parent/ParentSettingsListScreen';
import DynamicGlobalHeader from '../components/parent/DynamicGlobalHeader';

const Tab = createBottomTabNavigator();

export default function ParentDashboardScreen() {
  const { t } = useTranslation();
  const { pairingCode, language, deviceId, setChildStatus } = useAACStore();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const premium = useAACStore((s) => s.premium);
  const role = useAACStore((s) => s.role);
  const refreshEntitlement = useAACStore((s) => s.refreshEntitlement);

  // ── Strict Parent gating ("Compassionate Child, Strict Parent") ──────────
  // Zero offline tolerance: a locked parent is locked even offline. Local
  // expiry boundaries come from persisted state, evaluated against NOW.
  const parentAccess = role === 'Parent'
    ? evaluateAccess(premium, 'Parent', Date.now())
    : null;
  const parentLocked = parentAccess?.phase === 'locked';
  const parentOffline = parentLocked && premium.lastError != null;

  // Show the Paywall once per lock episode (it honors web_payment_active
  // itself). If dismissed without paying, the lock view below remains.
  const paywallShownRef = useRef(false);
  useEffect(() => {
    if (!parentLocked) {
      paywallShownRef.current = false;
      return;
    }
    if (!parentOffline && !paywallShownRef.current) {
      paywallShownRef.current = true;
      navigation.navigate('Paywall');
    }
  }, [parentLocked, parentOffline, navigation]);

  useEffect(() => {
    if (parentLocked) return; // locked parents must not keep live channels
    if (!pairingCode) return;

    // Global Real-Time TTS Pager
    const subscription = supabase.channel('global_parent_tts_pager')
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${pairingCode}`
      }, (payload) => {
        // Ensure we only speak messages from the child
        if (payload.new.sender_role === 'Child') {
          playTTS(payload.new.text_content, language, 'Child');
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(subscription); // Safeguard against memory leaks
    };
  }, [pairingCode, language, parentLocked]);

  useEffect(() => {
    // 2. Global Real-time Connection Status Listener
    let presenceSub: any = null;
    if (parentLocked) return; // locked parents must not poll presence

    const checkStatus = async () => {
      if (!deviceId) return;
      const { data: link } = await supabase
        .from('family_links')
        .select('child_device_id')
        .eq('parent_device_id', deviceId)
        .single();
        
      if (!link) return;

      const updateOnlineStatus = (lastSeenTimestamp: string, lat: number | null, lng: number | null, lastAddress: string | null) => {
        const lastActive = new Date(lastSeenTimestamp);
        const diffMins = Math.floor((new Date().getTime() - lastActive.getTime()) / 60000);
        
        let isOnline = false;
        let lastSeenStr = t('header.now');
        
        if (diffMins < 5) {
          isOnline = true;
        } else {
          lastSeenStr = t('header.minutesAgo', { n: diffMins });
        }
        
        setChildStatus({ isOnline, lastSeen: lastSeenStr, lat, lng, lastAddress });
      };

      const fetchPresence = async () => {
        const { data } = await supabase.from('devices').select('last_seen, latitude, longitude, last_address').eq('id', link.child_device_id).single();
        if (data && data.last_seen) {
          updateOnlineStatus(data.last_seen, data.latitude, data.longitude, data.last_address);
        }
      };
      await fetchPresence();

      presenceSub = supabase.channel('global_presence')
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'devices',
          filter: `id=eq.${link.child_device_id}`
        }, (payload) => {
          if (payload.new.last_seen) {
            updateOnlineStatus(payload.new.last_seen, payload.new.latitude, payload.new.longitude, payload.new.last_address);
          }
        }).subscribe();
    };

    checkStatus();
    return () => {
      if (presenceSub) supabase.removeChannel(presenceSub);
    };
  }, [deviceId, parentLocked]);

  // Strict Parent lock — evaluated AFTER every hook so hook order stays stable
  // across lock/unlock transitions.
  if (parentLocked) {
    return (
      <ParentStrictLock
        offline={parentOffline}
        onRetry={() => void refreshEntitlement()}
        onExtend={() => navigation.navigate('Paywall')}
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#F5F7FA' }}>
      <StatusBar style="light" />
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: true,
          header: ({ route }) => <DynamicGlobalHeader routeName={route.name} />,
          tabBarIcon: ({ color, size }) => {
            let iconName = '';

            if (route.name === 'Beranda') {
              iconName = 'home';
            } else if (route.name === 'Pesan') {
              iconName = 'comment-dots';
            } else if (route.name === 'Lokasi') {
              iconName = 'map-marker-alt';
            } else if (route.name === 'Atur') {
              iconName = 'cog';
            }

            return (
              <View style={{ position: 'relative', justifyContent: 'center', alignItems: 'center' }}>
                <FontAwesome5 name={iconName} size={size} color={color} />
              </View>
            );
          },
          tabBarActiveTintColor: '#11427B', // Navy Blue for active
          tabBarInactiveTintColor: '#94A3B8', // Gray for inactive
          tabBarStyle: {
            backgroundColor: '#FFFFFF',
            borderTopWidth: 0,
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            position: 'absolute', // Needed for border radius on bottom tabs
            bottom: 0,
            left: 0,
            right: 0,
            height: 70 + insets.bottom,
            paddingBottom: insets.bottom > 0 ? insets.bottom : 12,
            paddingTop: 8,
            elevation: 10,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: -2 },
            shadowOpacity: 0.1,
            shadowRadius: 4,
          },
          tabBarLabelStyle: {
            fontWeight: 'bold',
            fontSize: 12,
          }
        })}
      >
        <Tab.Screen name="Beranda" component={ParentHomeScreen} options={{ tabBarLabel: t('tabs.home') }} />
        <Tab.Screen name="Pesan" component={ParentMessagesScreen} options={{ tabBarLabel: t('tabs.messages') }} />
        {/* Lokasi renders its own curved gradient header (Roadmap #3 UI) */}
        <Tab.Screen name="Lokasi" component={ParentLocationScreen} options={{ headerShown: false, tabBarLabel: t('tabs.location') }} />
        <Tab.Screen name="Atur" component={ParentSettingsListScreen} options={{ tabBarLabel: t('tabs.settings') }} />
      </Tab.Navigator>
    </View>
  );
}

/**
 * Strict Parent lock — shown while the local expiry boundary is in the past.
 * Parents get ZERO grace ("Compassionate Child, Strict Parent").
 *
 *  • Offline → hard block, no payment UI can be reached: exact copy from the
 *    protocol, plus a retry that re-reads local state (no network needed to
 *    keep locking once expired).
 *  • Online  → the Paywall modal is auto-presented (it honors
 *    `web_payment_active` itself); if dismissed, the CTA reopens it.
 *
 * Also reused by the Navigator-level ParentAccessGate (fresh install /
 * role re-selection entry guard).
 */
export function ParentStrictLock({
  offline,
  onRetry,
  onExtend,
}: {
  offline: boolean;
  onRetry: () => void;
  onExtend: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={lockStyles.screen}>
      <View style={lockStyles.card}>
        <View style={lockStyles.iconCircle}>
          <FontAwesome5 name="lock" size={30} color="#FFF" solid />
        </View>
        <Text style={lockStyles.title}>
          {offline ? t('lock.offlineTitle') : t('lock.expiredTitle')}
        </Text>
        {offline ? (
          <Text style={lockStyles.message}>
            {t('lock.offlineMsg')}
          </Text>
        ) : (
          <Text style={lockStyles.message}>
            {t('lock.expiredMsg')}
          </Text>
        )}

        {offline ? (
          <TouchableOpacity style={lockStyles.primaryBtn} onPress={onRetry}>
            <FontAwesome5 name="sync" size={15} color="#FFF" solid />
            <Text style={lockStyles.primaryBtnText}>{t('lock.retry')}</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity style={lockStyles.primaryBtn} onPress={onExtend}>
              <FontAwesome5 name="crown" size={15} color="#FFF" solid />
              <Text style={lockStyles.primaryBtnText}>{t('lock.extend')}</Text>
            </TouchableOpacity>
            <Text style={lockStyles.hint}>
              {t('lock.hint')}
            </Text>
            <TouchableOpacity onPress={onRetry} style={lockStyles.retryLink}>
              <Text style={lockStyles.retryLinkText}>{t('lock.retry')}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const lockStyles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F5F7FA',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#FFF',
    borderRadius: 24,
    paddingVertical: 36,
    paddingHorizontal: 24,
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#11427B',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    fontSize: 22,
    fontWeight: '900',
    color: '#11427B',
    textAlign: 'center',
    marginBottom: 10,
  },
  message: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 24,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
    backgroundColor: '#00B5B8',
    borderRadius: 14,
    paddingVertical: 15,
    gap: 8,
  },
  primaryBtnText: {
    color: '#FFF',
    fontWeight: '800',
    fontSize: 15,
  },
  hint: {
    fontSize: 12,
    color: '#94A3B8',
    textAlign: 'center',
    marginTop: 16,
  },
  retryLink: {
    marginTop: 10,
    paddingVertical: 6,
  },
  retryLinkText: {
    color: '#00B5B8',
    fontWeight: '700',
    fontSize: 14,
  },
});
