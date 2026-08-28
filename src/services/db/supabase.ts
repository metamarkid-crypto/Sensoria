import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/**
 * Mengirim pesan AAC ke Supabase (Sekaligus Insert ke tabel messages dan Broadcast Realtime)
 */
export const sendAACMessage = async (channelId: string, payload: any) => {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Supabase not configured. Message sending skipped.');
    return;
  }
  
  // Eksekusi Insert ke tabel messages agar tersimpan permanen
  const { error } = await supabase.from('messages').insert({
    channel_id: channelId,
    sender_role: payload.sender,
    sender_name: payload.senderName || payload.sender,
    text_content: payload.text,
    timestamp: payload.timestamp,
    location_lat: payload.location?.latitude || null,
    location_lng: payload.location?.longitude || null,
  });

  if (error) {
    console.error('Gagal menyimpan pesan ke database:', error);
  }
};

/**
 * Menarik 50 pesan terakhir dari tabel (Optimasi Cerdas untuk Load Awal)
 */
export const getAACMessagesHistory = async (channelId: string) => {
  if (!supabaseUrl || !supabaseAnonKey) return [];
  
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('channel_id', channelId)
    .order('timestamp', { ascending: false })
    .limit(50);
    
  if (error) {
    console.error('Gagal memuat history pesan:', error);
    return [];
  }
  return data;
};

/**
 * Mendengarkan pesan baru secara realtime menggunakan Realtime Postgres Changes
 */
export const subscribeToAACMessages = (channelId: string, onMessageReceived: (payload: any) => void) => {
  if (!supabaseUrl || !supabaseAnonKey) {
    return { unsubscribe: () => {} };
  }

  const channel = supabase.channel(`public:messages:channel_id=eq.${channelId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
      (payload) => {
        // Konversi bentuk tabel kembali ke struktur payload frontend
        const newMsg = payload.new;
        onMessageReceived({
          sender: newMsg.sender_role,
          senderName: newMsg.sender_name,
          text: newMsg.text_content,
          timestamp: newMsg.timestamp,
          location: newMsg.location_lat ? { latitude: newMsg.location_lat, longitude: newMsg.location_lng } : null
        });
      }
    )
    .subscribe();

  return channel;
};
