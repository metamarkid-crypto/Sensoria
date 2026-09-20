import * as SQLite from 'expo-sqlite';
import { AACWord } from '../../store/useAACStore';

let db: SQLite.SQLiteDatabase | null = null;

export const initDB = async () => {
  try {
    // Open lazily but NEVER re-open (re-opening causes NPE in React Native).
    // The migrations below are all idempotent, so they safely run on EVERY
    // call — including Fast-Refresh re-mounts where `db` already survives and
    // a naive early-return would silently skip the dictionary sync.
    if (!db) {
      db = await SQLite.openDatabaseAsync('aac_sensoria.db');

      // Create words table
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
      `);
    }
    
    // Migration: NON-DESTRUCTIVE favorites. `is_favorite` is a pure boolean
    // overlay — favoriting NEVER touches categoryId, so a card always stays
    // visible in its original tab (spatial motor memory is sacred).
    // ALTER TABLE throws when the column already exists — expected on every
    // launch after the first.
    try {
      await db.execAsync('ALTER TABLE aac_words ADD COLUMN is_favorite INTEGER DEFAULT 0;');
    } catch (e) {
      if (!String(e).includes('duplicate column name')) {
        console.warn('is_favorite migration skipped:', e);
      }
    }
    // Trilingual: English label column (optional — legacy rows stay valid).
    try {
      await db.execAsync('ALTER TABLE aac_words ADD COLUMN word_en TEXT;');
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
      const missingEn = await db.getAllAsync<{ count: number }>(
        "SELECT COUNT(*) as count FROM aac_words WHERE isCustom = 0 AND (word_en IS NULL OR word_en = '')"
      );
      if (missingEn && missingEn[0].count > 0) {
        const seedData: AACWord[] = require('../../../assets/data/arasaac.json');
        for (const word of seedData) {
          if (!word.word_en) continue;
          await db.runAsync(
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
    const defaultWordsCount = await db.getAllAsync<{ count: number }>("SELECT COUNT(*) as count FROM aac_words WHERE isCustom = 0");
    const lastSeedCheck = lastSeedId
      ? await db.getAllAsync<{ id: string }>("SELECT id FROM aac_words WHERE id = ? AND isCustom = 0 LIMIT 1", [lastSeedId])
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
