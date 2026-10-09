import React from 'react';
import { View, Text, StyleSheet, FlatList } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AACWord, useAACStore } from '../../store/useAACStore';
import AACCard from './AACCard';

interface AACGridProps {
  words: AACWord[];
  onWordPress: (word: AACWord) => void;
  onWordLongPress?: (word: AACWord) => void;
  /** When set, shown centered with an icon if the grid has no words. */
  emptyState?: { icon: keyof typeof Ionicons.glyphMap; message: string };
}

export default function AACGrid({ words, onWordPress, onWordLongPress, emptyState }: AACGridProps) {
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
        ListEmptyComponent={
          emptyState ? (
            <View style={styles.emptyWrap}>
              <Ionicons name={emptyState.icon} size={64} color="#FFD700" />
              <Text style={styles.emptyText}>{emptyState.message}</Text>
            </View>
          ) : null
        }
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
    flexGrow: 1,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  emptyText: {
    marginTop: 12,
    fontSize: 16,
    fontWeight: '700',
    color: '#64748B',
    textAlign: 'center',
  },
});
