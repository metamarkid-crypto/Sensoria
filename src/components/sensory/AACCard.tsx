import React, { useRef } from 'react';
import { View, Text, Image, StyleSheet, Animated, Pressable } from 'react-native';
import { AACWord, useAACStore, resolveWordText } from '../../store/useAACStore';
import { getLocalImage } from '../../assets/imageMap';

interface AACCardProps {
  item: AACWord;
  onPress: (word: AACWord) => void;
  onLongPress?: (word: AACWord) => void;
  size?: 'small' | 'large';
}

/**
 * HIGH CONTRAST palette (Appearance → Kontras Tinggi).
 *
 * The normal category colors are near-white 4% tints (#EFF6FF, #FFF0F5, …)
 * designed to sit quietly behind pictograms — which is exactly why the toggle
 * looked broken: switching it on changed nothing visible. These are the SOLID
 * equivalents: a saturated fill with a dark same-hue border, so a card edge is
 * a real edge at any visual acuity.
 *
 * Contrast: every fill pairs with the navy label (#0B2545) at ≥ 7:1 (WCAG AAA
 * for normal text), and each border is ≥ 3:1 against the neighbouring card
 * (WCAG 1.4.11 non-text contrast), so adjacent cards in a grid stay separable.
 */
const HIGH_CONTRAST_CATEGORY: Record<string, { bg: string; border: string }> = {
  pronoun: { bg: '#FFC2D1', border: '#AD1457' },
  verb: { bg: '#86EFAC', border: '#15803D' },
  noun: { bg: '#93C5FD', border: '#1D4ED8' },
  social: { bg: '#C4B5FD', border: '#6D28D9' },
  emotion: { bg: '#FCD34D', border: '#B45309' },
  body: { bg: '#FCA5A5', border: '#B91C1C' },
  number: { bg: '#67E8F9', border: '#0E7490' },
  people: { bg: '#A5B4FC', border: '#4338CA' },
  food: { bg: '#FDA4AF', border: '#BE123C' },
  place: { bg: '#7DD3FC', border: '#0369A1' },
  time: { bg: '#5EEAD4', border: '#0F766E' },
  animal: { bg: '#BEF264', border: '#4D7C0F' },
  clothing: { bg: '#F0ABFC', border: '#A21CAF' },
  color: { bg: '#D8B4FE', border: '#7E22CE' },
};

const AACCard = React.memo(({ item, onPress, onLongPress }: AACCardProps) => {
  const language = useAACStore(state => state.language);
  const childProfile = useAACStore(state => state.childProfile);
  const textSize = useAACStore(state => state.textSize);
  const enableCategoryColors = useAACStore(state => state.enableCategoryColors);
  const highContrast = useAACStore(state => state.highContrast);
  const holdDuration = useAACStore(state => state.holdDuration);
  const ignoreRepeat = useAACStore(state => state.ignoreRepeat);
  const releaseToSpeak = useAACStore(state => state.releaseToSpeak);
  
  const scaleValue = useRef(new Animated.Value(1)).current;
  const opacityValue = useRef(new Animated.Value(1)).current;
  const lastPressTime = useRef<number>(0);

  const handlePressIn = () => {
    // Immediate Visual Feedback (Opacity)
    Animated.timing(opacityValue, {
      toValue: 0.6,
      duration: 50,
      useNativeDriver: true,
    }).start();

    // Spring scaling
    Animated.spring(scaleValue, {
      toValue: 0.95,
      useNativeDriver: true,
      bounciness: 15,
    }).start();
  };

  // Removed unused onPressOut
  
  // Determine image source
  let imageSource = null;
  if (item.isCustom) {
    imageSource = { uri: item.imageUrl };
  } else {
    // word_id ex: "Saya", transform to "saya.png"
    const expectedFilename = `${item.word_id.toLowerCase().replace(/\s+/g, '_')}.png`;
    
    // Attempt to load from local mapped assets
    imageSource = getLocalImage(expectedFilename, childProfile?.gender?.toLowerCase() as 'boy' | 'girl');
    if (!imageSource && item.imageUrl) {
      // Fallback if not found in mapping (Remote ARASAAC Community)
      imageSource = { uri: item.imageUrl };
    }
  }

  // Determine Semantic Colors
  // High Contrast swaps the quiet tints for solid fills; when category colors
  // are OFF it keeps a pure-white card with a dark navy border, so the toggle
  // still strengthens every card instead of doing nothing.
  let bgColor = '#FFFFFF';
  let borderColor = highContrast ? '#0B2545' : '#F1F5F9';

  if (highContrast) {
    const solid = HIGH_CONTRAST_CATEGORY[item.categoryId];
    if (enableCategoryColors && solid) {
      bgColor = solid.bg;
      borderColor = solid.border;
    }
  } else if (enableCategoryColors) {
    switch (item.categoryId) {
      case 'pronoun':
        bgColor = '#FFF0F5'; // Soft Pink
        borderColor = '#FFB6C1';
        break;
      case 'verb':
        bgColor = '#F0FDF4'; // Soft Green
        borderColor = '#BBF7D0';
        break;
      case 'noun':
        bgColor = '#EFF6FF'; // Soft Blue
        borderColor = '#BFDBFE';
        break;
      case 'social':
        bgColor = '#F5F3FF'; // Soft Purple
        borderColor = '#DDD6FE';
        break;
      case 'emotion':
        bgColor = '#FFFbeb'; // Soft Yellow
        borderColor = '#FDE68A';
        break;
      case 'body':
        bgColor = '#FFF5F5'; // Soft Red
        borderColor = '#FECACA';
        break;
      case 'number':
        bgColor = '#F0FDFA'; // Soft Cyan
        borderColor = '#A5F3FC';
        break;
      case 'people':
        bgColor = '#EEF2FF'; // Soft Indigo
        borderColor = '#C7D2FE';
        break;
      case 'food':
        bgColor = '#FFF1F2'; // Soft Rose
        borderColor = '#FECDD3';
        break;
      case 'place':
        bgColor = '#F0F9FF'; // Soft Sky
        borderColor = '#BAE6FD';
        break;
      case 'time':
        bgColor = '#F0FDFA'; // Soft Teal
        borderColor = '#99F6E4';
        break;
      case 'animal':
        bgColor = '#F7FEE7'; // Soft Lime
        borderColor = '#D9F99D';
        break;
      case 'clothing':
        bgColor = '#FDF4FF'; // Soft Fuchsia
        borderColor = '#F5D0FE';
        break;
      case 'color':
        bgColor = '#FAF5FF'; // Soft Purple
        borderColor = '#E9D5FF';
        break;
      default:
        bgColor = '#FFFFFF';
        borderColor = '#F1F5F9';
    }
  }

  // Dynamic Text Size
  const getFontSize = () => {
    switch (textSize) {
      case 'A-': return 12;
      case 'A+': return 18;
      case 'A':
      default: return 15;
    }
  };

  // --- ACCESSIBILITY LOGIC ---
  const handleAction = () => {
    if (ignoreRepeat) {
      const now = Date.now();
      if (now - lastPressTime.current < 1500) {
        return; // Ignore rapid repeated touches within 1.5 seconds
      }
      lastPressTime.current = now;
    }
    onPress(item);
  };

  const handlePress = () => {
    if (holdDuration > 0) return; // Disabled normal tap if hold is required
    if (releaseToSpeak) return; // Disabled normal tap if releaseToSpeak is active
    handleAction();
  };

  const handlePressOut = () => {
    // Immediate Visual Feedback Out (Opacity)
    Animated.timing(opacityValue, {
      toValue: 1,
      duration: 150,
      useNativeDriver: true,
    }).start();

    // Spring animation out
    Animated.spring(scaleValue, {
      toValue: 1,
      useNativeDriver: true,
      bounciness: 15,
    }).start();

    // Trigger action on release if configured
    if (holdDuration === 0 && releaseToSpeak) {
      handleAction();
    }
  };

  const handleLongPress = () => {
    if (holdDuration > 0) {
      handleAction(); // Trigger main action on long press if holdDuration > 0
    }
    
    // Call external long press prop if it exists (for editing, etc.)
    if (onLongPress) {
      onLongPress(item);
    }
  };

  return (
    <Pressable 
      style={{ flex: 1 }}
      onPress={handlePress}
      onLongPress={handleLongPress}
      delayLongPress={holdDuration > 0 ? holdDuration * 1000 : 500}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      <Animated.View style={[styles.card, { 
        transform: [{ scale: scaleValue }],
        opacity: opacityValue,
        backgroundColor: bgColor,
        borderColor: borderColor,
        borderWidth: highContrast ? 2 : 1,
      }]}>
        {item.isFavorite ? (
          <View style={styles.favBadge} pointerEvents="none">
            <Text style={styles.favBadgeText}>⭐</Text>
          </View>
        ) : null}
        <Image 
          source={imageSource} 
          style={[styles.image, highContrast && styles.imageContrast]} 
          resizeMode="contain"
        />
        <Text
          style={[
            styles.text,
            { fontSize: getFontSize() },
            highContrast && styles.textContrast,
          ]}
          numberOfLines={1}
        >
          {resolveWordText(item, language)}
        </Text>
      </Animated.View>
    </Pressable>
  );
});

export default AACCard;

const styles = StyleSheet.create({
  card: {
    flex: 1,
    aspectRatio: 0.85,
    borderRadius: 16,
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
    borderWidth: 1,
  },
  image: {
    // Fill ALL vertical space above the label at FULL card width instead of
    // the old fixed 70%×70% square. resizeMode="contain" (in JSX) letterboxes
    // inside whatever box flex leaves, so:
    //  • 500×500 square pictograms render edge-to-edge (up from 70% width);
    //  • tall 150×220 legacy sprites scale by HEIGHT and actually appear
    //    LARGER instead of shrinking inside an empty square;
    //  • the label row always fits — no overflow at textSize A-/A/A+ and no
    //    clipping at any grid density (2/3/4/5 columns).
    flex: 1,
    width: '100%',
    marginBottom: 4,
  },
  text: {
    fontWeight: '800',
    color: '#11427B',
    textAlign: 'center',
  },
  // White plate under the pictogram: on a solid saturated card the transparent
  // PNG line-art would otherwise lose its background contrast.
  imageContrast: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
  },
  textContrast: {
    color: '#0B2545',
    fontWeight: '900',
  },
  favBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
  },
  favBadgeText: {
    fontSize: 12,
    lineHeight: 14,
  },
});
