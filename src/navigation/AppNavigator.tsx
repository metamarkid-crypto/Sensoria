import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { NavigationContainer } from '@react-navigation/native';
import RoleSelectionScreen from '../screens/RoleSelectionScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import ChildAACScreen from '../screens/ChildAACScreen';
import ParentDashboardScreen from '../screens/ParentDashboardScreen';
import WelcomeSliderScreen from '../screens/WelcomeSliderScreen';
import SettingsScreen from '../screens/SettingsScreen';
import UserProfileScreen from '../screens/UserProfileScreen';
import AppearanceSettingsScreen from '../screens/AppearanceSettingsScreen';
import VoiceSettingsScreen from '../screens/VoiceSettingsScreen';
import AccessibilitySettingsScreen from '../screens/AccessibilitySettingsScreen';
import AboutScreen from '../screens/AboutScreen';
import { useAACStore } from '../store/useAACStore';

const Stack = createNativeStackNavigator();

export default function AppNavigator() {
  const role = useAACStore((state) => state.role);
  const childProfile = useAACStore((state) => state.childProfile);
  const hasSeenOnboarding = useAACStore((state) => state.hasSeenOnboarding);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!hasSeenOnboarding ? (
          <Stack.Screen name="WelcomeSlider" component={WelcomeSliderScreen} />
        ) : role === 'None' ? (
          <Stack.Screen name="RoleSelection" component={RoleSelectionScreen} />
        ) : role === 'Child' ? (
          !childProfile ? (
            <Stack.Screen name="Onboarding" component={OnboardingScreen} />
          ) : (
            <>
              <Stack.Screen name="ChildAAC" component={ChildAACScreen} />
              <Stack.Screen name="Settings" component={SettingsScreen} options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="UserProfile" component={UserProfileScreen} options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="AppearanceSettings" component={AppearanceSettingsScreen} options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="VoiceSettings" component={VoiceSettingsScreen} options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="AccessibilitySettings" component={AccessibilitySettingsScreen} options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="AboutScreen" component={AboutScreen} options={{ animation: 'slide_from_right' }} />
            </>
          )
        ) : (
          <Stack.Screen name="ParentDashboard" component={ParentDashboardScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
