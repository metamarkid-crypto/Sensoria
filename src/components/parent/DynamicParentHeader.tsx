import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { supabase } from '../../services/db/supabase';
import { useAACStore } from '../../store/useAACStore';

export default function DynamicParentHeader() {
  const { deviceId, childProfile } = useAACStore();
  const [isOnline, setIsOnline] = useState(false);
  const [lastSeen, setLastSeen] = useState<string | null>(null);

  useEffect(() => {
    let subscription: any = null;

    const checkStatus = async () => {
      if (!deviceId) return;
      
      const { data: link } = await supabase
        .from('family_links')
        .select('child_device_id')
        .eq('parent_device_id', deviceId)
        .single();
        
      if (!link) return;

      const fetchPresence = async () => {
        const { data } = await supabase
          .from('devices')
          .select('last_seen')
          .eq('id', link.child_device_id)
          .single();
          
        if (data?.last_seen) {
          updateOnlineStatus(data.last_seen);
        }
      };
      
      await fetchPresence();

      subscription = supabase.channel('public:devices')
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'devices',
          filter: `id=eq.${link.child_device_id}`
        }, (payload) => {
          if (payload.new.last_seen) {
            updateOnlineStatus(payload.new.last_seen);
          }
        })
        .subscribe();
    };

    const updateOnlineStatus = (lastSeenTimestamp: string) => {
      const lastActive = new Date(lastSeenTimestamp);
      const diffMins = Math.floor((new Date().getTime() - lastActive.getTime()) / 60000);
      if (diffMins < 5) {
        setIsOnline(true);
      } else {
        setIsOnline(false);
        setLastSeen(`${diffMins} menit lalu`);
      }
    };

    checkStatus();

    return () => {
      if (subscription) {
        supabase.removeChannel(subscription);
      }
    };
  }, [deviceId]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sensoria</Text>
      {childProfile?.fullName ? (
        <View style={styles.statusContainer}>
          <Text style={styles.childName}>{childProfile.nickname || childProfile.fullName}</Text>
          <View style={styles.badgeWrapper}>
            <View style={[styles.dot, { backgroundColor: isOnline ? '#4CAF50' : '#94A3B8' }]} />
            <Text style={styles.statusText}>
              {isOnline ? 'Terhubung sekarang' : `Terakhir aktif ${lastSeen || 'baru saja'}`}
            </Text>
          </View>
        </View>
      ) : (
        <Text style={styles.noChild}>Belum menautkan anak</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#11427B',
    padding: 16,
    paddingBottom: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  title: {
    fontSize: 24,
    fontWeight: '900',
    color: '#FFF',
    letterSpacing: 1,
  },
  statusContainer: {
    alignItems: 'flex-end',
  },
  childName: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  badgeWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  statusText: {
    color: '#E2E8F0',
    fontSize: 12,
  },
  noChild: {
    color: '#E2E8F0',
    fontStyle: 'italic',
    fontSize: 12,
  }
});
