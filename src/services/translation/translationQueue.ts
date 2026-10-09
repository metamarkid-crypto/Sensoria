/**
 * translationQueue.ts — offline-deferred flusher for the free (non-AI)
 * auto-translate of user-added custom words.
 *
 * Contract (fase kamus pengguna):
 *   • Adding a word NEVER requires translation to succeed — the typed label
 *     is stored in all four columns up front, so the card is usable in every
 *     language immediately (identical labels until a translation lands).
 *   • While offline the job waits in SQLite (translation_queue); this flusher
 *     runs when connectivity returns and fills the three siblings via
 *     freeTranslate (MyMemory → Lingva — deterministic MT, NO AI/LLM).
 *   • Poison-pill guard: MAX_TRANSLATION_ATTEMPTS then drop (never wedges FIFO).
 *
 * Lifecycle: startTranslationFlusher() is called once from the AAC screen
 * mount; it flushes immediately and re-flushes on every offline→online edge
 * (expo-network). Returns a stop function for unmount.
 */

import * as Network from 'expo-network';
import {
  getTranslationJobs,
  deleteTranslationJob,
  bumpTranslationAttempts,
  MAX_TRANSLATION_ATTEMPTS,
} from '../db/sqlite';
import { translateWordFree, quadComplete, type Quad } from './freeTranslate';
import { updateWord } from '../db/sqlite';
import { logger } from '../../utils/logger';

let flushing = false;

/** True when the device currently has usable internet. */
export const isOnline = async (): Promise<boolean> => {
  try {
    const st = await Network.getNetworkStateAsync();
    return Boolean(st?.isConnected && st.isInternetReachable !== false);
  } catch {
    return false; // can't verify → assume offline (defer, never block)
  }
};

/**
 * Process pending jobs. Safe to call repeatedly (single-flight guard).
 * Returns { flushed, remaining } for logging/tests. NEVER throws.
 */
export const flushTranslationQueue = async (): Promise<{ flushed: number; remaining: number }> => {
  if (flushing) return { flushed: 0, remaining: -1 };
  flushing = true;
  let flushed = 0;
  try {
    if (!(await isOnline())) {
      const jobs = await getTranslationJobs(1);
      return { flushed: 0, remaining: jobs.length >= 0 ? jobs.length : 0 };
    }

    const jobs = await getTranslationJobs(20);
    for (const job of jobs) {
      try {
        const partial = await translateWordFree(job.word, job.from_lang as keyof Quad);
        if (quadComplete(partial, job.from_lang as keyof Quad)) {
          // Only patch the three siblings — the human's typed label (from_lang)
          // is never overwritten by the pipeline that consumed it.
          const patch: Record<string, string> = {};
          if (job.from_lang !== 'id' && partial.id) patch.word_id = partial.id;
          if (job.from_lang !== 'en' && partial.en) patch.word_en = partial.en;
          if (job.from_lang !== 'zh' && partial.zh) patch.word_zh = partial.zh;
          if (job.from_lang !== 'ms' && partial.ms) patch.word_ms = partial.ms;
          await updateWord(job.word_id, patch);
          await deleteTranslationJob(job.id);
          flushed += 1;
        } else {
          // Partial success: keep the job — a later flush retries the misses.
          const attempts = await bumpTranslationAttempts(job.id);
          if (attempts >= MAX_TRANSLATION_ATTEMPTS) {
            logger.logError(new Error('translation job dropped (max attempts)'), {
              action: 'translation_queue_drop',
              wordId: job.word_id,
            });
            await deleteTranslationJob(job.id);
          }
        }
      } catch (e) {
        const attempts = await bumpTranslationAttempts(job.id);
        if (attempts >= MAX_TRANSLATION_ATTEMPTS) {
          await deleteTranslationJob(job.id);
        }
        logger.logError(e, { action: 'translation_flush_job_failed', wordId: job.word_id });
      }
    }
    const { countTranslationJobs } = await import('../db/sqlite');
    return { flushed, remaining: await countTranslationJobs() };
  } catch (e) {
    logger.logError(e, { action: 'translation_flush_failed' });
    return { flushed, remaining: -1 };
  } finally {
    flushing = false;
  }
};

/**
 * Start the connectivity-driven flusher. Flushes once immediately, then on
 * every offline→online transition. Call the returned fn on unmount.
 */
export const startTranslationFlusher = (onSettled?: () => void): (() => void) => {
  let wasOnline: boolean | null = null;
  const sub = Network.addNetworkStateListener?.((state) => {
    const online = Boolean(state?.isConnected && state.isInternetReachable !== false);
    if (wasOnline === false && online) {
      void flushTranslationQueue().then((r) => {
        if (r.flushed > 0) onSettled?.();
      });
    }
    wasOnline = online;
  });
  // Initial flush (covers app opening while already online with backlog).
  void flushTranslationQueue().then((r) => {
    if (r.flushed > 0) onSettled?.();
  });
  return () => {
    try {
      sub?.remove?.();
    } catch {
      /* listener already gone */
    }
  };
};
