import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, StyleSheet, ActivityIndicator, Text, TouchableOpacity, ScrollView, Modal, TextInput, KeyboardAvoidingView, Platform, Image } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation } from '@react-navigation/native';
import { useAACStore, AACWord, resolveWordText } from '../store/useAACStore';
import { evaluateAccess } from '../services/db/entitlement';
import { initDB, getAllWords, addCustomWord, updateWord, setWordFavorite } from '../services/db/sqlite';
import { tagImageWithBilingualNames, translateWordBilingual, isNoConfidenceTag } from '../services/ai/gemini';
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
import { useTranslation } from '../i18n';
import SettingsScreen from './SettingsScreen';
import { supabase, sendAACMessage, subscribeToAACMessages, syncCustomWordToCloud } from '../services/db/supabase';
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
] as const;

export default function ChildAACScreen() {
  const navigation = useNavigation<any>();
  const { 
    currentSentence, clearSentence, addToSentence, setRole, 
    language, childProfile, pairingCode, deviceId, 
    setSpeechRate,
    cardSize, cardSpacing, speakOnTap,
    premium
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
  const insets = useSafeAreaInsets();
  
  // Word Options State
  const [selectedWord, setSelectedWord] = useState<AACWord | null>(null);
  const [showWordOptions, setShowWordOptions] = useState(false);
  const [showEditName, setShowEditName] = useState(false);
  // Single editable field bound to the ACTIVE app language — resolved with
  // the SAME resolver cards and TTS use, so what you see/edit is what speaks.
  const [editNameLabel, setEditNameLabel] = useState('');

  // ── AI Auto-Tag confirmation draft (frictionless trilingual) ────────
  // The AI result is NEVER auto-saved: it only pre-fills this editable
  // draft. The user sees and edits ONE input — their active app language —
  // while the other two languages are stored silently and auto-filled in
  // background. Any failure (network / timeout / no-confidence) opens the
  // same form blank — the human always has the final word.
  const [showAutoTagConfirm, setShowAutoTagConfirm] = useState(false);
  const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState('');
  const [pendingEn, setPendingEn] = useState('');
  const [pendingZh, setPendingZh] = useState('');
  const [pendingCategory, setPendingCategory] = useState<string>('noun');

  // The single visible input binds to the ACTIVE app language.
  const activeLang = language;
  const pendingLabel =
    activeLang === 'id' ? pendingId : activeLang === 'en' ? pendingEn : pendingZh;
  const setPendingLabel = (text: string) => {
    if (activeLang === 'id') setPendingId(text);
    else if (activeLang === 'en') setPendingEn(text);
    else setPendingZh(text);
  };
  const activeLanguageLabel = activeLang === 'id' ? t('aac.langNameId') : activeLang === 'en' ? t('aac.langNameEn') : t('aac.langNameZh');
  const activeLanguagePlaceholder = activeLang === 'id' ? 'Bola' : activeLang === 'en' ? 'Ball' : '球';
  // What the AI proposed for the ACTIVE language (null = manual fallback).
  // Used to detect "user corrected the AI word" → siblings need re-translation.
  const aiOriginalRef = useRef<string | null>(null);

  useEffect(() => {
    loadDatabase();
    setupLocation();
    
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
          useAACStore.setState(data.settings);
        }
      } catch (err) {
        console.warn('Catch-up Sync failed (Offline Mode Active):', err);
        logger.logError(err, { action: 'Catch-up Sync Failed', role: 'Child' });
      }
    };
    catchUpSync();

    if (!pairingCode) return;
    
    logger.setUserContext('Child', pairingCode);

    const channel = subscribeToAACMessages(pairingCode, (payload: any) => {
      if (payload.sender === 'Parent') {
        const senderName = payload.senderName || 'Parent';
        playTTS(payload.text, language, senderName);
        Toast.show({ type: 'info', text1: t('aac.toastParentMsg'), text2: payload.text, position: 'top', visibilityTime: 4000 });
      }
    });

    const settingsChannel = supabase.channel('child-settings-update')
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

            // Juga terapkan setting langsung (jika ada settings lain seperti speechRate dll)
            useAACStore.setState(payload.new.settings);
          }
        }
      )
      .subscribe();

    const familyLinksChannel = supabase.channel('child_family_links')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'family_links', filter: `child_device_id=eq.${deviceId}` },
        (payload) => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          Toast.show({ 
            type: 'success', 
            text1: t('aac.toastLinked'), 
            text2: t('aac.toastLinkedDesc'), 
            position: 'top',
            visibilityTime: 4000
          });
        }
      )
      .subscribe();

    // Parent "refresh location" ping → force one immediate GPS write.
    const pingChannel = supabase.channel(`location-ping-${deviceId}`)
      .on('broadcast', { event: 'refresh-location' }, () => {
        requestImmediateLocation()
          .then(() => {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            Toast.show({ type: 'success', text1: t('aac.toastLocationSent'), text2: t('aac.toastLocationSentDesc'), position: 'top' });
          })
          .catch((e) => console.warn('[LocationPing] refresh failed:', e));
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      supabase.removeChannel(settingsChannel);
      supabase.removeChannel(familyLinksChannel);
      supabase.removeChannel(pingChannel);
    };
  }, []);

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
      await sendAACMessage(pairingCode, {
        sender: 'Child',
        senderName: childProfile?.nickname || t('aac.childFallback'),
        text: fullText,
        timestamp: Date.now(),
        location: loc ? { latitude: loc.coords.latitude, longitude: loc.coords.longitude } : null
      });
      Toast.show({ type: 'success', text1: t('aac.toastSent'), text2: t('aac.toastSentDesc'), position: 'top' });
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

      let aiPrefill: { id: string; en: string; zh: string; category: string } | null = null;
      try {
        const tags = await withTimeout(tagImageWithBilingualNames(imageUri), AI_TAG_TIMEOUT_MS);
        // gemini.ts answers with a generic placeholder whenever it cannot
        // parse a confident response — treat that as "no confidence" so the
        // user always lands on the editable manual form instead of a junk
        // card name.
        if (!isNoConfidenceTag(tags)) {
          aiPrefill = { id: tags.id, en: tags.en, zh: tags.zh, category: tags.category };
        }
      } catch (e) {
        logger.logError(e, { action: 'AI auto-tag failed — manual fallback', role: 'Child' });
      } finally {
        setIsProcessingAI(false);
      }

      if (aiPrefill) {
        // Trilingual stored silently; the UI only shows ONE editable input
        // bound to the user's active language.
        setPendingId(aiPrefill.id);
        setPendingEn(aiPrefill.en);
        setPendingZh(aiPrefill.zh);
        setPendingCategory(aiPrefill.category);
        aiOriginalRef.current =
          activeLang === 'id' ? aiPrefill.id : activeLang === 'en' ? aiPrefill.en : aiPrefill.zh;
      } else {
        setPendingId('');
        setPendingEn('');
        setPendingZh('');
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
    // The other two keep their silent AI prediction, or — when there is none
    // (manual fallback) — start as the SAME typed word (never empty), and are
    // auto-translated in background without blocking the UI.
    const label = pendingLabel.trim();
    const nameId = activeLang === 'id' ? label : (pendingId || label);
    const nameEn = activeLang === 'en' ? label : (pendingEn || label);
    const nameZh = activeLang === 'zh' ? label : (pendingZh || label);
    const newWord: AACWord = {
      id: Date.now().toString(),
      word_id: nameId,
      word_en: nameEn,
      word_zh: nameZh,
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

    // Non-blocking background tasks: cloud backup + translation of the
    // languages the user did not type. Failures are logged, never surfaced
    // as blocking errors — the card is already saved and usable offline.
    void syncCustomWordToCloud(newWord, deviceId).catch((e: any) => {
      logger.logError(e, { action: 'custom_words cloud sync failed', role: 'Child' });
    });
    // Translate when the save did NOT originate from a trusted AI prefill
    // (manual fallback), or when the user corrected the AI's word — in both
    // cases the silent siblings are placeholders/stale. The human's typed
    // label is never overwritten: only the OTHER two languages are patched.
    const needsTranslation =
      aiOriginalRef.current === null || label !== aiOriginalRef.current;
    if (needsTranslation) {
      void translateWordBilingual(label, activeLang)
        .then((trilingual) => {
          const patch: Partial<AACWord> = {};
          if (activeLang !== 'id') patch.word_id = trilingual.id;
          if (activeLang !== 'en') patch.word_en = trilingual.en;
          if (activeLang !== 'zh') patch.word_zh = trilingual.zh;
          return updateWord(newWord.id, patch).then(() => loadDatabase());
        })
        .catch((e: any) => {
          logger.logError(e, { action: 'background trilingual fill failed', role: 'Child' });
        });
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
    else patch.word_zh = label;

    // The old label's cached AI voice is stale after a rename — evict it.
    await clearAudioCache(previousLabel, activeLang, 'Child');

    await updateWord(selectedWord.id, patch);
    await loadDatabase();

    setShowEditName(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // Keep the trilingual dataset sealed: when the label actually changed,
    // refresh the OTHER two languages in the background so word_en and
    // word_zh stay in sync in SQLite. Fire-and-forget — never blocks the UI;
    // failures are logged, the renamed card is already saved and usable.
    if (label !== previousLabel) {
      void translateWordBilingual(label, activeLang)
        .then(async (trilingual) => {
          // Evict the pre-edit sibling caches so the next playback fetches
          // a voice for the NEW name instead of playing the stale one.
          if (activeLang !== 'id' && selectedWord.word_id) await clearAudioCache(selectedWord.word_id, 'id', 'Child');
          if (activeLang !== 'en' && selectedWord.word_en) await clearAudioCache(selectedWord.word_en, 'en', 'Child');
          if (activeLang !== 'zh' && selectedWord.word_zh) await clearAudioCache(selectedWord.word_zh, 'zh', 'Child');

          const siblingPatch: Partial<AACWord> = {};
          if (activeLang !== 'id') siblingPatch.word_id = trilingual.id;
          if (activeLang !== 'en') siblingPatch.word_en = trilingual.en;
          if (activeLang !== 'zh') siblingPatch.word_zh = trilingual.zh;
          return updateWord(selectedWord.id, siblingPatch).then(() => loadDatabase());
        })
        .catch((e: any) => {
          logger.logError(e, { action: 'background trilingual rename failed', role: 'Child' });
        });
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

          <TouchableOpacity 
            style={styles.iconButton} 
            onPress={() => {
              Toast.show({
                type: 'info',
                text1: t('aac.lockedTitle'),
                text2: t('aac.lockedDesc'),
                position: 'top',
                visibilityTime: 2000,
              });
            }}
            onLongPress={() => navigation.navigate('Settings')}
          >
            <FontAwesome5 name="cog" size={20} color="#94A3B8" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Compassionate grace: subtle, non-blocking subscription nudge */}
      {childInGrace ? (
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
          <TouchableOpacity style={styles.actionBtnOrange} onPress={sendToParentFiltered}>
            <Text style={styles.actionBtnText}>🚀 {t('aac.send')}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Grid */}
      <View style={styles.gridContainer}>
        <AACGrid words={filteredWords} onWordPress={handleCardPress} onWordLongPress={handleWordLongPress} />

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
          {categoriesConfig.map((cat) => {
            const isActive = activeCategory === cat.id;
            return (
              <TouchableOpacity 
                key={cat.id} 
                style={[styles.catBtn, isActive && styles.catBtnActive]} 
                onPress={() => setActiveCategory(cat.id)}
              >
                {isActive && (
                  <LinearGradient
                    colors={[`rgba(${cat.rgba}, 0)`, `rgba(${cat.rgba}, 0.5)`]}
                    style={styles.activeHighlight}
                  />
                )}
                <FontAwesome5 name={cat.icon} size={22} color="#FFF" solid style={{ marginBottom: 6 }} />
                <Text style={[styles.catText, isActive && { fontWeight: '900' }]}>{t(cat.labelKey)}</Text>
                {isActive && <View style={[styles.activeIndicator, { backgroundColor: cat.color }]} />}
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
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
