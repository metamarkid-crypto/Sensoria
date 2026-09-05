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