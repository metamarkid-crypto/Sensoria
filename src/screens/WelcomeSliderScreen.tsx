import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Dimensions, TouchableOpacity, Image, ActivityIndicator, Platform } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAACStore } from '../store/useAACStore';
import { useTranslation, type TranslationKey } from '../i18n';
import { logger } from '../utils/logger';

const { width, height } = Dimensions.get('window');

interface Slide {
  id: string;
  titleKey: TranslationKey;
  image: any;
}

const SLIDES: Slide[] = [
  {
    id: '1',
    titleKey: 'welcome.title1',
    image: require('../../assets/onboarding1.png')
  },
  {
    id: '2',
    titleKey: 'welcome.title2',
    image: require('../../assets/onboarding2.png')
  },
  {
    id: '3',
    titleKey: 'welcome.title3',
    image: require('../../assets/onboarding3.png')
  }
];

export default function WelcomeSliderScreen({ navigation }: any) {
  const { t } = useTranslation();
  const { setHasSeenOnboarding } = useAACStore();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    const preloadAssets = async () => {
      try {
        // Preload local assets to memory to prevent flickering during fast swipes
        await Promise.all(SLIDES.map(slide => 
          Image.prefetch(Image.resolveAssetSource(slide.image).uri)
        ));
      } catch (error) {
        console.warn('Failed to preload some onboarding images', error);
      } finally {
        setAssetsLoaded(true);
      }
    };
    preloadAssets();
  }, []);

  const handleSkip = () => {
    logger.logInfo('Onboarding Skipped', { slide_index: currentIndex });
    setHasSeenOnboarding(true);
  };

  const handleComplete = () => {
    logger.logInfo('Onboarding Completed');
    setHasSeenOnboarding(true);
  };

  const handleNext = () => {
    if (currentIndex < SLIDES.length - 1) {
      flatListRef.current?.scrollToIndex({ index: currentIndex + 1, animated: true });
    } else {
      handleComplete();
    }
  };

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems[0]) {
      setCurrentIndex(viewableItems[0].index);
    }
  }).current;

  const renderSlide = ({ item }: { item: typeof SLIDES[0] }) => (
    <View style={styles.slideContainer}>
      <Image source={item.image} style={styles.fullImage} resizeMode="cover" accessible={true} accessibilityLabel={t('welcome.illustration', { title: t(item.titleKey) })} />
    </View>
  );

  if (!assetsLoaded) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#2488FF" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.sliderWrapper}>
        <FlatList
          ref={flatListRef}
          data={SLIDES}
          renderItem={renderSlide}
          keyExtractor={(item) => item.id}
          horizontal
          showsHorizontalScrollIndicator={false}
          pagingEnabled
          bounces={false}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ viewAreaCoveragePercentThreshold: 50 }}
        />
      </View>
      
      <View style={[styles.footerContainer, { paddingBottom: Math.max(insets.bottom, 10) + 10 }]}>
        <TouchableOpacity 
          style={styles.skipButton} 
          onPress={handleSkip}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel={t('welcome.skipA11y')}
        >
          <Text style={styles.skipText}>{t('welcome.skip')}</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={styles.nextButton} 
          onPress={handleNext}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel={currentIndex === SLIDES.length - 1 ? t('welcome.start') : t('welcome.next')}
        >
          <Text style={styles.nextText}>
            {currentIndex === SLIDES.length - 1 ? t('welcome.start') : t('welcome.next')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF', // Pure white background
  },
  sliderWrapper: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  slideContainer: {
    width,
    flex: 1,
    padding: 16,
    paddingBottom: 40, // space for buttons
  },
  fullImage: {
    flex: 1,
    width: '100%',
    height: '100%',
    borderRadius: 24, // nice rounded corners for elegance
    overflow: 'hidden',
  },
  footerContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
    backgroundColor: 'transparent',
  },
  skipButton: {
    paddingVertical: 12,
    paddingLeft: 12,
    width: 90,
  },
  skipText: {
    color: '#94A3B8',
    fontSize: 16,
    fontWeight: 'bold',
  },
  nextButton: {
    backgroundColor: '#2488FF', // Cheerful blue
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 30,
    minWidth: 100,
    alignItems: 'center',
    shadowColor: '#2488FF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  nextText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  }
});
