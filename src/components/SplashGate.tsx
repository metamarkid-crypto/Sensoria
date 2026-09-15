import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, Text, useColorScheme } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import { useTranslation } from '../i18n';
import { useAACStore } from '../store/useAACStore';

/**
 * Hold the native splash screen until THIS component says otherwise. Called at
 * module scope (not inside a hook) so it registers before the first frame —
 * otherwise the splash could vanish before we get the chance to hold it.
 */
SplashScreen.preventAutoHideAsync().catch(() => {
  /* dev clients / Expo Go may refuse — non-fatal */
});

/** Minimum brand display time (ms) so the launch never "flickers" past. */
const MIN_BRAND_MS = 1200;
/** Wordmark/tagline fade-in delay + duration. */
const BRAND_IN_DELAY_MS = 220;
const BRAND_IN_DURATION_MS = 480;
/** Overlay fade-out duration before the navigator takes over. */
const FADE_OUT_MS = 380;
/** Absolute failsafe: never trap the user behind the splash. */
const FORCE_REVEAL_MS = 8000;

/**
 * SplashGate — the seamless bridge between the native splash and the app.
 *
 * Problem it solves: the navigator mounts on frame one, but zustand's
 * persisted store (role, onboarding, profile) rehydrates from AsyncStorage
 * a few frames LATER. Every launch therefore flashed the RoleSelection
 * screen before jumping to the real screen.
 *
 * Sequence:
 *   1. native splash (icon glyph on brand sky) stays visible;
 *   2. once hydration finished AND the minimum brand time elapsed, an
 *      overlay with the same brand look fades in (hero + wordmark + tagline);
 *   3. the native splash hides behind that overlay (invisible switch);
 *   4. the overlay fades out into the navigator — which by now renders the
 *      CORRECT screen for the restored role.
 *
 * Dark mode mirrors the native splash config: deep navy backdrop, light
 * wordmark via tintColor, same hero glyph (the scene art pops on navy).
 */
export default function SplashGate() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const { t } = useTranslation();

  // 1 ── hydration + minimum-display gates
  const [hydrated, setHydrated] = useState(() => useAACStore.persist.hasHydrated());
  useEffect(() => {
    const unsub = useAACStore.persist.onFinishHydration(() => setHydrated(true));
    if (useAACStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, []);

  const [minBrandDone, setMinBrandDone] = useState(false);
  const [forceReveal, setForceReveal] = useState(false);
  useEffect(() => {
    const min = setTimeout(() => setMinBrandDone(true), MIN_BRAND_MS);
    const force = setTimeout(() => setForceReveal(true), FORCE_REVEAL_MS);
    return () => {
      clearTimeout(min);
      clearTimeout(force);
    };
  }, []);

  // 2 ── phase machine: hold → brand-in → fade-out → hidden
  const [phase, setPhase] = useState<'hold' | 'brand' | 'fading' | 'done'>('hold');
  useEffect(() => {
    if (phase !== 'hold') return;
    if ((hydrated && minBrandDone) || forceReveal) setPhase('brand');
  }, [phase, hydrated, minBrandDone, forceReveal]);

  const overlayOpacity = useRef(new Animated.Value(1)).current;
  const brandOpacity = useRef(new Animated.Value(0)).current;
  const brandTranslate = useRef(new Animated.Value(10)).current;

  useEffect(() => {
    if (phase !== 'brand') return;
    // Wordmark + tagline slide/fade in, THEN the whole overlay starts fading.
    Animated.parallel([
      Animated.timing(brandOpacity, {
        toValue: 1,
        delay: BRAND_IN_DELAY_MS,
        duration: BRAND_IN_DURATION_MS,
        useNativeDriver: true,
      }),
      Animated.timing(brandTranslate, {
        toValue: 0,
        delay: BRAND_IN_DELAY_MS,
        duration: BRAND_IN_DURATION_MS,
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) return;
      setPhase('fading');
    });
  }, [phase, brandOpacity, brandTranslate]);

  const finishReveal = useCallback(() => {
    setPhase('done');
    SplashScreen.hideAsync().catch(() => {
      /* already hidden */
    });
  }, []);

  useEffect(() => {
    if (phase !== 'fading') return;
    Animated.timing(overlayOpacity, {
      toValue: 0,
      duration: FADE_OUT_MS,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) finishReveal();
      else setTimeout(finishReveal, FADE_OUT_MS);
    });
  }, [phase, overlayOpacity, finishReveal]);

  if (phase === 'done') return null;

  return (
    <Animated.View style={[styles.backdrop, isDark ? styles.backdropDark : styles.backdropLight, { opacity: overlayOpacity }]} pointerEvents="none">
      {/* Hero glyph — the SAME art the native splash shows, so the handoff
          from native splash to this overlay is pixel-seamless. */}
      <Image
        source={require('../../assets/splash-icon.png')}
        style={styles.hero}
        resizeMode="contain"
        fadeDuration={0}
      />
      <Animated.View
        style={[
          styles.brandBlock,
          { opacity: brandOpacity, transform: [{ translateY: brandTranslate }] },
        ]}
        pointerEvents="none"
      >
        <Image
          source={require('../../assets/sensoria.png')}
          style={styles.wordmark}
          resizeMode="contain"
          tintColor={isDark ? '#E1F2FD' : undefined}
          fadeDuration={0}
        />
        <Text style={[styles.tagline, isDark && styles.taglineDark]}>{t('splash.tagline')}</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 10,
    zIndex: 999,
  },
  backdropLight: {
    backgroundColor: '#F2FAFE',
  },
  backdropDark: {
    backgroundColor: '#0B2545',
  },
  hero: {
    width: 220,
    height: 220,
    marginBottom: 18,
  },
  brandBlock: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  wordmark: {
    width: 208,
    height: 65, // 500×156 aspect
    marginBottom: 10,
  },
  tagline: {
    fontSize: 13,
    letterSpacing: 0.6,
    color: 'rgba(17,66,123,0.72)',
    fontWeight: '600',
    textAlign: 'center',
  },
  taglineDark: {
    color: 'rgba(225,242,253,0.72)',
  },
});
