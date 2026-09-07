import * as SQLite from 'expo-sqlite';
import { AACWord } from '../../store/useAACStore';

let db: SQLite.SQLiteDatabase | null = null;

export const initDB = async () => {
  try {
    if (db) return; // Prevent re-opening connection which causes NPE in React Native
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
    
    // Migration: preserve a word's real category while it sits in Favorites
    // (unfavorite restores it exactly). ALTER TABLE throws when the column
    // already exists — expected on every launch after the first.
    try {
      await db.execAsync('ALTER TABLE aac_words ADD COLUMN previous_category_id TEXT;');
    } catch (e) {
      if (!String(e).includes('duplicate column name')) {
        console.warn('previous_category_id migration skipped:', e);
      }
    }

    // Migration: Update dictionary to full 57 core words and ENFORCE SORTING (keep custom words safe)
    const defaultWordsCount = await db.getAllAsync<{ count: number }>("SELECT COUNT(*) as count FROM aac_words WHERE isCustom = 0");
    const mauCheck = await db.getAllAsync<{ id: string }>("SELECT id FROM aac_words WHERE word_id = 'Mau' AND isCustom = 0 LIMIT 1");
    
    // If we have fewer than 50 words OR 'Mau' is not at ID 3 (meaning it's not sorted correctly yet)
    if ((defaultWordsCount && defaultWordsCount[0].count < 50) || (mauCheck && mauCheck.length > 0 && mauCheck[0].id !== '3')) {
      await db.runAsync('DELETE FROM aac_words WHERE isCustom = 0');
      await seedDefaultARASAACWords();
    }
  } catch (error) {
    console.error('Error initializing SQLite:', error);
  }
};

const seedDefaultARASAACWords = async () => {
  if (!db) return;
  
  try {
    // Memuat JSON Data Bilingual
    const seedData: AACWord[] = require('../../../assets/data/arasaac.json');
    
    const statement = await db.prepareAsync('INSERT INTO aac_words (id, word_id, word_zh, imageUrl, categoryId, isCustom) VALUES ($id, $word_id, $word_zh, $img, $cat, 0)');
    for (const word of seedData) {
      await statement.executeAsync({
        $id: word.id,
        $word_id: word.word_id,
        $word_zh: word.word_zh,
        $img: word.imageUrl || null,
        $cat: word.categoryId
      });
    }
    await statement.finalizeAsync();
  } catch (error) {
    console.error('Error seeding data:', error);
  }
};

export const getAllWords = async (): Promise<AACWord[]> => {
  if (!db) return [];
  const rows = await db.getAllAsync<any>('SELECT * FROM aac_words');
  return rows.map(r => ({
    id: r.id,
    word_id: r.word_id,
    word_zh: r.word_zh,
    imageUrl: r.imageUrl,
    categoryId: r.categoryId,
    isCustom: r.isCustom === 1
  }));
};

export const addCustomWord = async (word: AACWord) => {
  if (!db) return;
  await db.runAsync(
    'INSERT INTO aac_words (id, word_id, word_zh, imageUrl, categoryId, isCustom) VALUES (?, ?, ?, ?, ?, 1)',
    [word.id, word.word_id, word.word_zh, word.imageUrl || null, word.categoryId]
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

// --- FAVORITES LIFECYCLE ---
// A card is "favorite" iff categoryId === 'favorit'; its real category is
// preserved in previous_category_id so unfavoriting restores it exactly.
// Legacy favorites (created before the column existed) fall back to the
// ARASAAC seed category, 'custom' for custom words, or 'noun' as a last
// resort — a card can never get stuck in Favorites.

const findSeedCategory = (id: string): string | null => {
  try {
    const seedData: AACWord[] = require('../../../assets/data/arasaac.json');
    return seedData.find((w) => w.id === id)?.categoryId ?? null;
  } catch {
    return null;
  }
};

export const setWordFavorite = async (id: string, favorite: boolean): Promise<void> => {
  if (!db) return;
  const rows = await db.getAllAsync<any>(
    'SELECT categoryId, isCustom, previous_category_id FROM aac_words WHERE id = ?',
    [id]
  );
  const row = rows[0];
  if (!row) return;

  if (favorite) {
    if (row.categoryId === 'favorit') return; // already favorite — nothing to persist
    await db.runAsync(
      'UPDATE aac_words SET previous_category_id = ?, categoryId = ? WHERE id = ?',
      [row.categoryId, 'favorit', id]
    );
  } else {
    if (row.categoryId !== 'favorit') return; // not favorite — nothing to restore
    const restore =
      row.previous_category_id ||
      (row.isCustom === 1 ? 'custom' : findSeedCategory(id) || 'noun');
    await db.runAsync(
      'UPDATE aac_words SET categoryId = ?, previous_category_id = NULL WHERE id = ?',
      [restore, id]
    );
  }
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
