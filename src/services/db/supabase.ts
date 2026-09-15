import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { AACWord } from '../../store/useAACStore';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';

/** True when BOTH public env vars actually made it into this build. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

/**
 * OFFLINE-FIRST GUARD — the "cannot open at all" crash fix.
 *
 * supabase-js v2 (≥2.11x) throws SYNCHRONOUSLY inside createClient when the
 * URL/key is empty ("supabaseUrl is required."). This module sits in the app's
 * import graph, so an unconfigured build used to crash BEFORE the first
 * paint: white screen / force-close with nothing in the UI explaining why
 * (Sentry's ErrorBoundary only covers RENDER errors — module imports run
 * before React ever mounts).
 *
 * The app is explicitly offline-first ("Compassionate Child" mandate): every
 * cloud consumer here degrades gracefully (`if (!supabaseUrl || !supabaseAnonKey)
 * return …`), so an unconfigured build constructs the client against a
 * placeholder URL instead of throwing. Queries then simply fail (handled by
 * the callers) and realtime channels never connect — SQLite stays the source
 * of truth and the app OPENS, offline, exactly like any other
 * unconfigured-but-functional state.
 */
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : createClient('https://offline.supabase.invalid', 'public-anon-key-placeholder');

if (!isSupabaseConfigured) {
  // LOUD diagnostic (same doctrine as paywall.ts): an unconfigured build must
  // be visible in logs (adb logcat / Metro console), never silent.
  console.warn(
    '[Supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY kosong di build ini.\n' +
      'Aplikasi berjalan MODO OFFLINE PENUH (SQLite): pairing, entitlement, dan realtime cloud dinonaktifkan.\n' +
      'Perbaiki dengan men-set kedua env di GitHub Secrets (build CI) atau .env (build lokal), lalu build ulang APK.',
  );
}

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
 * Cloud backup for a custom card (fire-and-forget — the UI never awaits this).
 * Writes into `custom_words` keyed on the device; a tampered client can only
 * ever touch its own rows.
 */
export const syncCustomWordToCloud = async (
  word: AACWord,
  deviceId: string | null
): Promise<void> => {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Supabase not configured. Custom card cloud sync skipped.');
    return;
  }
  if (!deviceId) return; // unlinked device — SQLite alone is the source of truth

  const { error } = await supabase.from('custom_words').upsert(
    {
      id: word.id,
      child_device_id: deviceId,
      word_id: word.word_id,
      word_en: word.word_en ?? null,
      word_zh: word.word_zh,
      image_url: word.imageUrl ?? null,
      category_id: word.categoryId,
      is_favorite: word.isFavorite ? 1 : 0,
    },
    { onConflict: 'id' }
  );

  if (error) {
    console.error('[CustomWords] cloud sync failed (offline-safe):', error);
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
  const channel = supabase.channel(`public:messages:channel_id=eq.${channelId}`);

  if (!supabaseUrl || !supabaseAnonKey) {
    // Dev/unconfigured: hand back the detached (never-subscribed) channel so
    // every caller holds a real RealtimeChannel; removeChannel is a no-op.
    return channel;
  }

  return channel
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
};
