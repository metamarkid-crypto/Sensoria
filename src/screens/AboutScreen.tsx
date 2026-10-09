import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Image, Linking,
  ActivityIndicator, useColorScheme,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../services/db/supabase';
import { useAACStore, AboutContent } from '../store/useAACStore';
import { useTranslation } from '../i18n';

/* ── Richer content contract (backward compatible) ─────────────────────
   The admin /admin/about panel writes these optional fields into
   app_content.content_json.next to the original 4 the old screen read.
   Everything optional resolves to '' so old rows never break the screen. */
interface RichAbout extends AboutContent {
  missionParagraphs?: string[];
  featureList?: { icon: string; title: string; text: string }[];
  whatsappNumber?: string;
}

const NAVY = '#11427B';
const NAVY_DEEP = '#0B2545';
const TEAL = '#00B5B8';
const SKY = '#F2FAFE';
const INK = '#334155';
const SLATE_LIGHT = '#E1F2FD';

const ICON_MAP: Record<string, keyof typeof Ionicons.glyphMap> = {
  star: 'star',
  heart: 'heart',
  bulb: 'bulb',
  school: 'school',
  people: 'people',
  chatbubbles: 'chatbubbles',
  mic: 'mic',
  game: 'game-controller',
  shield: 'shield-checkmark',
  sparkles: 'sparkles',
};

/** Feature card icon colors cycle through a compact brand-friendly set. */
const ICON_COLORS = [TEAL, '#6366F1', '#F59E0B', '#10B981', '#EC4899', '#0EA5E9', '#8B5CF6', '#14B8A6'];

export default function AboutScreen() {
  const navigation = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const { aboutContent, setAboutContent } = useAACStore();
  const [isFetching, setIsFetching] = useState(false);

  const defaultContent: RichAbout = {
    description: t('about.defaultDescription'),
    contactEmail: 'support@aacsensoria.id',
    version: 'v1.0.11',
    privacyPolicyUrl: 'https://aacsensoria.id/privacy',
    missionParagraphs: [],
    featureList: [],
  };

  const c: RichAbout = { ...defaultContent, ...(aboutContent ?? {}) };

  useEffect(() => {
    const fetchContent = async () => {
      if (!aboutContent) setIsFetching(true);
      try {
        const { data, error } = await supabase
          .from('app_content')
          .select('content_json')
          .eq('id', 'about_sensoria')
          .single();

        if (!error && data?.content_json) {
          let parsed = data.content_json;
          if (typeof parsed === 'string') {
            try {
              parsed = JSON.parse(parsed);
            } catch {
              parsed = null;
            }
          }
          if (parsed && typeof parsed === 'object') {
            setAboutContent(parsed as AboutContent);
          }
        }
      } catch (e) {
        console.warn('Offline Mode: Failed to fetch About content', e);
      } finally {
        setIsFetching(false);
      }
    };

    fetchContent();

    const channel = supabase
      .channel('about_content_updates')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'app_content', filter: "id=eq.about_sensoria" },
        (payload: any) => {
          if (payload.new && payload.new.content_json) {
            setAboutContent(payload.new.content_json);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openUrl = (url: string) => {
    if (!url) return;
    Linking.openURL(url).catch(() => {});
  };

  const cardBg = isDark ? 'rgba(22,32,58,0.92)' : '#FFFFFF';

  return (
    <View style={[styles.root, { backgroundColor: isDark ? NAVY_DEEP : SKY }]}>
      {/* ── Header — white bar, back button left, consistent with other screens ── */}
      <SafeAreaView
        edges={['top']}
        style={[styles.header, { backgroundColor: isDark ? '#101B33' : '#FFFFFF', borderBottomColor: isDark ? '#1E293B' : '#F1F5F9' }]}
      >
        <View style={styles.headerRow}>
          <TouchableOpacity style={styles.headerBack} onPress={() => navigation.goBack()} hitSlop={8}>
            <Ionicons name="arrow-back" size={24} color={isDark ? '#E2E8F0' : '#1A2980'} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: isDark ? '#E2E8F0' : '#1A2980' }]} numberOfLines={1}>
            {t('about.title')}
          </Text>
          <View style={styles.headerBack} />
        </View>
      </SafeAreaView>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Logo block ── */}
        <View style={styles.logoRow}>
          <View style={[styles.logoBox, { backgroundColor: cardBg }]}>
            <Image
              source={require('../../assets/icon.png')}
              style={styles.logoImg}
              resizeMode="contain"
            />
          </View>
          <Text style={[styles.appName, { color: isDark ? '#FFFFFF' : NAVY }]}>Sensoria AAC</Text>
          <View style={styles.badgeRow}>
            <View style={[styles.badge, { backgroundColor: isDark ? 'rgba(0,181,184,0.16)' : 'rgba(0,181,184,0.12)' }]}>
              <Ionicons name="sparkles" size={11} color={TEAL} />
              <Text style={[styles.badgeText, { color: TEAL }]}>AAC</Text>
            </View>
            <View style={[styles.badge, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(17,66,123,0.08)' }]}>
              <Ionicons name="shield-checkmark" size={11} color={isDark ? '#93C5FD' : NAVY} />
              <Text style={[styles.badgeText, { color: isDark ? '#93C5FD' : NAVY }]}>{t('about.title')}</Text>
            </View>
          </View>
        </View>

        {/* ── Description (long text, center) ── */}
        <View style={[styles.card, { backgroundColor: cardBg }]}>
          {isFetching && !aboutContent ? (
            <ActivityIndicator size="small" color={TEAL} style={{ paddingVertical: 24 }} />
          ) : (
            <>
              <Text style={[styles.description, { color: isDark ? '#CBD5E0' : INK }]}>{c.description}</Text>

              {c.missionParagraphs?.length ? (
                <View style={styles.missionBlock}>
                  <Text style={[styles.sectionLabel, { color: isDark ? '#93C5FD' : NAVY }]}>
                    {t('about.missions') || 'Misi Kami'}
                  </Text>
                  {c.missionParagraphs.filter(Boolean).map((p, i) => (
                    <Text key={i} style={[styles.missionText, { color: isDark ? '#A8B3C4' : '#64748B' }]}>
                      <Text style={{ color: TEAL, fontWeight: '800' }}>• </Text>
                      {p}
                    </Text>
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>

        {/* ── Feature grid (up to 8, admin-managed) ── */}
        {c.featureList?.length ? (
          <View style={styles.featureWrap}>
            {c.featureList.filter((f) => f.title).map((f, i) => (
              <View key={i} style={[styles.featureCard, { backgroundColor: cardBg }]}>
                <View style={[styles.featureIcon, { backgroundColor: `${ICON_COLORS[i % ICON_COLORS.length]}1A` }]}>
                  <Ionicons
                    name={ICON_MAP[f.icon] ?? 'star'}
                    size={18}
                    color={ICON_COLORS[i % ICON_COLORS.length]}
                  />
                </View>
                <Text style={[styles.featureTitle, { color: isDark ? '#E2E8F0' : NAVY }]} numberOfLines={1}>
                  {f.title}
                </Text>
                <Text style={[styles.featureText, { color: isDark ? '#8B99AE' : '#64748B' }]}>{f.text}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* ── Contact card ── */}
        <View style={[styles.card, { backgroundColor: cardBg }]}>
          <Text style={[styles.sectionLabel, { color: isDark ? '#93C5FD' : NAVY }]}>
            Hubungi Kami
          </Text>
          {c.contactEmail ? (
            <TouchableOpacity style={styles.contactRow} onPress={() => openUrl(`mailto:${c.contactEmail}`)}>
              <View style={[styles.contactIcon, { backgroundColor: `${TEAL}1A` }]}>
                <Ionicons name="mail" size={17} color={TEAL} />
              </View>
              <Text style={[styles.contactText, { color: isDark ? '#CBD5E0' : INK }]} numberOfLines={1}>
                {c.contactEmail}
              </Text>
              <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
            </TouchableOpacity>
          ) : null}
          {c.whatsappNumber ? (
            <TouchableOpacity
              style={styles.contactRow}
              onPress={() => openUrl(`https://wa.me/${c.whatsappNumber}`)}
            >
              <View style={[styles.contactIcon, { backgroundColor: 'rgba(37,211,102,0.14)' }]}>
                <Ionicons name="logo-whatsapp" size={18} color="#25D366" />
              </View>
              <Text style={[styles.contactText, { color: isDark ? '#CBD5E0' : INK }]}>WhatsApp Support</Text>
              <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
            </TouchableOpacity>
          ) : null}
          {c.privacyPolicyUrl ? (
            <TouchableOpacity style={styles.contactRow} onPress={() => openUrl(c.privacyPolicyUrl)}>
              <View style={[styles.contactIcon, { backgroundColor: 'rgba(99,102,241,0.13)' }]}>
                <Ionicons name="document-text" size={17} color="#6366F1" />
              </View>
              <Text style={[styles.contactText, { color: isDark ? '#CBD5E0' : INK }]}>
                {t('about.privacyPolicy')}
              </Text>
              <Ionicons name="chevron-forward" size={16} color="#94A3B8" />
            </TouchableOpacity>
          ) : null}
        </View>
      </ScrollView>

      {/* ── Footer ── */}
      <View style={[styles.footer, { backgroundColor: isDark ? '#101B33' : '#FFFFFF', paddingBottom: 18 + insets.bottom }]}>
        <Text style={[styles.versionText, { color: isDark ? '#64748B' : '#94A3B8' }]}>{c.version}</Text>
        <Text style={[styles.footerText, { color: isDark ? '#475569' : '#CBD5E1' }]}>
          {t('about.developedIn')}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  /* header */
  header: {
    borderBottomWidth: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerBack: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: 'bold',
  },
  /* body */
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 32 },
  logoRow: { alignItems: 'center', marginBottom: 24 },
  logoBox: {
    width: 104,
    height: 104,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#00B5B8',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 8,
    marginBottom: 14,
  },
  logoImg: { width: 72, height: 72, borderRadius: 16 },
  appName: { fontSize: 22, fontWeight: '900', letterSpacing: -0.5, marginBottom: 10 },
  badgeRow: { flexDirection: 'row', gap: 8 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  /* cards */
  card: {
    width: '100%',
    borderRadius: 20,
    padding: 20,
    shadowColor: '#0B2545',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 4,
    marginBottom: 16,
  },
  description: { fontSize: 15, lineHeight: 25, textAlign: 'center' },
  missionBlock: { marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(148,163,184,0.15)' },
  sectionLabel: { fontSize: 13, fontWeight: '800', marginBottom: 10, letterSpacing: 0.2 },
  missionText: { fontSize: 14, lineHeight: 22, marginBottom: 8 },
  /* features */
  featureWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 16,
    width: '100%',
  },
  featureCard: {
    flexGrow: 1,
    flexBasis: '46%',
    borderRadius: 16,
    padding: 14,
    shadowColor: '#0B2545',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 3,
  },
  featureIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  featureTitle: { fontSize: 13.5, fontWeight: '800', marginBottom: 4 },
  featureText: { fontSize: 12, lineHeight: 17 },
  /* contacts */
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  contactIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactText: { flex: 1, fontSize: 14, fontWeight: '600' },
  /* footer */
  footer: {
    paddingVertical: 18,
    paddingHorizontal: 24,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(148,163,184,0.12)',
  },
  versionText: { fontSize: 13, fontWeight: '700', marginBottom: 3 },
  footerText: { fontSize: 11.5 },
});

// SLATE_LIGHT kept for potential future accent use; avoids import removal churn.
void SLATE_LIGHT;
