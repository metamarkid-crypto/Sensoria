import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function ParentLocationScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Pelacakan Lokasi</Text>
      <Text style={styles.subText}>Fitur pelacakan lokasi waktu-nyata sedang dalam tahap pengembangan.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#11427B',
    marginBottom: 8,
  },
  subText: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
  }
});
