import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, TouchableOpacity, ScrollView, Modal, TextInput, KeyboardAvoidingView, Platform, Image, Pressable, ImageSourcePropType, useWindowDimensions, Alert } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { useAACStore, AACWord, resolveWordText } from '../store/useAACStore';
import { evaluateAccess } from '../services/db/entitlement';
import { initDB, getAllWords, addCustomWord, updateWord, setWordFavorite, deleteCustomWord, queuePendingMessage, enqueueTranslationJob } from '../services/db/sqlite';
import { tagImageWithBilingualNames, isNoConfidenceTag } from '../services/ai/gemini';
import { startTranslationFlusher } from '../services/translation/translationQueue';
import { logger } from '../utils/logger';
import Toast from 'react-native-toast-message';
import AACGrid from '../components/sensory/AACGrid';
import SentenceStrip from '../components/sensory/SentenceStrip';
import * as Speech from 'expo-speech';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { playTTS, clearAudioCache } from '../services/ai/audioManager';
import { useAccessibleAction } from '../hooks/useAccessibleAction';
import { useTapGuard } from '../hooks/useTapGuard';
import { useTranslation, translate, type TranslationKey } from '../i18n';
import SettingsScreen from './SettingsScreen';
import { supabase, sendAACMessage, subscribeToAACMessages, syncCustomWordToCloud, deleteCustomWordFromCloud } from '../services/db/supabase';
import { getVisualReplyImage, resolveVisualReply } from '../assets/replyAssets';
import {
  ensureBackgroundTracking,
  stopBackgroundTracking,
  requestImmediateLocation,
  writeLocationSnapshot,
} from '../services/location/backgroundLocation';
import { FontAwesome5 } from '@expo/vector-icons';

// ── Human-in-the-loop AI auto-tag ──────────────────────────────────────
// Hard ceiling on the vision call: a hanging request must never trap the
// child in the "AI Sedang Menganalisis" spinner — it degrades to manual.
const AI_TAG_TIMEOUT_MS = 15000;

const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('AI tagger timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

// Category choices for a new custom card — ids mirror the Child tab bar so
// a saved card lands in the right tab immediately.
const AUTO_TAG_CATEGORIES = [
  { id: 'pronoun', labelKey: 'aac.catPronoun', icon: 'user', color: '#FFB6C1' },
  { id: 'verb', labelKey: 'aac.catVerb', icon: 'running', color: '#22C55E' },
  { id: 'noun', labelKey: 'aac.catNoun', icon: 'apple-alt', color: '#3B82F6' },
  { id: 'emotion', labelKey: 'aac.catEmotion', icon: 'smile', color: '#F59E0B' },
  { id: 'social', labelKey: 'aac.catSocial', icon: 'hands-helping', color: '#8B5CF6' },
  { id: 'body', labelKey: 'aac.catBody', icon: 'child', color: '#FECACA' },
  { id: 'number', labelKey: 'aac.catNumber', icon: 'sort-numeric-up', color: '#A5F3FC' },
  { id: 'people', labelKey: 'aac.catPeople', icon: 'users', color: '#C7D2FE' },
  { id: 'food', labelKey: 'aac.catFood', icon: 'utensils', color: '#FECDD3' },
  { id: 'place', labelKey: 'aac.catPlace', icon: 'map-marker-alt', color: '#BAE6FD' },
  { id: 'time', labelKey: 'aac.catTime', icon: 'clock', color: '#99F6E4' },
  { id: 'animal', labelKey: 'aac.catAnimal', icon: 'paw', color: '#D9F99D' },
  { id: 'clothing', labelKey: 'aac.catClothing', icon: 'tshirt', color: '#F5D0FE' },
  { id: 'color', labelKey: 'aac.catColor', icon: 'palette', color: '#E9D5FF' },
] as const;

/**
 * One category tab. Extracted so each tab owns its OWN triple-tap guard
 * (per-instance refs): two taps on "Benda" can never unlock "Kata Kerja",
 * and the Settings gate is independent of every tab.
 *
 * "Favorit" is deliberately exempt — it is the child's fastest escape hatch
 * back to their preferred words, and burying it behind a 3-tap gate would
 * punish the one tab that exists for quick access.
 */
function CategoryTab({
  cat,
  isActive,
  highContrast,
  onSelect,
}: {
  cat: { id: string; labelKey: TranslationKey; icon: string; color: string; rgba: string };
  isActive: boolean;
  highContrast: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const requiresGate = cat.id !== 'favorit';

  const guardedTap = useTapGuard({
    onComplete: () => onSelect(cat.id),
    onProgress: (_count, remaining) => {
      Toast.show({
        type: 'info',
        text1: t('aac.lockedTitle'),
        text2: t('aac.tapHintCategory', { n: remaining }),
        position: 'bottom',
        visibilityTime: 1200,
      });
    },
  });

  const handlePress = () => {
    if (isActive) return; // tapping the live tab is a no-op, never a gate counter
    if (requiresGate) guardedTap();
    else onSelect(cat.id);
  };

  return (
    <TouchableOpacity
      style={[styles.catBtn, isActive && styles.catBtnActive, !isActive && highContrast && styles.catBtnContrast]}
      onPress={handlePress}
    >
      {isActive && (
        <LinearGradient
          colors={[`rgba(${cat.rgba}, 0)`, `rgba(${cat.rgba}, 0.5)`]}
          style={styles.activeHighlight}
        />
      )}
      <FontAwesome5 name={cat.icon as any} size={highContrast ? 24 : 22} color="#FFF" solid style={{ marginBottom: 6 }} />
      <Text style={[styles.catText, isActive && { fontWeight: '900' }, highContrast && styles.catTextContrast]}>
        {t(cat.labelKey)}
      </Text>
      {isActive && (
        <View style={[styles.activeIndicator, { backgroundColor: cat.color }, highContrast && styles.activeIndicatorContrast]} />
      )}
    </TouchableOpacity>
  );
}

export default function ChildAACScreen() {
  const navigation = useNavigation<any>();
  const { 
    currentSentence, clearSentence, addToSentence, setRole, 
    language, childProfile, pairingCode, deviceId, 
    setSpeechRate,
    cardSize, cardSpacing, speakOnTap,
    highContrast,
    premium, webPaymentActive
  } = useAACStore();
  const { t } = useTranslation();

  // ── Compassionate Child access ("Compassionate Child, Strict Parent") ──
  // Evaluated at render time from PERSISTED raw boundaries + Date.now(), so an
  // offline child inside its grace window is never disrupted. Phases:
  //   grace  → full access + tiny non-blocking nudge banner
  //   locked → full access denied only AFTER the grace window; soft-lock.
  // The Child device NEVER sees pricing or the Paywall.
  const childAccess = evaluateAccess(premium, 'Child', Date.now());
  const childInGrace = childAccess.phase === 'grace';
  const childSoftLocked = childAccess.phase === 'locked';

  // ── True Background Location (Roadmap #3) — entitlement-gated ───────────
  // premium/grace (or unknown-yet) → tracker keeps running; the moment the
  // phase flips to locked the task is stopped immediately (battery + paywall).
  useEffect(() => {
    if (childSoftLocked) {
      void stopBackgroundTracking();
    } else {
      void ensureBackgroundTracking();
    }
  }, [childSoftLocked]);
  const [words, setWords] = useState<AACWord[]>([]);
  const [loading, setLoading] = useState(true);
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [location, setLocation] = useState<Location.LocationObject | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [showPairing, setShowPairing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [linkedParents, setLinkedParents] = useState<any[]>([]);
  // Gerbang tombol kirim: terkunci sampai minimal satu parent terhubung —
  // mencegah pesan tanpa penerima. DERIVED dari linkedParents (diisi fetch
  // awal + realtime INSERT/DELETE) sehingga tidak mungkin desinkron.
  const isParentLinked = linkedParents.length > 0;
  // ── Balasan Visual (modal gambar balasan parent) ────────────────────
  // Aktif saat setting visualRepliesEnabled menyala (anak tunarungu):
  // suara TIDAK diputar; isi balasan parent direpresentasikan gambar besar.
  const [visualReply, setVisualReply] = useState<{ text: string; image: ImageSourcePropType } | null>(null);
  const visualReplyText = visualReply ? `“${visualReply.text}”` : '';
  useEffect(() => {
    if (!visualReply) return;
    // Auto-tutup 6 detik — anak membaca gambar, bukan membaca cepat.
    const timer = setTimeout(() => setVisualReply(null), 6000);
    return () => clearTimeout(timer);
  }, [visualReply]);
  const insets = useSafeAreaInsets();

  // Ukuran gambar Balasan Visual dihitung dari dimensi layar AGAR TIDAK
  // meluber keluar modal di layar pendek/landscape (tablet anak sering
  // dipakai landscape): batas = lebar layar − 96, tinggi layar − 240
  // (memberi ruang avatar + caption + padding overlay), maksimum 360.
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const vrImageSize = Math.max(120, Math.min(winWidth - 96, winHeight - 240, 360));
  
  // Word Options State
  const [selectedWord, setSelectedWord] = useState<AACWord | null>(null);
  const [showWordOptions, setShowWordOptions] = useState(false);
  const [showEditName, setShowEditName] = useState(false);
  // Single editable field bound to the ACTIVE app language — resolved with
  // the SAME resolver cards and TTS use, so what you see/edit is what speaks.
  const [editNameLabel, setEditNameLabel] = useState('');

  // ── AI Auto-Tag confirmation draft (frictionless quad-lingual) ─────
  // The AI result is NEVER auto-saved: it only pre-fills this editable
  // draft. The user sees and edits ONE input — their active app language —
  // while the other three languages are stored silently and auto-filled in
  // background. Any failure (network / timeout / no-confidence) opens the
  // same form blank — the human always has the final word.
  const [showAutoTagConfirm, setShowAutoTagConfirm] = useState(false);
  const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState('');
  const [pendingEn, setPendingEn] = useState('');
  const [pendingZh, setPendingZh] = useState('');
  const [pendingMs, setPendingMs] = useState('');
  const [pendingCategory, setPendingCategory] = useState<string>('noun');

  // The single visible input binds to the ACTIVE app language.
  const activeLang = language;
  const pendingLabel =
    activeLang === 'id' ? pendingId : activeLang === 'en' ? pendingEn : activeLang === 'zh' ? pendingZh : pendingMs;
  const setPendingLabel = (text: string) => {
    if (activeLang === 'id') setPendingId(text);
    else if (activeLang === 'en') setPendingEn(text);
    else if (activeLang === 'zh') setPendingZh(text);
    else setPendingMs(text);
  };
  const activeLanguageLabel =
    activeLang === 'id' ? t('aac.langNameId') :
    activeLang === 'en' ? t('aac.langNameEn') :
    activeLang === 'zh' ? t('aac.langNameZh') : t('aac.langNameMs');
  const activeLanguagePlaceholder = activeLang === 'id' ? 'Bola' : activeLang === 'en' ? 'Ball' : activeLang === 'zh' ? '球' : 'Bola';
  // What the AI proposed for the ACTIVE language (null = manual fallback).
  // Used to detect "user corrected the AI word" → siblings need re-translation.
  const aiOriginalRef = useRef<string | null>(null);

  useEffect(() => {
    loadDatabase();
    setupLocation();

    // NON-AI translation flusher: fills pending custom-word translations when
    // the device (re)gains connectivity. adding Words offline never blocks —
    // the queue persists in SQLite until a later online flush succeeds.
    const stopTranslationFlusher = startTranslationFlusher(() => loadDatabase());
    
    // Greet the child on first load!
    if (childProfile?.nickname) {
      setTimeout(() => {
        playTTS(t('aac.greeting', { name: childProfile.nickname }), language, 'Child');
      }, 1000);
    }

    // 1. CATCH-UP SYNC: Fetch latest settings from cloud on mount
    const catchUpSync = async () => {
      if (!deviceId) return;
      try {
        const { data, error } = await supabase
          .from('child_profiles')
          .select('settings')
          .eq('device_id', deviceId)
          .single();
          
        if (!error && data?.settings) {
          // Whitelisted apply (never a raw setState of the remote blob) so
          // appearance / visual replies / voice land here exactly as they do
          // through the peer broadcast in SettingsSyncBridge.
          useAACStore.getState().applySettingsPatch(data.settings);
        }
      } catch (err) {
        console.warn('Catch-up Sync failed (Offline Mode Active):', err);
        logger.logError(err, { action: 'Catch-up Sync Failed', role: 'Child' });
      }
    };
    catchUpSync();

    // The message bus needs the pairing code, so IT is optional — but the
    // device-keyed channels below (settings mirror, family-link toasts,
    // location pings) must exist on EVERY child install. The old
    // `if (!pairingCode) return` silently skipped all four whenever the
    // pairing code had not been restored at mount, leaving the child deaf to
    // remote profile edits, new family links and parent location pings.
    if (pairingCode) {
      logger.setUserContext('Child', pairingCode);
    }

    const channel = pairingCode
      ? subscribeToAACMessages(pairingCode, (payload: any) => {
      if (payload.sender === 'Parent') {
        // Read the language fresh at callback time — this effect mounts once,
        // so the closure `language` would otherwise go stale after a language
        // switch and speak parent messages in the previous language.
        const currentLang = useAACStore.getState().language;

        if (useAACStore.getState().visualRepliesEnabled) {
          // Balasan Visual: suara DIGANTI modal gambar (oke/tidak/tunggu/
          // default) sesuai isi balasan — untuk anak yang tidak bisa mendengar.
          setVisualReply({
            text: payload.text,
            image: getVisualReplyImage(resolveVisualReply(payload.text)),
          });
        } else {
          // Suara TIDAK diputar di sini: MessageAlertBridge (app-level) yang
          // memutuskan bunyi, supaya tidak dobel ketika app di background.
          Toast.show({ type: 'info', text1: translate(currentLang, 'aac.toastParentMsg'), text2: payload.text, position: 'top', visibilityTime: 4000 });
        }
      }
        })
      : null;

    const settingsChannel = deviceId
      ? supabase.channel('child-settings-update')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'child_profiles', filter: `device_id=eq.${deviceId}` },
        (payload: any) => {
          if (payload.new && payload.new.settings) {
            const currentProfile = useAACStore.getState().childProfile;
            
            // Perbarui childProfile dengan gender dari settings dan field lainnya
            useAACStore.getState().setChildProfile({
              ...currentProfile,
              nickname: payload.new.nickname || currentProfile?.nickname,
              full_name: payload.new.full_name || currentProfile?.full_name,
              fullName: payload.new.full_name || currentProfile?.fullName,
              gender: payload.new.settings.childProfileGender || currentProfile?.gender,
              settings: payload.new.settings
            });

            // Terapkan setting lewat jalur whitelist yang sama dengan mirror
            // broadcast (lihat SettingsSyncBridge) — hanya key yang berubah
            // yang menulis ulang state.
            useAACStore.getState().applySettingsPatch(payload.new.settings);
          }
        }
      )
      .subscribe()
      : null;

    const familyLinksChannel = deviceId
      ? supabase.channel('child_family_links')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'family_links', filter: `child_device_id=eq.${deviceId}` },
        (payload) => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          // Read the language fresh at callback time — this effect mounts
          // once, so the closure `t` would otherwise go stale after a
          // language switch and show the link toast in the old language.
          const currentLang = useAACStore.getState().language;
          Toast.show({ 
            type: 'success', 
            text1: translate(currentLang, 'aac.toastLinked'), 
            text2: translate(currentLang, 'aac.toastLinkedDesc'), 
            position: 'top',
            visibilityTime: 4000
          });
        }
      )
      .subscribe()
      : null;

    // Parent "refresh location" ping → force one immediate GPS write.
    const pingChannel = deviceId
      ? supabase.channel(`location-ping-${deviceId}`)
      .on('broadcast', { event: 'refresh-location' }, () => {
        requestImmediateLocation()
          .then(() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            // Language read fresh at callback time (see family-links note):
            // the mount-closed `t` would freeze the ping toast in the
            // language that was active when this screen first mounted.
            const currentLang = useAACStore.getState().language;
            Toast.show({ type: 'success', text1: translate(currentLang, 'aac.toastLocationSent'), text2: translate(currentLang, 'aac.toastLocationSentDesc'), position: 'top' });
          })
          .catch((e) => console.warn('[LocationPing] refresh failed:', e));
      })
      .subscribe()
      : null;

    return () => {
      if (channel) supabase.removeChannel(channel);
      if (settingsChannel) supabase.removeChannel(settingsChannel);
      if (familyLinksChannel) supabase.removeChannel(familyLinksChannel);
      if (pingChannel) supabase.removeChannel(pingChannel);
      stopTranslationFlusher();
    };
  }, []);

  // ── Link status: gerbang tombol kirim ───────────────────────────────
  // Fetch awal (offline → tetap terkunci, tanpa toast palsu) + realtime
  // INSERT/DELETE pada family_links: tombol "Kirim" langsung hidup begitu
  // parent terhubung dan terkunci lagi saat unlink — tanpa restart app.
  useEffect(() => {
    if (!deviceId) {
      setLinkedParents([]);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const { data } = await supabase
          .from('family_links')
          .select('parent_device_id')
          .eq('child_device_id', deviceId);
        if (!cancelled) setLinkedParents(data ?? []);
      } catch {
        if (!cancelled) setLinkedParents([]);
      }
    })();

    const linksChannel = supabase
      .channel('child-link-status')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'family_links', filter: `child_device_id=eq.${deviceId}` },
        (payload: any) => {
          setLinkedParents((prev) =>
            prev.some((l) => l?.parent_device_id === payload.new?.parent_device_id)
              ? prev
              : [...prev, payload.new],
          );
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'family_links', filter: `child_device_id=eq.${deviceId}` },
        (payload: any) => {
          // Postgres DELETE payload hanya membawa PK — cocokkan lewat kunci apa
          // pun yang tersedia (parent_device_id atau id).
          const oldKey = payload.old?.parent_device_id ?? payload.old?.id;
          setLinkedParents((prev) =>
            prev.filter((l) => (l?.parent_device_id ?? l?.id) !== oldKey),
          );
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(linksChannel);
    };
  }, [deviceId]);

  const setupLocation = async () => {
    let { status } = await Location.requestForegroundPermissionsAsync();
    if (status === 'granted') {
      let loc = await Location.getCurrentPositionAsync({});
      setLocation(loc);
      
      // The Pusher: shared snapshot writer (reverse-geocode + locations row +
      // devices presence update) so background and foreground share one path.
      await writeLocationSnapshot(loc, true);
    }
  };

  const loadDatabase = async () => {
    setLoading(true);
    await initDB();
    const data = await getAllWords();
    setWords(data);
    setLoading(false);
  };

  const handleCardPress = useCallback((word: AACWord) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const wordText = resolveWordText(word, language);
    
    if (speakOnTap) {
      playTTS(wordText, language, 'Child');
    }
    
    addToSentence(word);
  }, [language, speakOnTap, addToSentence]);

  const handleSpeakAll = () => {
    if (currentSentence.length === 0) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const fullText = currentSentence.map(w => resolveWordText(w, language)).join(' ');
    playTTS(fullText, language, 'Child');
  };

  const handleSendToParent = async () => {
    if (currentSentence.length === 0) return;
    if (!isParentLinked) {
      // Belt-and-suspenders: tombol sudah disabled, ini melindungi jalur aksesibilitas.
      Toast.show({ type: 'info', text1: t('common.failed'), text2: t('aac.toastNotLinked'), position: 'top' });
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    handleSpeakAll();
    
    // Clear sentence immediately for better UX
    const sentenceToWrap = [...currentSentence];
    clearSentence();
    
    let loc = location;
    try {
      // Safety Critical: 3-second strict timeout for GPS fetch
      const locationPromise = Location.getCurrentPositionAsync({});
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('GPS Timeout')), 3000)
      );
      
      loc = await Promise.race([locationPromise, timeoutPromise]);
      setLocation(loc);
    } catch(e) {
      console.warn("GPS fetch failed or timed out. Force sending message.");
      // loc remains as the last known location, or null. We don't block.
    }
    
    const fullText = sentenceToWrap.map(w => resolveWordText(w, language)).join(' ');
    
    if (pairingCode) {
      // Only send when a parent device is ACTUALLY connected — a child can hold
      // a pairing code long before any parent pairs, and those orphan messages
      // would otherwise be written to Supabase with no recipient. When the
      // check itself fails (offline), we do NOT block: connectivity is
      // re-verified by the outbox flusher once the device is back online.
      let connected = false;
      let checkFailed = false;
      if (deviceId) {
        const { data: links, error: linkError } = await supabase
          .from('family_links')
          .select('id')
          .eq('child_device_id', deviceId)
          .limit(1);
        if (linkError) {
          checkFailed = true;
        } else {
          connected = Array.isArray(links) && links.length > 0;
        }
      }

      if (!connected && !checkFailed) {
        Toast.show({ type: 'info', text1: t('common.failed'), text2: t('aac.toastNotLinked'), position: 'top' });
        return;
      }

      const messagePayload = {
        sender: 'Child' as const,
        senderName: childProfile?.nickname || t('aac.childFallback'),
        text: fullText,
        timestamp: Date.now(),
        location: loc ? { latitude: loc.coords.latitude, longitude: loc.coords.longitude } : null
      };

      const delivered = await sendAACMessage(pairingCode, messagePayload);
      if (delivered) {
        Toast.show({ type: 'success', text1: t('aac.toastSent'), text2: t('aac.toastSentDesc'), position: 'top' });
      } else {
        // Offline / cloud unreachable: never lose the message — park it in the
        // local outbox; flushPendingMessages() delivers it once back online.
        await queuePendingMessage({
          channel_id: pairingCode,
          sender_role: messagePayload.sender,
          sender_name: messagePayload.senderName,
          text_content: messagePayload.text,
          timestamp: messagePayload.timestamp,
          location_lat: messagePayload.location?.latitude ?? null,
          location_lng: messagePayload.location?.longitude ?? null,
        });
        Toast.show({ type: 'info', text1: t('aac.toastSent'), text2: t('aac.toastQueuedOffline'), position: 'top' });
      }
    } else {
      Toast.show({ type: 'error', text1: t('common.failed'), text2: t('aac.toastNotLinked'), position: 'top' });
    }
  };

  const handleAddCustomWord = async () => {
    let result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });

    if (!result.canceled && result.assets[0]) {
      const imageUri = result.assets[0].uri;
      setIsProcessingAI(true);

      let aiPrefill: { id: string; en: string; zh: string; ms: string; category: string } | null = null;
      try {
        const tags = await withTimeout(tagImageWithBilingualNames(imageUri), AI_TAG_TIMEOUT_MS);
        // gemini.ts answers with a generic placeholder whenever it cannot
        // parse a confident response — treat that as "no confidence" so the
        // user always lands on the editable manual form instead of a junk
        // card name.
        if (!isNoConfidenceTag(tags)) {
          aiPrefill = { id: tags.id, en: tags.en, zh: tags.zh, ms: tags.ms, category: tags.category };
        }
      } catch (e) {
        logger.logError(e, { action: 'AI auto-tag failed — manual fallback', role: 'Child' });
      } finally {
        setIsProcessingAI(false);
      }

      if (aiPrefill) {
        // Quad-lingual stored silently; the UI only shows ONE editable input
        // bound to the user's active language.
        setPendingId(aiPrefill.id);
        setPendingEn(aiPrefill.en);
        setPendingZh(aiPrefill.zh);
        setPendingMs(aiPrefill.ms);
        setPendingCategory(aiPrefill.category);
        aiOriginalRef.current =
          activeLang === 'id' ? aiPrefill.id :
          activeLang === 'en' ? aiPrefill.en :
          activeLang === 'zh' ? aiPrefill.zh : aiPrefill.ms;
      } else {
        setPendingId('');
        setPendingEn('');
        setPendingZh('');
        setPendingMs('');
        setPendingCategory('noun');
        aiOriginalRef.current = null;
        Toast.show({
          type: 'info',
          text1: t('aac.toastAiTag'),
          text2: t('aac.toastAiTagFail'),
          position: 'top',
        });
      }

      setPendingImageUri(imageUri);
      setShowAutoTagConfirm(true);
    }
  };

  const handleConfirmAutoTag = async () => {
    if (!pendingImageUri) return;
    if (!pendingLabel.trim()) {
      Toast.show({ type: 'error', text1: t('common.error'), text2: t('aac.toastNameRequired'), position: 'top' });
      return;
    }

    // One-input rule: the user edits ONLY the label in their active language.
    // The other three keep their silent AI prediction, or — when there is none
    // (manual fallback) — start as the SAME typed word (never empty), and are
    // auto-translated in background without blocking the UI.
    const label = pendingLabel.trim();
    const nameId = activeLang === 'id' ? label : (pendingId || label);
    const nameEn = activeLang === 'en' ? label : (pendingEn || label);
    const nameZh = activeLang === 'zh' ? label : (pendingZh || label);
    const nameMs = activeLang === 'ms' ? label : (pendingMs || label);
    const newWord: AACWord = {
      id: Date.now().toString(),
      word_id: nameId,
      word_en: nameEn,
      word_zh: nameZh,
      word_ms: nameMs,
      imageUrl: pendingImageUri,
      categoryId: pendingCategory,
      isCustom: true
    };

    await addCustomWord(newWord);
    await loadDatabase();
    setShowAutoTagConfirm(false);
    setPendingImageUri(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Toast.show({ type: 'success', text1: t('common.success'), text2: t('aac.toastCardAdded', { name: label }), position: 'top' });

    // Non-blocking background tasks: cloud backup + NON-AI translation of the
    // languages the user did not type. The translation is OFFLINE-DEFERRED:
    // the typed label is already stored in all four columns, so the card is
    // immediately usable; the free MT queue fills the siblings when online
    // (flushTranslationQueue on network reconnect). The human's typed label
    // is never overwritten.
    void syncCustomWordToCloud(newWord, deviceId).catch((e: any) => {
      logger.logError(e, { action: 'custom_words cloud sync failed', role: 'Child' });
    });
    const needsTranslation =
      aiOriginalRef.current === null || label !== aiOriginalRef.current;
    if (needsTranslation) {
      void enqueueTranslationJob(newWord.id, label, activeLang);
    }
  };

  const handleCancelAutoTag = () => {
    setShowAutoTagConfirm(false);
    setPendingImageUri(null);
  };

  const handleWordLongPress = useCallback((word: AACWord) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setSelectedWord(word);
    setShowWordOptions(true);
  }, []);

  const handleUpdateVoice = async () => {
    if (!selectedWord) return;
    setShowWordOptions(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const wordText = resolveWordText(selectedWord, language);
    await clearAudioCache(wordText, language, 'Child');
    playTTS(wordText, language, 'Child');
    Toast.show({ type: 'info', text1: t('aac.toastVoiceUpdated'), text2: t('aac.toastVoiceUpdatedDesc'), position: 'top' });
  };

  const handleToggleFavorite = async () => {
    if (!selectedWord) return;
    const isFavorite = selectedWord.isFavorite === true;
    setShowWordOptions(false);
    // Non-destructive toggle: flips only the `is_favorite` boolean. The
    // card's categoryId is untouched, so it stays in its original tab and
    // the child's motor memory of "Apel is in Benda" is preserved.
    await setWordFavorite(selectedWord.id, !isFavorite);
    await loadDatabase();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Toast.show({
      type: 'success',
      text1: isFavorite ? t('aac.toastUnfavorited') : t('aac.toastFavorited'),
      text2: isFavorite ? t('aac.toastUnfavDesc') : t('aac.toastFavDesc'),
      position: 'top',
    });
  };

  // ── Delete a USER-ADDED card ────────────────────────────────────────────
  // Offered only for `isCustom` cards (the shared 244-word dictionary is
  // immutable — every child on the app relies on the same motor plan for
  // those positions, so removing one would silently break their muscle
  // memory). Deleting is destructive and irreversible, so it is confirmed.
  const handleDeleteWord = () => {
    const word = selectedWord;
    if (!word || word.isCustom !== true) return;
    const label = resolveWordText(word, language);
    Alert.alert(
      t('aac.deleteTitle'),
      t('aac.deleteDesc', { name: label }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('aac.optionDelete'),
          style: 'destructive',
          onPress: () => { void performDeleteWord(word, label); },
        },
      ],
      { cancelable: true },
    );
  };

  const performDeleteWord = async (word: AACWord, label: string) => {
    setShowWordOptions(false);
    const removed = await deleteCustomWord(word.id);
    if (!removed) {
      Toast.show({ type: 'error', text1: t('common.failed'), text2: t('aac.deleteTitle'), position: 'top' });
      return;
    }

    // Drop every occurrence from the sentence strip. Walk BACKWARDS: removing
    // by index shifts the tail, so a forward loop would skip duplicates.
    const sentence = useAACStore.getState().currentSentence;
    for (let i = sentence.length - 1; i >= 0; i--) {
      if (sentence[i].id === word.id) useAACStore.getState().removeFromSentence(i);
    }

    // Evict the cached AI voice of the old label (the card is gone — a stale
    // clip would only eat space) and mirror the delete to the cloud copy.
    await clearAudioCache(label, language, 'Child');
    void deleteCustomWordFromCloud(word.id, deviceId ?? null);

    await loadDatabase();
    setSelectedWord(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Toast.show({
      type: 'success',
      text1: t('common.success'),
      text2: t('aac.toastDeleted', { name: label }),
      position: 'top',
    });
  };

  const handleChangeImage = async () => {
    if (!selectedWord) return;
    setShowWordOptions(false);
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });

    if (!result.canceled && result.assets[0]) {
      await updateWord(selectedWord.id, { imageUrl: result.assets[0].uri });
      await loadDatabase();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const handleOpenEditName = () => {
    if (!selectedWord) return;
    setEditNameLabel(resolveWordText(selectedWord, language));
    setShowWordOptions(false);
    setShowEditName(true);
  };

  const handleSaveEditName = async () => {
    if (!selectedWord) return;
    const label = editNameLabel.trim();
    if (!label) {
      Toast.show({ type: 'error', text1: t('common.error'), text2: t('aac.toastNameRequired'), position: 'top' });
      return;
    }

    const previousLabel = resolveWordText(selectedWord, activeLang);

    // Patch ONLY the active language now — the human's typed label is never
    // overwritten by the background translation (mirrors handleConfirmAutoTag).
    const patch: Partial<AACWord> = {};
    if (activeLang === 'id') patch.word_id = label;
    else if (activeLang === 'en') patch.word_en = label;
    else if (activeLang === 'zh') patch.word_zh = label;
    else patch.word_ms = label;

    // The old label's cached AI voice is stale after a rename — evict it.
    await clearAudioCache(previousLabel, activeLang, 'Child');

    await updateWord(selectedWord.id, patch);
    await loadDatabase();

    setShowEditName(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // Keep the quad-lingual dataset sealed: when the label actually changed,
    // refresh the OTHER three languages via the NON-AI translation queue
    // (offline-deferred — nothing blocks, nothing is lost when offline). The
    // old labels' cached AI voices are evicted up front so the next playback
    // fetches the NEW name; the queue's patch lands afterwards.
    if (label !== previousLabel) {
      if (activeLang !== 'id' && selectedWord.word_id) await clearAudioCache(selectedWord.word_id, 'id', 'Child');
      if (activeLang !== 'en' && selectedWord.word_en) await clearAudioCache(selectedWord.word_en, 'en', 'Child');
      if (activeLang !== 'zh' && selectedWord.word_zh) await clearAudioCache(selectedWord.word_zh, 'zh', 'Child');
      if (activeLang !== 'ms' && selectedWord.word_ms) await clearAudioCache(selectedWord.word_ms, 'ms', 'Child');
      void enqueueTranslationJob(selectedWord.id, label, activeLang);
    }
  };

  // ── AAC-Safe Tremor Filter (useAccessibleAction) ─────────────────────────
  // Applied ONLY to the action strip. Per-instance: filtering "Bicara" never
  // blocks "Kirim" (and vice versa).
  //
  //  • "Bicara"/"Kirim" get haptics:false — both handlers already fire their
  //    own Success notification haptic on accept, so adding the hook's Light
  //    impact would double-buzz the child.
  //  • The hook wraps ONLY the touch callback: TTS inside these handlers
  //    (playTTS → audioManager queue/interrupt logic) is untouched, and the
  //    holdDuration / ignoreRepeat / releaseToSpeak protocol in AACCard is
  //    orthogonal — word cards below are deliberately NOT wrapped, because
  //    repeated taps there are intentional AAC expression.
  //  • "Hapus" also stays unwrapped: deleting a word is a precise correction,
  //    not a high-frequency spam target, and raw taps keep it latency-free.
  //  • No `disabled` prop, no opacity, no contrast change — during the 300ms
  //    absorb window every button remains fully styled and screen-reader
  //    active. Ghost-taps are simply swallowed in the callback.
  const speakAllFiltered = useAccessibleAction(handleSpeakAll, { haptics: false });
  const sendToParentFiltered = useAccessibleAction(() => handleSendToParent(), { haptics: false });

  // ── Triple-tap gate: child-mode Settings ─────────────────────────────────
  // Replaces the old 3-second hold. A steady hold is the hardest gesture for
  // the children this app serves (tremor / spasticity) and fires by accident
  // when a palm rests on the screen; three deliberate taps are the same rule
  // now used by the category bar, so the child learns ONE safety gesture.
  // Read/Delete/Send are intentionally NOT gated: they are the core AAC verbs.
  const handleSettingsTap = useTapGuard({
    onComplete: () => navigation.navigate('Settings'),
    onProgress: (_count, remaining) => {
      Toast.show({
        type: 'info',
        text1: t('aac.lockedTitle'),
        text2: t('aac.tapHintSettings', { n: remaining }),
        position: 'bottom',
        visibilityTime: 1400,
      });
    },
  });

  if (loading || isProcessingAI) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#00B5B8" />
        {isProcessingAI && <Text style={{marginTop: 10, color: '#11427B'}}>{t('aac.aiAnalyzing')}</Text>}
      </View>
    );
  }

  const filteredWords = words.filter((w) => {
    if (activeCategory === 'all') return true;
    if (activeCategory === 'favorit') return w.isFavorite === true;
    return w.categoryId === activeCategory;
  });

  const categoriesConfig = [
    { id: 'all', labelKey: 'aac.tabAll', icon: 'shapes', color: '#00B5B8', rgba: '0, 181, 184' },
    { id: 'favorit', labelKey: 'aac.tabFavorites', icon: 'star', color: '#FFD700', rgba: '255, 215, 0' },
    { id: 'pronoun', labelKey: 'aac.catPronoun', icon: 'user', color: '#FFB6C1', rgba: '255, 182, 193' },
    { id: 'verb', labelKey: 'aac.catVerb', icon: 'running', color: '#BBF7D0', rgba: '187, 247, 208' },
    { id: 'noun', labelKey: 'aac.catNoun', icon: 'apple-alt', color: '#BFDBFE', rgba: '191, 219, 254' },
    { id: 'emotion', labelKey: 'aac.catEmotion', icon: 'smile', color: '#FDE68A', rgba: '253, 230, 138' },
    { id: 'social', labelKey: 'aac.catSocial', icon: 'hands-helping', color: '#DDD6FE', rgba: '221, 214, 254' },
    { id: 'body', labelKey: 'aac.catBody', icon: 'child', color: '#FECACA', rgba: '254, 202, 202' },
    { id: 'number', labelKey: 'aac.catNumber', icon: 'sort-numeric-up', color: '#A5F3FC', rgba: '165, 243, 252' },
    { id: 'people', labelKey: 'aac.catPeople', icon: 'users', color: '#C7D2FE', rgba: '199, 210, 254' },
    { id: 'food', labelKey: 'aac.catFood', icon: 'utensils', color: '#FECDD3', rgba: '254, 205, 211' },
    { id: 'place', labelKey: 'aac.catPlace', icon: 'map-marker-alt', color: '#BAE6FD', rgba: '186, 230, 253' },
    { id: 'time', labelKey: 'aac.catTime', icon: 'clock', color: '#99F6E4', rgba: '153, 246, 228' },
    { id: 'animal', labelKey: 'aac.catAnimal', icon: 'paw', color: '#D9F99D', rgba: '217, 249, 157' },
    { id: 'clothing', labelKey: 'aac.catClothing', icon: 'tshirt', color: '#F5D0FE', rgba: '245, 208, 254' },
    { id: 'color', labelKey: 'aac.catColor', icon: 'palette', color: '#E9D5FF', rgba: '233, 213, 255' },
  ] as const;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.avatarMini}>
            {childProfile?.gender === 'Girl' ? (
              <Text style={{ fontSize: 16 }}>👧🏻</Text>
            ) : (
              <Text style={{ fontSize: 16 }}>👦🏻</Text>
            )}
          </View>
          <Text style={styles.title}>{t('aac.headerGreeting', { name: childProfile?.nickname || 'Sensoria' })}</Text>
        </View>
        
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.iconButton} onPress={handleAddCustomWord}>
            <FontAwesome5 name="camera" size={20} color="#00B5B8" />
          </TouchableOpacity>

          {/* Settings is triple-tap gated (was: 3-second hold). */}
          <TouchableOpacity 
            style={styles.iconButton} 
            onPress={handleSettingsTap}
            accessibilityLabel={t('aac.lockedDesc')}
          >
            <FontAwesome5 name="cog" size={20} color="#94A3B8" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Compassionate grace: subtle, non-blocking nudge — and STEALTH-gated:
          during App Review (web_payment_active=false) even the word
          "langganan" must never surface on any screen, child included. */}
      {childInGrace && webPaymentActive ? (
        <View style={styles.graceBanner}>
          <Text style={styles.graceBannerText}>{t('aac.graceBanner')}</Text>
        </View>
      ) : null}

      {/* Sentence Strip & Actions */}
      <View style={styles.topActionsContainer}>
        <SentenceStrip />
        <View style={styles.actionRow}>
          <TouchableOpacity style={styles.actionBtnRed} onPress={clearSentence}>
            <Text style={styles.actionBtnText}>🗑️ {t('aac.clear')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.actionBtnBlue} onPress={speakAllFiltered}>
            <Text style={styles.actionBtnText}>🔊 {t('aac.speak')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtnOrange, !isParentLinked && styles.actionBtnDisabled]}
            onPress={sendToParentFiltered}
            disabled={!isParentLinked}
          >
            <Text style={[styles.actionBtnText, !isParentLinked && { opacity: 0.6 }]}>🚀 {t('aac.send')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Grid */}
      <View style={[styles.gridContainer, highContrast && styles.gridContainerContrast]}>
        <AACGrid
          words={filteredWords}
          onWordPress={handleCardPress}
          onWordLongPress={handleWordLongPress}
          emptyState={activeCategory === 'favorit' ? { icon: 'star', message: t('aac.noFavoritesYet') } : undefined}
        />

        {/* Soft-lock past the grace window: dim + friendly offline-safe message.
            Never a paywall — parents renew from THEIR phone. */}
        {childSoftLocked ? (
          <View style={styles.softLockOverlay} pointerEvents="auto">
            <Text style={styles.softLockEmoji}>🤗</Text>
            <Text style={styles.softLockText}>
              {t('aac.softLock')}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Word Options Modal */}
      <Modal visible={showWordOptions} transparent animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowWordOptions(false)}>
          <View style={styles.optionsModal}>
            <Text style={styles.optionsTitle}>{t('aac.wordOptionsTitle')}</Text>
            <TouchableOpacity style={styles.optionBtn} onPress={handleUpdateVoice}>
              <Text style={styles.optionEmoji}>🔊</Text>
              <Text style={styles.optionText}>{t('aac.optionVoice')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optionBtn} onPress={handleOpenEditName}>
              <Text style={styles.optionEmoji}>✏️</Text>
              <Text style={styles.optionText}>{t('aac.optionEditName')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.optionBtn} onPress={handleChangeImage}>
              <Text style={styles.optionEmoji}>🖼️</Text>
              <Text style={styles.optionText}>{t('aac.optionChangeImage')}</Text>
            </TouchableOpacity>
            {selectedWord?.isFavorite === true ? (
              <TouchableOpacity style={styles.optionBtn} onPress={handleToggleFavorite}>
                <Text style={styles.optionEmoji}>💔</Text>
                <Text style={[styles.optionText, styles.optionTextDanger]}>{t('aac.optionUnfavorite')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.optionBtn} onPress={handleToggleFavorite}>
                <Text style={styles.optionEmoji}>⭐</Text>
                <Text style={styles.optionText}>{t('aac.optionFavorite')}</Text>
              </TouchableOpacity>
            )}

            {/* Destructive action — ONLY for user-added cards. Built-in
                dictionary words never render this row. */}
            {selectedWord?.isCustom === true ? (
              <TouchableOpacity style={styles.optionBtn} onPress={handleDeleteWord}>
                <Text style={styles.optionEmoji}>🗑️</Text>
                <Text style={[styles.optionText, styles.optionTextDanger]}>{t('aac.optionDelete')}</Text>
              </TouchableOpacity>
            ) : null}

          </View>
        </TouchableOpacity>
      </Modal>

      {/* Edit Name Modal */}
      <Modal visible={showEditName} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.editNameModal}>
            <Text style={styles.optionsTitle}>{t('aac.editNameTitle')}</Text>
            <Text style={styles.editLabel}>{t('aac.autoTagNameLabel', { lang: activeLanguageLabel })}</Text>
            <TextInput 
              style={styles.editInput} 
              value={editNameLabel} 
              onChangeText={setEditNameLabel} 
            />
            <View style={styles.editActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowEditName(false)}>
                <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={handleSaveEditName}>
                <Text style={styles.saveBtnText}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* AI Auto-Tag Confirmation (human-in-the-loop) — every field editable */}
      <Modal visible={showAutoTagConfirm} transparent animationType="slide">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <ScrollView contentContainerStyle={styles.autoTagScroll} bounces={false}>
            <View style={styles.autoTagModal}>
              <Text style={styles.optionsTitle}>{t('aac.autoTagTitle')}</Text>
              {pendingImageUri ? (
                <Image source={{ uri: pendingImageUri }} style={styles.autoTagImage} />
              ) : null}
              <Text style={styles.autoTagHint}>
                {t('aac.autoTagHint')}
              </Text>
              <Text style={styles.editLabel}>{t('aac.autoTagNameLabel', { lang: activeLanguageLabel })}</Text>
              <TextInput
                style={styles.editInput}
                value={pendingLabel}
                onChangeText={setPendingLabel}
                placeholder={t('aac.placeholder', { word: activeLanguagePlaceholder })}
                placeholderTextColor="#94A3B8"
              />
              <Text style={styles.autoTagHint}>
                {t('aac.autoTagOthersHint')}
              </Text>
              <Text style={styles.editLabel}>{t('aac.categoryLabel')}</Text>
              <View style={styles.chipRow}>
                {AUTO_TAG_CATEGORIES.map((cat) => {
                  const isActive = pendingCategory === cat.id;
                  return (
                    <TouchableOpacity
                      key={cat.id}
                      style={[styles.chip, isActive && styles.chipActive]}
                      onPress={() => {
                        setPendingCategory(cat.id);
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      }}
                    >
                      <FontAwesome5 name={cat.icon} size={12} color={isActive ? '#FFF' : cat.color} solid />
                      <Text style={[styles.chipText, isActive && styles.chipTextActive]}>{t(cat.labelKey)}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.editActions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={handleCancelAutoTag}>
                  <Text style={styles.cancelBtnText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={handleConfirmAutoTag}>
                  <Text style={styles.saveBtnText}>{t('aac.useResult')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Category Tab Bar (Motor Planning Standard) */}
      <View style={styles.categoryBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryScroll}>
          {categoriesConfig.map((cat) => (
            <CategoryTab
              key={cat.id}
              cat={cat}
              isActive={activeCategory === cat.id}
              highContrast={highContrast}
              onSelect={setActiveCategory}
            />
          ))}
        </ScrollView>
      </View>

      {/* Balasan Visual: modal gambar pengganti suara. Tap di mana saja
          untuk menutup (motor planning minimal), auto-tutup 6 dtk. */}
      <Modal visible={visualReply !== null} transparent animationType="fade" onRequestClose={() => setVisualReply(null)}>
        <Pressable style={vrStyles.overlay} onPress={() => setVisualReply(null)}>
          <View style={vrStyles.modalCard}>
            <View style={vrStyles.avatarRow}>
              <Image source={require('../../assets/icon.png')} style={vrStyles.avatar} />
              <Text style={vrStyles.senderName}>{childProfile?.nickname || t('aac.childFallback')}</Text>
            </View>
            {visualReply ? (
              <Image source={visualReply.image} style={[vrStyles.image, { width: vrImageSize, height: vrImageSize }]} resizeMode="contain" />
            ) : null}
            {visualReplyText ? (
              <Text style={vrStyles.caption} numberOfLines={2}>{visualReplyText}</Text>
            ) : null}
          </View>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F0F8FF' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F0F8FF' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center' },
  header: { 
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16, 
    paddingVertical: 12,
    backgroundColor: '#FFF',
    borderBottomWidth: 1, 
    borderBottomColor: '#E2E8F0',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarMini: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  title: { fontSize: 18, fontWeight: '900', color: '#11427B' },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  gridContainer: {
    flex: 1,
    padding: 10,
    backgroundColor: '#F8FAFC',
  },
  // High Contrast: pure white plate behind the cards so every solid card edge
  // is the strongest edge on screen (no off-white-on-off-white container).
  gridContainerContrast: {
    backgroundColor: '#FFFFFF',
  },
  graceBanner: {
    backgroundColor: '#FFF3D6',
    paddingVertical: 6,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  graceBannerText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#B45309',
  },
  softLockOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(248, 250, 252, 0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    zIndex: 10,
  },
  softLockEmoji: {
    fontSize: 42,
    marginBottom: 12,
  },
  softLockText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#475569',
    textAlign: 'center',
    lineHeight: 23,
  },
  topActionsContainer: {
    backgroundColor: '#F8FAFC',
    borderBottomWidth: 1,
    borderColor: '#E2E8F0',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    padding: 10,
    backgroundColor: '#FFF',
    borderTopWidth: 1,
    borderColor: '#E2E8F0',
  },
  actionBtnRed: { backgroundColor: '#FF6B6B', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, flex: 1, marginHorizontal: 4, alignItems: 'center' },
  actionBtnBlue: { backgroundColor: '#00B5B8', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, flex: 1, marginHorizontal: 4, alignItems: 'center' },
  actionBtnOrange: { backgroundColor: '#FF9800', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, flex: 1, marginHorizontal: 4, alignItems: 'center' },
  actionBtnDisabled: { backgroundColor: '#B0BEC5', elevation: 0 },
  actionBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 14 },
  
  categoryBar: {
    backgroundColor: '#11427B',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    elevation: 10,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  categoryScroll: {
    paddingHorizontal: 8,
  },
  catBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 70,
    paddingVertical: 14,
    opacity: 0.6,
  },
  catBtnActive: {
    opacity: 1,
  },
  // High Contrast: inactive tabs are still visibly "off" (so the child can
  // read the hierarchy) but never so faint they become invisible.
  catBtnContrast: {
    opacity: 0.9,
  },
  catTextContrast: {
    fontSize: 13,
    fontWeight: '900',
  },
  activeHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  activeIndicator: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 4,
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
  activeIndicatorContrast: {
    height: 6,
  },
  catText: { color: '#FFF', fontSize: 12, fontWeight: 'bold' },
  
  optionsModal: { backgroundColor: '#FFF', padding: 20, borderRadius: 24, width: '80%', alignSelf: 'center', elevation: 10, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10 },
  optionsTitle: { fontSize: 20, fontWeight: '900', color: '#11427B', textAlign: 'center', marginBottom: 20 },
  optionBtn: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderColor: '#F1F5F9' },
  optionEmoji: { fontSize: 24, marginRight: 16 },
  optionText: { fontSize: 16, fontWeight: 'bold', color: '#334155' },

  editNameModal: { backgroundColor: '#FFF', padding: 24, borderRadius: 24, width: '85%', alignSelf: 'center' },
  editLabel: { fontSize: 14, fontWeight: 'bold', color: '#64748B', marginBottom: 8, marginTop: 12 },
  editInput: { borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 12, padding: 12, fontSize: 16, color: '#0F172A' },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 24, gap: 12 },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 20 },
  cancelBtnText: { color: '#94A3B8', fontWeight: 'bold', fontSize: 16 },
  saveBtn: { backgroundColor: '#00B5B8', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 12 },
  saveBtnText: { color: '#FFF', fontWeight: 'bold', fontSize: 16 },

  optionTextDanger: { color: '#EF4444' },

  autoTagScroll: { flexGrow: 1, justifyContent: 'center' },
  autoTagModal: { backgroundColor: '#FFF', padding: 24, borderRadius: 24, width: '88%', alignSelf: 'center' },
  autoTagImage: { width: 88, height: 88, borderRadius: 16, alignSelf: 'center', marginBottom: 10, backgroundColor: '#F1F5F9' },
  autoTagHint: { fontSize: 13, color: '#64748B', textAlign: 'center', marginBottom: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4, marginBottom: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: '#E2E8F0' },
  chipActive: { backgroundColor: '#00B5B8', borderColor: '#00B5B8' },
  chipText: { fontSize: 13, fontWeight: '600', color: '#475569' },
  chipTextActive: { color: '#FFF', fontWeight: '800' }
});

// ── Styles modal Balasan Visual (dipisah agar anchor styles utama aman) ─────
const vrStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 28,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#FFFFFF',
    borderRadius: 32,
    padding: 20,
    alignItems: 'center',
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginBottom: 14,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#E0F2FE',
    marginRight: 10,
  },
  senderName: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#11427B',
  },
  // Ukuran (width/height) di-set dinamis dari useWindowDimensions agar
  // gambar selalu muat di dalam modalCard pada orientasi & ukuran layar apa
  // pun — bukan lagi width:'100%' yang bisa meluber di landscape.
  image: {
    borderRadius: 24,
    backgroundColor: '#F1F5F9',
  },
  caption: {
    marginTop: 14,
    fontSize: 18,
    fontWeight: '700',
    color: '#1E293B',
    textAlign: 'center',
  },
});
