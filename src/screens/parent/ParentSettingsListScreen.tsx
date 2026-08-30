import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

export default function ParentSettingsListScreen() {
  const navigation = useNavigation<any>();

  const settingsItems = [
    { id: '1', title: 'Profil Pengguna', icon: 'user' },
    { id: '2', title: 'Suara & Bicara', icon: 'volume-up' },
    { id: '3', title: 'Tampilan', icon: 'palette' },
    { id: '4', title: 'Koneksi & Perangkat', icon: 'link' },
  ];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        {settingsItems.map((item, index) => (
          <TouchableOpacity 
            key={item.id} 
            style={[styles.itemRow, index !== settingsItems.length - 1 && styles.borderBottom]}
          >
            <View style={styles.itemLeft}>
              <View style={styles.iconBox}>
                <FontAwesome5 name={item.icon} size={16} color="#11427B" />
              </View>
              <Text style={styles.itemTitle}>{item.title}</Text>
            </View>
            <FontAwesome5 name="chevron-right" size={14} color="#CBD5E1" />
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  content: {
    padding: 20,
    paddingBottom: 100,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    paddingHorizontal: 16,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
  },
  borderBottom: {
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  itemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: '#F0F9FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  itemTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#0F172A',
  }
});
