import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, LayoutAnimation, UIManager, Platform, Image } from 'react-native';
import { useAACStore, resolveWordText } from '../../store/useAACStore';
import * as Haptics from 'expo-haptics';
import { playTTS } from '../../services/ai/audioManager';
import { useTranslation } from '../../i18n';
import { getLocalImage } from '../../assets/imageMap';

export default function SentenceStrip() {
  const { t } = useTranslation();
  const { currentSentence, removeFromSentence, language, childProfile } = useAACStore();

  useEffect(() => {
    // Trigger animation when items are added or removed
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [currentSentence.length]);

  const handleRemove = (index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    removeFromSentence(index);
  };

  const speakWord = (text: string) => {
    playTTS(text, language, 'Child');
  };

  return (
    <View style={styles.container}>
      {currentSentence.length === 0 ? (
        <Text style={styles.placeholderText}>{t('aac.sentencePlaceholder')}</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          {currentSentence.map((item, index) => {
            const wordText = resolveWordText(item, language);
            
            let imageSource = null;
            if (item.isCustom) {
              imageSource = { uri: item.imageUrl };
            } else {
              const expectedFilename = `${item.word_id.toLowerCase().replace(/\s+/g, '_')}.png`;
              imageSource = getLocalImage(expectedFilename, (childProfile?.gender?.toLowerCase() ?? null) as 'boy' | 'girl' | null) || { uri: item.imageUrl };
            }
            
            return (
              <TouchableOpacity 
                key={`${item.id}-${index}`} 
                style={styles.chip}
                onPress={() => speakWord(wordText)}
                onLongPress={() => handleRemove(index)}
              >
                <Image source={imageSource} style={styles.chipImage} resizeMode="contain" />
                <Text style={styles.chipText}>{wordText}</Text>
                <TouchableOpacity style={styles.removeButton} onPress={() => handleRemove(index)}>
                  <Text style={styles.removeText}>✕</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 100,
    backgroundColor: '#F8FAFC',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    justifyContent: 'center',
    paddingVertical: 10,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    zIndex: 10,
  },
  placeholderText: {
    textAlign: 'center',
    color: '#94A3B8',
    fontStyle: 'italic',
    fontSize: 16,
  },
  scrollContent: {
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 12,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#00B5B8',
    shadowColor: '#00B5B8',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 2,
    marginRight: 10,
  },
  chipImage: {
    width: 24,
    height: 24,
    marginRight: 8,
  },
  chipText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#11427B',
    marginRight: 8,
  },
  removeButton: {
    backgroundColor: '#FF6B6B',
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeText: {
    color: '#FFF',
    fontSize: 12,
    fontWeight: 'bold',
  }
});
