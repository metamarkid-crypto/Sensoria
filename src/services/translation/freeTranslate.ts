/**
 * freeTranslate.ts — NON-AI auto-translate for user-added custom words.
 *
 * Requirement (fase kamus pengguna): saat pengguna menambah/mengubah kata,
 * tiga bahasa lainnya harus terisi OTOMATIS — tanpa AI (Gemini dilarang untuk
 * jalur ini), dan TANPA memblokir UI. Saat offline, terjemahan DITUNDA:
 * tambah kamus tetap sukses (kartu langsung pakai kata yang diketik di semua
 * bahasa), dan antrian di-flush otomatis begitu perangkat online kembali.
 *
 * Provider 1 — WIKIDATA (primer): label konsep kurasi manusia, jauh lebih
 *   akurat untuk kata benda/umum anak daripada MT; multilingual sekali ambil
 *   (id/en/zh/ms dalam SATU request). Bukan LLM: deterministik, tanpa
 *   halusinasi. Kandidat item dinilai heuristik kualitas (lihat scoreConcept).
 * Provider 2 — MyMemory (fallback): MT klasik gratis tanpa API key. Output
 *   dibersihkan & divalidasi (balasan sampah "translation from X to Y"
 *   ditolak). Semua permintaan ber-timeout pendek (5s) dan SELALU resolve —
 *   kegagalan jaringan hanya berarti "tetap di antrian", bukan error UI.
 */

import axios from 'axios';

export type Quad = { id: string; en: string; zh: string; ms: string };
export type Lang = 'id' | 'en' | 'zh' | 'ms';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_LANGS = 'id|en|zh|ms';
const UA_HEADERS = {
  headers: {
    // Wikimedia robot policy: a descriptive UA is REQUIRED (else 403).
    'User-Agent': 'SensoriaAAC/1.0 (https://aacsensoria.id; support@aacsensoria.id)',
  },
};
const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
const MYMEMORY_LANG: Record<Lang, string> = { id: 'id', en: 'en-GB', zh: 'zh-CN', ms: 'ms' };
const timeoutCfg = { timeout: 5000 };

/** Net-new: only translate the THREE siblings, never the typed language. */
const SIBLINGS: Record<Lang, Lang[]> = {
  id: ['en', 'zh', 'ms'],
  en: ['id', 'zh', 'ms'],
  zh: ['id', 'en', 'ms'],
  ms: ['id', 'en', 'zh'],
};

// ---------------------------------------------------------------------------
// Provider 1: Wikidata concepts (human-curated multilingual labels)
// ---------------------------------------------------------------------------

type Concept = { id: string; en: string; zh: string; ms: string };

/** Heuristic quality score — pick the most child-friendly concept candidate. */
function scoreConcept(c: Concept, typedWord: string): number {
  let s = 0;
  const typed = typedWord.toLowerCase();
  const labels = [c.id, c.en, c.ms].map((x) => x.toLowerCase());
  // The child's typed word appearing verbatim as a label in ANY sibling
  // language is a strong identity signal (e.g. "kucing" is the ms label too).
  if (labels.includes(typed)) s += 2;
  // Multi-word concepts ("Barbie film", "cat-like") are usually NOT what a
  // child names with one word. Prefer short labels.
  const maxLen = Math.max(c.id.length, c.en.length, c.ms.length);
  if (maxLen <= 12) s += 1;
  else if (maxLen > 24) s -= 1;
  // Disambiguation-friendly metadata is unavailable via wbgetentities(props
  // = labels); instead penalize labels containing punctuation/parens.
  if (/[(\[，,]/.test(c.zh)) s -= 1;
  return s;
}

/** Search + score + label fetch. Returns null when no usable concept. */
async function wikidataLookup(word: string, from: Lang): Promise<Concept | null> {
  try {
    const sr = await axios.get(WIKIDATA_API, {
      ...UA_HEADERS,
      ...timeoutCfg,
      params: { action: 'wbsearchentities', search: word, language: from, format: 'json', limit: 5 },
    });
    const ids: string[] = (sr.data?.search || []).map((h: any) => h.id).slice(0, 3);
    if (ids.length === 0) return null;

    const er = await axios.get(WIKIDATA_API, {
      ...UA_HEADERS,
      ...timeoutCfg,
      params: {
        action: 'wbgetentities',
        ids: ids.join('|'),
        props: 'labels',
        languages: WIKIDATA_LANGS,
        format: 'json',
      },
    });
    const entities = er.data?.entities || {};

    let best: { c: Concept; s: number } | null = null;
    for (const qid of ids) {
      const L = entities[qid]?.labels || {};
      if (!L.id?.value || !L.en?.value || !L.zh?.value || !L.ms?.value) continue;
      const c: Concept = { id: L.id.value, en: L.en.value, zh: L.zh.value, ms: L.ms.value };
      const s = scoreConcept(c, word);
      if (!best || s > best.s) best = { c, s };
    }
    return best ? best.c : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider 2: MyMemory MT fallback (validated + cleaned)
// ---------------------------------------------------------------------------

/** Reject MyMemory garbage: meta-sentences, warnings, HTML entities, blanks. */
function cleanMyMemory(t: string | undefined | null): string | null {
  if (typeof t !== 'string') return null;
  let s = t.trim();
  if (!s) return null;
  if (/^MYMEMORY WARNING/i.test(s)) return null;
  // Meta replies ("translation from Indonesian to Chinese", "中国语言字典马来")
  // are corpus noise, not translations — but distinguishing them reliably for
  // zh is hard; the length/letter heuristic below catches the obvious ones.
  if (/translation from/i.test(s) || /语言字典/.test(s)) return null;
  s = s
    .replace(/&#\d+;/g, ' ') // &#10; newline entity artifacts
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > 40) return null; // single child word — never a sentence
  return s;
}

async function myMemoryOne(text: string, from: Lang, to: Lang): Promise<string | null> {
  try {
    const res = await axios.get(MYMEMORY_URL, {
      ...timeoutCfg,
      params: { q: text, langpair: `${MYMEMORY_LANG[from]}|${MYMEMORY_LANG[to]}`, mt: 1 },
    });
    return cleanMyMemory(res?.data?.responseData?.translatedText);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** One word, one direction — MT fallback (used when Wikidata missed). */
export async function translateOne(text: string, from: Lang, to: Lang): Promise<string | null> {
  return myMemoryOne(text, from, to);
}

/**
 * Translate `word` (typed in `from`) into the other three languages.
 * Strategy: ONE Wikidata lookup covers all three siblings at once with
 * human-curated labels; per-direction MyMemory fills any concept that failed
 * (or the whole quad when no concept matched). Returns a PARTIAL quad: the
 * typed language keeps the human's exact word; failed directions come back
 * null so the caller keeps the current label and the queue retries later.
 * NEVER throws.
 */
export async function translateWordFree(word: string, from: Lang): Promise<Partial<Quad>> {
  const out: Partial<Quad> = { [from]: word } as Partial<Quad>;

  const concept = await wikidataLookup(word, from);
  const missing: Lang[] = [];
  for (const to of SIBLINGS[from]) {
    const v = concept ? (concept[to] as string | undefined) : undefined;
    if (v && v.length <= 40) out[to] = v;
    else missing.push(to);
  }
  await Promise.all(
    missing.map(async (to) => {
      const r = await myMemoryOne(word, from, to);
      if (r) out[to] = r;
    }),
  );
  return out;
}

/** True when every sibling direction resolved (queue job can be cleared). */
export function quadComplete(q: Partial<Quad>, from: Lang): boolean {
  return SIBLINGS[from].every((to) => typeof q[to] === 'string' && q[to]!.length > 0);
}
