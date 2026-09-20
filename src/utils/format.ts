/**
 * Shared Indonesian formatting helpers (no Intl dependency — Hermes/React
 * Native target, mirroring PaywallScreen's local helpers).
 */

const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

/** "12 Februari 2026" from an ISO string; '' when null/invalid. */
export const formatDate = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS_ID[d.getMonth()]} ${d.getFullYear()}`;
};

/**
 * Normalize a message timestamp to epoch-milliseconds.
 *
 * `messages.timestamp` is written as `Date.now()` (a number) but PostgREST
 * returns `bigint`/`numeric` columns as STRINGS (e.g. "1750000000000") to
 * avoid JS precision loss. `new Date("1750000000000")` is an Invalid Date in
 * every engine, so every call site must coerce the string back to a number
 * first. This helper accepts number, numeric string, ISO string, or Date.
 */
export const toTimestampMs = (ts: unknown): number => {
  if (ts == null) return NaN;
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'string') {
    const s = ts.trim();
    if (s === '') return NaN;
    const numeric = Number(s);
    if (!Number.isNaN(numeric)) return numeric; // "1750000000000" → ms
    const parsed = new Date(s).getTime();       // ISO 8601
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
};

/** "14:05" from a message timestamp (any supported format); '' when invalid. */
export const formatTime = (ts: unknown): string => {
  const ms = toTimestampMs(ts);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};