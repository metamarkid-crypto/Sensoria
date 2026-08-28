import React, { useEffect } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { FontAwesome5 } from '@expo/vector-icons';
import { supabase } from '../services/db/supabase';
import { useAACStore } from '../store/useAACStore';
import { playTTS } from '../services/ai/audioManager';
import * as Haptics from 'expo-haptics';

import DynamicParentHeader from '../components/parent/DynamicParentHeader';
import ParentHomeScreen from './parent/ParentHomeScreen';
import ParentMessagesScreen from './parent/ParentMessagesScreen';
import ParentLocationScreen from './parent/ParentLocationScreen';
import SettingsScreen from './SettingsScreen';

const Tab = createBottomTabNavigator();

export default function ParentDashboardScreen() {
  const { pairingCode, language } = useAACStore();

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

  return (
    <>
      <DynamicParentHeader />
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
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

            return <FontAwesome5 name={iconName} size={size} color={color} />;
          },
          tabBarActiveTintColor: '#11427B', // Navy Blue for active
          tabBarInactiveTintColor: '#94A3B8', // Gray for inactive
          tabBarStyle: {
            backgroundColor: '#FFFFFF',
            borderTopWidth: 1,
            borderTopColor: '#E2E8F0',
            elevation: 8,
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
        <Tab.Screen name="Atur" component={SettingsScreen} />
      </Tab.Navigator>
    </>
  );
}
