import React, { useEffect } from 'react';
import { View, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';
import { playTTS } from '../services/ai/audioManager';
import * as Haptics from 'expo-haptics';

import ParentHomeScreen from './parent/ParentHomeScreen';
import ParentMessagesScreen from './parent/ParentMessagesScreen';
import ParentLocationScreen from './parent/ParentLocationScreen';
import ParentSettingsListScreen from './parent/ParentSettingsListScreen';
import DynamicGlobalHeader from '../components/parent/DynamicGlobalHeader';

const Tab = createBottomTabNavigator();

export default function ParentDashboardScreen() {
  const { pairingCode, language, deviceId, setChildStatus } = useAACStore();
  const insets = useSafeAreaInsets();

  useEffect(() => {
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
  }, [pairingCode, language]);

  useEffect(() => {
    // 2. Global Real-time Connection Status Listener
    let presenceSub: any = null;

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
        let lastSeenStr = 'Sekarang';
        
        if (diffMins < 5) {
          isOnline = true;
        } else {
          lastSeenStr = `${diffMins} menit lalu`;
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
  }, [deviceId]);

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
        <Tab.Screen name="Beranda" component={ParentHomeScreen} />
        <Tab.Screen name="Pesan" component={ParentMessagesScreen} />
        <Tab.Screen name="Lokasi" component={ParentLocationScreen} />
        <Tab.Screen name="Atur" component={ParentSettingsListScreen} />
      </Tab.Navigator>
    </View>
  );
}
