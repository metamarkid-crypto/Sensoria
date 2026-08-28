import React from 'react';
import { View, StyleSheet, FlatList } from 'react-native';
import { AACWord, useAACStore } from '../../store/useAACStore';
import AACCard from './AACCard';

interface AACGridProps {
  words: AACWord[];
  onWordPress: (word: AACWord) => void;
  onWordLongPress?: (word: AACWord) => void;
}

export default function AACGrid({ words, onWordPress, onWordLongPress }: AACGridProps) {
  const { cardSize, cardSpacing } = useAACStore();

  const getNumColumns = () => {
    switch (cardSize) {
      case 'S': return 5;
      case 'M': return 4;
      case 'XL': return 2;
      case 'L':
      default: return 3;
    }
  };
  
  const columns = getNumColumns();

  return (
    <View style={styles.container}>
      <FlatList
        key={`grid-${columns}`}
        data={words}
        keyExtractor={(item) => item.id}
        numColumns={columns}
        contentContainerStyle={[styles.listContainer, { padding: cardSpacing / 2 }]}
        renderItem={({ item }) => (
          <View style={{ flex: 1, margin: cardSpacing / 2, maxWidth: `${100 / columns}%` }}>
            <AACCard item={item} onPress={onWordPress} onLongPress={onWordLongPress} />
          </View>
        )}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  listContainer: {
    padding: 10,
  },
});
