import React, { useRef } from 'react';
import { View, Text, Image, StyleSheet, Animated, Pressable } from 'react-native';
import { AACWord, useAACStore } from '../../store/useAACStore';
import { getLocalImage } from '../../assets/imageMap';

interface AACCardProps {
  item: AACWord;
  onPress: (word: AACWord) => void;
  onLongPress?: (word: AACWord) => void;
  size?: 'small' | 'large';
}

const AACCard = React.memo(({ item, onPress, onLongPress }: AACCardProps) => {
  const language = useAACStore(state => state.language);
  const childProfile = useAACStore(state => state.childProfile);
  const textSize = useAACStore(state => state.textSize);
  const enableCategoryColors = useAACStore(state => state.enableCategoryColors);
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
  let bgColor = '#FFFFFF';
  let borderColor = '#F1F5F9';
  
  if (enableCategoryColors) {
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
      }]}>
        {item.isFavorite ? (
          <View style={styles.favBadge} pointerEvents="none">
            <Text style={styles.favBadgeText}>⭐</Text>
          </View>
        ) : null}
        <Image 
          source={imageSource} 
          style={styles.image} 
          resizeMode="contain"
        />
        <Text style={[styles.text, { fontSize: getFontSize() }]} numberOfLines={1}>
          {language === 'id' ? item.word_id : item.word_zh}
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
    width: '70%',
    height: '70%',
    marginBottom: 8,
  },
  text: {
    fontWeight: '800',
    color: '#11427B',
    textAlign: 'center',
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
