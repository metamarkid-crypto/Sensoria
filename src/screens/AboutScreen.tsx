import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, Linking, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../services/db/supabase';
import { useAACStore, AboutContent } from '../store/useAACStore';

export default function AboutScreen() {
  const navigation = useNavigation<any>();
  const { aboutContent, setAboutContent } = useAACStore();
  const [isFetching, setIsFetching] = useState(false);

  // Fallback content if completely offline and store is empty
  const defaultContent: AboutContent = {
    description: "Sensoria AAC adalah aplikasi komunikasi alternatif dan argumentatif yang dirancang khusus untuk memfasilitasi anak-anak dengan spektrum autisme atau tantangan komunikasi lainnya. Kami percaya setiap suara pantas didengar.",
    contactEmail: "support@sensoria-aac.id",
    version: "v1.0.0 (Beta)",
    privacyPolicyUrl: "https://sensoria-aac.id/privacy"
  };

  const displayContent = aboutContent || defaultContent;

  useEffect(() => {
    // 1. Initial Load: Fetch from Supabase if empty (or to get latest)
    const fetchContent = async () => {
      if (!aboutContent) setIsFetching(true);
      try {
        const { data, error } = await supabase
          .from('app_content')
          .select('content_json')
          .eq('id', 'about_sensoria')
          .single();

        if (!error && data?.content_json) {
          setAboutContent(data.content_json);
        }
      } catch (e) {
        console.warn('Offline Mode: Failed to fetch About content', e);
      } finally {
        setIsFetching(false);
      }
    };

    fetchContent();

    // 2. Real-Time Background Sync
    const channel = supabase.channel('about_content_updates')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'app_content', filter: "id=eq.about_sensoria" },
        (payload: any) => {
          if (payload.new && payload.new.content_json) {
            // Silently update the Zustand store in the background
            setAboutContent(payload.new.content_json);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#1A2980" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Tentang Sensoria</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        
        {/* App Logo & Name */}
        <View style={styles.logoContainer}>
          <View style={styles.logoBox}>
            {/* Placeholder for Logo, using an Icon for now */}
            <Ionicons name="shapes" size={64} color="#2488FF" />
          </View>
          <Text style={styles.appName}>Sensoria AAC</Text>
        </View>

        {/* Dynamic Content Area */}
        <View style={styles.card}>
          {isFetching && !aboutContent ? (
            <ActivityIndicator size="small" color="#2488FF" style={{ padding: 20 }} />
          ) : (
            <>
              <Text style={styles.description}>{displayContent.description}</Text>
              
              <TouchableOpacity 
                style={styles.linkRow} 
                onPress={() => Linking.openURL(`mailto:${displayContent.contactEmail}`)}
              >
                <Ionicons name="mail" size={20} color="#2488FF" />
                <Text style={styles.linkText}>{displayContent.contactEmail}</Text>
              </TouchableOpacity>

              <View style={styles.divider} />

              <TouchableOpacity 
                style={styles.linkRow} 
                onPress={() => Linking.openURL(displayContent.privacyPolicyUrl)}
              >
                <Ionicons name="shield-checkmark" size={20} color="#2488FF" />
                <Text style={styles.linkText}>Kebijakan Privasi</Text>
              </TouchableOpacity>
            </>
          )}
        </View>

      </ScrollView>

      {/* Footer Area */}
      <View style={styles.footer}>
        <Text style={styles.versionText}>{displayContent.version}</Text>
        <Text style={styles.footerText}>Developed in Medan, Indonesia 🇮🇩</Text>
      </View>

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
    justifyContent: 'center', // Centered properly
    paddingHorizontal: 16,
    paddingVertical: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    position: 'relative',
  },
  backButton: {
    position: 'absolute',
    left: 16,
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'flex-start',
    zIndex: 10,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1A2980',
  },
  content: {
    padding: 24,
    alignItems: 'center',
  },
  logoContainer: {
    alignItems: 'center',
    marginBottom: 32,
    marginTop: 16,
  },
  logoBox: {
    width: 120,
    height: 120,
    backgroundColor: '#FFFFFF',
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2488FF',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 10,
    marginBottom: 16,
  },
  appName: {
    fontSize: 24,
    fontWeight: '900',
    color: '#1A2980',
    letterSpacing: -0.5,
  },
  card: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    padding: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 5,
  },
  description: {
    fontSize: 15,
    lineHeight: 24,
    color: '#475569',
    textAlign: 'center',
    marginBottom: 24,
  },
  divider: {
    height: 1,
    backgroundColor: '#F1F5F9',
    marginVertical: 16,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  linkText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#2488FF',
  },
  footer: {
    padding: 24,
    alignItems: 'center',
  },
  versionText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#94A3B8',
    marginBottom: 4,
  },
  footerText: {
    fontSize: 12,
    color: '#CBD5E1',
  },
});
