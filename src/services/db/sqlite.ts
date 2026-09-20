import * as SQLite from 'expo-sqlite';
import { AACWord } from '../../store/useAACStore';

let db: SQLite.SQLiteDatabase | null = null;

// Single-flight opener shared by initDB (child side) and ensureDB (any side).
// ALL table DDL lives here so whichever path opens the database first
// guarantees a complete schema — a parent-only install used to leave `db`
// null forever (initDB only ever ran inside ChildAACScreen), silently
// disabling every cache helper on that device.
let ensurePromise: Promise<void> | null = null;

const openAndMigrate = async (): Promise<void> => {
  const opened = await SQLite.openDatabaseAsync('aac_sensoria.db');
  db = opened;
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS aac_words (
      id TEXT PRIMARY KEY,
      word_id TEXT NOT NULL,
      word_zh TEXT NOT NULL,
      imageUrl TEXT NOT NULL,
      categoryId TEXT NOT NULL,
      isCustom INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audio_cache_metadata (
      file_uri TEXT PRIMARY KEY,
      file_size INTEGER NOT NULL,
      last_accessed INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages_cache (
      id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      sender_name TEXT,
      text_content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      location_lat REAL,
      location_lng REAL,
      pending INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_cache_channel
      ON messages_cache (channel_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS cloud_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
};

/**
 * Ensure the SQLite handle exists WITHOUT the dictionary sync — cheap and
 * safe to call from any screen or service before touching cache helpers.
 * Idempotent, co-routine safe, and failure-tolerant: on error the handle
 * stays null and every helper degrades to a graceful no-op (online paths
 * keep working).
 */
export const ensureDB = async (): Promise<void> => {
  if (db) return;
  if (!ensurePromise) {
    ensurePromise = openAndMigrate().catch((e) => {
      console.warn('SQLite open failed (cache helpers will no-op):', e);
      ensurePromise = null;
    });
  }
  await ensurePromise;
};

export const initDB = async () => {
  try {
    // Open lazily but NEVER re-open (re-opening causes NPE in React Native).
    // The migrations below are all idempotent, so they safely run on EVERY
    // call — including Fast-Refresh re-mounts where `db` already survives and
    // a naive early-return would silently skip the dictionary sync.
    await ensureDB();
    if (!db) throw new Error('SQLite unavailable — dictionary sync skipped');
    const dbo = db; // narrowed local for TS (module vars lose narrowing)

    // Migration: NON-DESTRUCTIVE favorites. `is_favorite` is a pure boolean
    // overlay — favoriting NEVER touches categoryId, so a card always stays
    // visible in its original tab (spatial motor memory is sacred).
    // ALTER TABLE throws when the column already exists — expected on every
    // launch after the first.
    try {
      await dbo.execAsync('ALTER TABLE aac_words ADD COLUMN is_favorite INTEGER DEFAULT 0;');
    } catch (e) {
      if (!String(e).includes('duplicate column name')) {
        console.warn('is_favorite migration skipped:', e);
      }
    }
    // Trilingual: English label column (optional — legacy rows stay valid).
    try {
      await dbo.execAsync('ALTER TABLE aac_words ADD COLUMN word_en TEXT;');
    } catch (e) {
      if (!String(e).includes('duplicate column name')) {
        console.warn('word_en migration skipped:', e);
      }
    }
    await migrateLegacyFavorites();

    // Migration: BACKFILL word_en for seeded rows (installs created before
    // the dataset became trilingual — the seed re-run above only fires when
    // the dictionary is missing/malformed). Non-destructive by construction:
    // matches the canonical seed id, never touches custom cards, and never
    // overwrites a value that already exists (a parent's AI-filled English
    // label is sacred).
    try {
      const missingEn = await dbo.getAllAsync<{ count: number }>(
        "SELECT COUNT(*) as count FROM aac_words WHERE isCustom = 0 AND (word_en IS NULL OR word_en = '')"
      );
      if (missingEn && missingEn[0].count > 0) {
        const seedData: AACWord[] = require('../../../assets/data/arasaac.json');
        for (const word of seedData) {
          if (!word.word_en) continue;
          await dbo.runAsync(
            "UPDATE aac_words SET word_en = ? WHERE id = ? AND isCustom = 0 AND (word_en IS NULL OR word_en = '')",
            [word.word_en, word.id]
          );
        }
      }
    } catch (e) {
      console.warn('word_en backfill skipped:', e);
    }

    // Migration: sync the FULL dictionary (all categories). NON-DESTRUCTIVE:
    //   • custom cards are never touched,
    //   • favorites are preserved (is_favorite is never overwritten),
    //   • existing seeded rows only get their labels/category refreshed.
    // Sentinels: re-sync when the seeded row count is below the seed total OR
    // the last seed word (highest id) is missing — this pushes newly-added
    // words to EXISTING installs without wiping favorites, unlike the old
    // DELETE-then-INSERT re-seed.
    const seedData: AACWord[] = require('../../../assets/data/arasaac.json');
    const lastSeedId = seedData[seedData.length - 1]?.id;
    const defaultWordsCount = await dbo.getAllAsync<{ count: number }>("SELECT COUNT(*) as count FROM aac_words WHERE isCustom = 0");
    const lastSeedCheck = lastSeedId
      ? await dbo.getAllAsync<{ id: string }>("SELECT id FROM aac_words WHERE id = ? AND isCustom = 0 LIMIT 1", [lastSeedId])
      : [];

    if (
      (defaultWordsCount && defaultWordsCount[0].count < seedData.length) ||
      (lastSeedId && lastSeedCheck.length === 0)
    ) {
      await syncDefaultWords(seedData);
    }
  } catch (error) {
    console.error('Error initializing SQLite:', error);
  }
};

const findSeedCategory = (id: string): string | null => {
  try {
    const seedData: AACWord[] = require('../../../assets/data/arasaac.json');
    return seedData.find((w) => w.id === id)?.categoryId ?? null;
  } catch {
    return null;
  }
};

/**
 * Upsert the full seed dictionary. NON-DESTRUCTIVE:
 *   • INSERT for new words,
 *   • UPDATE labels/image/category for existing seeded rows,
 *   • never touches is_favorite or isCustom (favorites + custom cards survive).
 */
const syncDefaultWords = async (seedData: AACWord[]) => {
  if (!db) return;

  try {
    const statement = await db.prepareAsync(
      `INSERT INTO aac_words (id, word_id, word_en, word_zh, imageUrl, categoryId, isCustom)
       VALUES ($id, $word_id, $word_en, $word_zh, $img, $cat, 0)
       ON CONFLICT(id) DO UPDATE SET
         word_id = excluded.word_id,
         word_en = excluded.word_en,
         word_zh = excluded.word_zh,
         imageUrl = excluded.imageUrl,
         categoryId = excluded.categoryId`
    );
    for (const word of seedData) {
      await statement.executeAsync({
        $id: word.id,
        $word_id: word.word_id,
        $word_en: word.word_en || null,
        $word_zh: word.word_zh,
        $img: word.imageUrl || null,
        $cat: word.categoryId,
      });
    }
    await statement.finalizeAsync();
  } catch (error) {
    console.error('Error syncing seed data:', error);
  }
};

/**
 * One-time conversion of the previous band-aid favorites (categoryId was
 * MOVED to 'favorit' with the real category parked in previous_category_id).
 * Restores every affected row's true category and flips is_favorite on.
 */
const migrateLegacyFavorites = async () => {
  if (!db) return;
  try {
    const legacy = await db.getAllAsync<any>(
      "SELECT id, isCustom, previous_category_id FROM aac_words WHERE categoryId = 'favorit'"
    );
    for (const row of legacy) {
      const restore =
        row.previous_category_id ||
        (row.isCustom === 1 ? 'custom' : findSeedCategory(row.id) || 'noun');
      await db.runAsync(
        "UPDATE aac_words SET categoryId = ?, previous_category_id = NULL, is_favorite = 1 WHERE id = ?",
        [restore, row.id]
      );
    }
  } catch (e) {
    // First launch ever: previous_category_id doesn't exist yet — nothing to convert.
    if (!String(e).includes('no such column')) {
      console.warn('Legacy favorite migration skipped:', e);
    }
  }
};

export const getAllWords = async (): Promise<AACWord[]> => {
  if (!db) return [];
  const rows = await db.getAllAsync<any>('SELECT * FROM aac_words');
  return rows.map(r => ({
    id: r.id,
    word_id: r.word_id,
    word_en: r.word_en ?? undefined,
    word_zh: r.word_zh,
    imageUrl: r.imageUrl,
    categoryId: r.categoryId,
    isFavorite: r.is_favorite === 1,
    isCustom: r.isCustom === 1
  }));
};

export const addCustomWord = async (word: AACWord) => {
  if (!db) return;
  await db.runAsync(
    'INSERT INTO aac_words (id, word_id, word_en, word_zh, imageUrl, categoryId, isCustom) VALUES (?, ?, ?, ?, ?, ?, 1)',
    [word.id, word.word_id, word.word_en ?? null, word.word_zh, word.imageUrl || null, word.categoryId]
  );
};

export const updateWord = async (id: string, updates: Partial<AACWord>) => {
  if (!db) return;
  const setClauses: string[] = [];
  const values: any[] = [];
  
  if (updates.word_id !== undefined) {
    setClauses.push('word_id = ?');
    values.push(updates.word_id);
  }
  if (updates.word_en !== undefined) {
    setClauses.push('word_en = ?');
    values.push(updates.word_en);
  }
  if (updates.word_zh !== undefined) {
    setClauses.push('word_zh = ?');
    values.push(updates.word_zh);
  }
  if (updates.imageUrl !== undefined) {
    setClauses.push('imageUrl = ?');
    values.push(updates.imageUrl);
  }
  if (updates.categoryId !== undefined) {
    setClauses.push('categoryId = ?');
    values.push(updates.categoryId);
  }
  
  if (setClauses.length === 0) return;
  
  const query = `UPDATE aac_words SET ${setClauses.join(', ')} WHERE id = ?`;
  values.push(id);
  
  await db.runAsync(query, values);
};

// --- FAVORITES LIFECYCLE (non-destructive) ---
// `is_favorite` is a pure overlay: toggling it NEVER touches categoryId.
// "Apel" stays in Benda whether it is favorited or not — the Favorit tab is
// just a filter (WHERE is_favorite = 1), not a physical location.

export const setWordFavorite = async (id: string, favorite: boolean): Promise<void> => {
  if (!db) return;
  await db.runAsync('UPDATE aac_words SET is_favorite = ? WHERE id = ?', [
    favorite ? 1 : 0,
    id,
  ]);
};

// --- AUDIO CACHE METADATA (LRU) ---

export const recordAudioAccess = async (fileUri: string, fileSize: number) => {
  if (!db) return;
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO audio_cache_metadata (file_uri, file_size, last_accessed) 
     VALUES (?, ?, ?) 
     ON CONFLICT(file_uri) DO UPDATE SET last_accessed = excluded.last_accessed`,
    [fileUri, fileSize, now]
  );
};

export const getLRUAudioFiles = async (limit: number): Promise<{ file_uri: string, file_size: number }[]> => {
  if (!db) return [];
  const rows = await db.getAllAsync<any>(
    'SELECT file_uri, file_size FROM audio_cache_metadata ORDER BY last_accessed ASC LIMIT ?',
    [limit]
  );
  return rows.map(r => ({ file_uri: r.file_uri, file_size: r.file_size }));
};

export const removeAudioMetadata = async (fileUri: string) => {
  if (!db) return;
  await db.runAsync('DELETE FROM audio_cache_metadata WHERE file_uri = ?', [fileUri]);
};

// --- MESSAGE CACHE + OUTBOX (offline-first parent messaging) ---

/**
 * Reseed the cache for one channel from an authoritative network fetch.
 * Pending (not-yet-acked) rows are PRESERVED — they live in the outbox and
 * must survive until their cloud insert is confirmed.
 */
export const saveMessagesCache = async (channelId: string, rows: any[]): Promise<void> => {
  await ensureDB();
  if (!db) return;
  try {
    await db.withTransactionAsync(async () => {
      // When the reseed is EMPTY we cannot distinguish "empty channel" from
      // "this fetch failed" — so keep every existing row (pending included)
      // and defer to a later successful fetch. Only a NON-empty reseed may
      // clear, and even then pending rows survive: they live in the outbox.
      if (rows.length === 0) return;
      await db!.runAsync('DELETE FROM messages_cache WHERE channel_id = ? AND pending = 0', [channelId]);
      for (const r of rows) {
        await db!.runAsync(
          `INSERT OR REPLACE INTO messages_cache
             (id, channel_id, sender_role, sender_name, text_content, timestamp, location_lat, location_lng, pending)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [r.id, channelId, r.sender_role, r.sender_name ?? null, r.text_content, r.timestamp ?? 0, r.location_lat ?? null, r.location_lng ?? null]
        );
      }
    });
  } catch (e) {
    console.warn('[MessageCache] reseed failed (non-fatal):', e);
  }
};

/** Append a single row (realtime INSERT or optimistic pending echo). */
export const appendMessageToCache = async (row: any): Promise<void> => {
  await ensureDB();
  if (!db || !row?.channel_id) return;
  try {
    await db.runAsync(
      `INSERT OR REPLACE INTO messages_cache
         (id, channel_id, sender_role, sender_name, text_content, timestamp, location_lat, location_lng, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.channel_id, row.sender_role, row.sender_name ?? null, row.text_content, row.timestamp ?? 0, row.location_lat ?? null, row.location_lng ?? null, row.pending ? 1 : 0]
    );
  } catch (e) {
    console.warn('[MessageCache] append failed (non-fatal):', e);
  }
};

/** Newest-first read for the inbox render (pending rows included). */
export const getMessagesCache = async (channelId: string, limit = 200): Promise<any[]> => {
  await ensureDB();
  if (!db) return [];
  return db.getAllAsync<any>(
    'SELECT * FROM messages_cache WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?',
    [channelId, limit]
  );
};

/** Queue a message whose cloud insert failed (offline / transport error). */
export const queuePendingMessage = async (row: {
  channel_id: string; sender_role: string; sender_name: string | null;
  text_content: string; timestamp: number; location_lat: number | null; location_lng: number | null;
}): Promise<void> => {
  await ensureDB();
  if (!db) return;
  // Negative id keeps the FlatList key unique and marks the row as local-only.
  const localId = -Math.floor(Math.min(row.timestamp, Date.now())) || -Date.now();
  try {
    await db.runAsync(
      `INSERT INTO messages_cache
         (id, channel_id, sender_role, sender_name, text_content, timestamp, location_lat, location_lng, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [localId, row.channel_id, row.sender_role, row.sender_name, row.text_content, row.timestamp, row.location_lat, row.location_lng]
    );
  } catch (e) {
    console.warn('[Outbox] queue failed:', e);
  }
};

/** FIFO for the flusher. */
export const getPendingMessages = async (): Promise<any[]> => {
  await ensureDB();
  if (!db) return [];
  return db.getAllAsync<any>('SELECT * FROM messages_cache WHERE pending = 1 ORDER BY timestamp ASC');
};

export const deletePendingMessage = async (id: number): Promise<void> => {
  await ensureDB();
  if (!db) return;
  await db.runAsync('DELETE FROM messages_cache WHERE id = ?', [id]);
};

// --- GENERIC CLOUD OUTBOX (every non-message cloud write-path) ---
// One FIFO queue for location history, custom words, device registration and
// profile/settings writes that failed while offline. Each row carries an op
// key the flusher maps to a replay strategy (plain upsert vs remote-merge).
// `attempts` is the poison-pill guard: an op that keeps failing (e.g. an RLS
// misconfiguration, not just offline) is dropped after MAX so it can never
// wedge the FIFO and starve every op behind it.
export const MAX_OUTBOX_ATTEMPTS = 5;

export const queueCloudOp = async (op: string, payload: any): Promise<void> => {
  await ensureDB();
  if (!db) return;
  try {
    await db.runAsync(
      'INSERT INTO cloud_outbox (op, payload, attempts, created_at) VALUES (?, ?, 0, ?)',
      [op, JSON.stringify(payload), Date.now()]
    );
  } catch (e) {
    console.warn('[CloudOutbox] enqueue failed:', e);
  }
};

export const getCloudOps = async (): Promise<any[]> => {
  await ensureDB();
  if (!db) return [];
  return db.getAllAsync<any>('SELECT * FROM cloud_outbox ORDER BY id ASC');
};

export const deleteCloudOp = async (id: number): Promise<void> => {
  await ensureDB();
  if (!db) return;
  await db.runAsync('DELETE FROM cloud_outbox WHERE id = ?', [id]);
};

export const bumpCloudOpAttempts = async (id: number): Promise<number> => {
  await ensureDB();
  if (!db) return 0;
  await db.runAsync('UPDATE cloud_outbox SET attempts = attempts + 1 WHERE id = ?', [id]);
  const row = await db.getAllAsync<{ attempts: number }>('SELECT attempts FROM cloud_outbox WHERE id = ?', [id]);
  return row[0]?.attempts ?? 0;
};
