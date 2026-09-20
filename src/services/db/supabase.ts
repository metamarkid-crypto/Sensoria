import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import { AACWord } from '../../store/useAACStore';
// Static import is Metro-safe (dynamic import() can break in RN bundles).
// No circularity: sqlite.ts never imports this module.
import {
  getPendingMessages,
  deletePendingMessage,
  getCloudOps,
  deleteCloudOp,
  bumpCloudOpAttempts,
  MAX_OUTBOX_ATTEMPTS,
  queueCloudOp,
} from './sqlite';

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
 * Mengirim pesan AAC ke Supabase (Sekaligus Insert ke tabel messages dan Broadcast Realtime).
 * Returns true when the row is stored (callers may queue it locally otherwise).
 */
export const sendAACMessage = async (channelId: string, payload: any): Promise<boolean> => {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn('Supabase not configured. Message sending skipped.');
    return false;
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
    return false;
  }
  return true;
};

// ── OUTBOX FLUSHER (offline-first messaging) ────────────────────────────────
// Messages whose cloud insert failed (airplane mode, dead socket) live in the
// SQLite outbox; this routine drains it FIFO. Every attempt is idempotent on
// the transport level: `timestamp` mirrors PostgREST's unique constraint, so
// a 409 (row already there — insert landed but the response was lost) counts
// as SUCCESS, never as a permanent failure that would duplicate or wedge.
let isFlushingOutbox = false;

export const flushPendingMessages = async (): Promise<number> => {
  if (!supabaseUrl || !supabaseAnonKey || isFlushingOutbox) return 0;
  isFlushingOutbox = true;
  let sent = 0;
  try {
    const pending = await getPendingMessages();
    for (const row of pending) {
      const { error } = await supabase.from('messages').insert({
        channel_id: row.channel_id,
        sender_role: row.sender_role,
        sender_name: row.sender_name ?? row.sender_role,
        text_content: row.text_content,
        timestamp: row.timestamp,
        location_lat: row.location_lat,
        location_lng: row.location_lng,
      });
      if (error) {
        if (error.code === '23505') {
          // Already stored (insert reached the DB earlier, ack lost) — done.
          await deletePendingMessage(row.id);
          sent++;
          continue;
        }
        console.warn('[Outbox] flush stopped (still offline?):', error.message);
        break; // FIFO — stop at the first failure, retry later
      }
      await deletePendingMessage(row.id);
      sent++;
    }
  } catch (e) {
    console.warn('[Outbox] flush error:', e);
  } finally {
    isFlushingOutbox = false;
  }
  return sent;
};

// ── GENERIC CLOUD OUTBOX FLUSHER (all non-message write-paths) ──────────────
// Replay strategies per op key:
//   plain   → re-run the identical insert/upsert (idempotent by PK)
//   merge   → re-fetch remote settings and merge the queued PARTIAL over it,
//             so a replayed offline edit can never clobber newer cloud fields
//   drop    → never replayed (stale-by-nature data, e.g. presence last_seen)
const replayCloudOp = async (op: string, payload: any): Promise<'done' | 'retry' | 'drop'> => {
  switch (op) {
    case 'locations.insert': {
      const { error } = await supabase.from('locations').insert(payload);
      return error ? 'retry' : 'done';
    }
    case 'custom_words.upsert': {
      const { error } = await supabase.from('custom_words').upsert(payload, { onConflict: 'id' });
      return error ? 'retry' : 'done';
    }
    case 'devices.upsert': {
      const { error } = await supabase.from('devices').upsert(payload);
      return error ? 'retry' : 'done';
    }
    case 'child_profiles.upsert': {
      const { error } = await supabase.from('child_profiles').upsert(payload);
      return error ? 'retry' : 'done';
    }
    case 'child_profiles.settings': {
      // Remote-merge: the queued payload holds ONLY the fields this device
      // edited. Re-fetching first means a settings change made from another
      // device while we were offline survives the replay.
      const { data: current, error: fetchErr } = await supabase
        .from('child_profiles')
        .select('settings')
        .eq('device_id', payload.device_id)
        .maybeSingle();
      if (fetchErr) return 'retry';
      if (!current) return 'retry'; // profile row not created yet — wait for the self-healing profile upsert
      const merged = { ...((current.settings as any) ?? {}), ...(payload.settings ?? {}) };
      const { error } = await supabase
        .from('child_profiles')
        .update({ settings: merged })
        .eq('device_id', payload.device_id);
      return error ? 'retry' : 'done';
    }
    case 'devices.presence':
      // last_seen/coords are stale the moment they were queued — replaying
      // would LIE about the child's presence. Presence self-corrects on the
      // next tracker write instead.
      return 'drop';
    default:
      // Unknown op (older build's queue) — poison guard.
      return 'drop';
  }
};

let isFlushingCloudOps = false;

export const flushCloudOps = async (): Promise<number> => {
  if (!supabaseUrl || !supabaseAnonKey || isFlushingCloudOps) return 0;
  isFlushingCloudOps = true;
  let done = 0;
  try {
    const ops = await getCloudOps();
    for (const row of ops) {
      let payload: any;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        await deleteCloudOp(row.id); // unparseable — poison guard
        continue;
      }
      const verdict = await replayCloudOp(row.op, payload);
      if (verdict === 'done' || verdict === 'drop') {
        await deleteCloudOp(row.id);
        if (verdict === 'done') done++;
      } else {
        const attempts = await bumpCloudOpAttempts(row.id);
        if (attempts >= MAX_OUTBOX_ATTEMPTS) {
          // Poison pill: a persistent failure (RLS misconfig, schema drift) is
          // dropped so it can never wedge the FIFO and starve the ops behind it.
          console.warn(`[CloudOutbox] op '${row.op}' dropped after ${attempts} attempts`);
          await deleteCloudOp(row.id);
        } else {
          break; // FIFO: stop at the first still-offline op, resume next trigger
        }
      }
    }
  } catch (e) {
    console.warn('[CloudOutbox] flush error:', e);
  } finally {
    isFlushingCloudOps = false;
  }
  return done;
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

  const payload = {
    id: word.id,
    child_device_id: deviceId,
    word_id: word.word_id,
    word_en: word.word_en ?? null,
    word_zh: word.word_zh,
    image_url: word.imageUrl ?? null,
    category_id: word.categoryId,
    is_favorite: word.isFavorite ? 1 : 0,
  };
  const { error } = await supabase.from('custom_words').upsert(
    payload,
    { onConflict: 'id' }
  );

  if (error) {
    console.error('[CustomWords] cloud sync failed (queued for replay):', error);
    // Custom cards + their favorite flag are REAL user data — same offline
    // queue treatment as messages/location history.
    await queueCloudOp('custom_words.upsert', payload);
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
