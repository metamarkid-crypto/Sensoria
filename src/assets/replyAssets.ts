// ── Balasan Visual (Visual Replies) ─────────────────────────────────────────
// Untuk anak yang TIDAK BISA MENDENGAR: balasan parent tidak disuarakan,
// tetapi ditampilkan sebagai modal gambar besar. Pemetaan teks → gambar
// dilakukan di sini (satu sumber kebenaran) sehingga gambar bisa diganti
// cukup dengan menimpa file PNG di assets/replies/.
//
//  • oke.png      → persetujuan ("Oke", "Iya", "Boleh", …)
//  • tidak.png    → penolakan ("Tidak", "Jangan", …)  — PRIORITAS tertinggi
//  • tunggu.png   → penundaan ("Tunggu sebentar", "Sebentar ya", …)
//  • default.png  → pesan bebas di luar ketiga kategori di atas
import { ImageSourcePropType } from 'react-native';

export type VisualReplyKind = 'oke' | 'tidak' | 'tunggu' | 'default';

const REPLY_ASSETS: Record<VisualReplyKind, ImageSourcePropType> = {
  oke: require('../../assets/replies/oke.png'),
  tidak: require('../../assets/replies/tidak.png'),
  tunggu: require('../../assets/replies/tunggu.png'),
  default: require('../../assets/replies/default.png'),
};

export const getVisualReplyImage = (kind: VisualReplyKind): ImageSourcePropType =>
  REPLY_ASSETS[kind];

// Kata kunci per kategori (id + en + zh dasar). Dibandingkan per-token pada
// teks yang dinormalisasi, sehingga frasa seperti "Oke deh", "Tunggu sebentar
// ya" atau "Tidak boleh" tetap terdeteksi.
const OKE_WORDS = ['oke', 'ok', 'okey', 'okay', 'iya', 'ya', 'yes', 'baik', 'boleh', 'sip', 'siap', 'noted', '好的', '可以', '行', '嗯'];
const TIDAK_WORDS = ['tidak', 'tdk', 'gak', 'nggak', 'ga', 'jangan', 'no', 'nope', 'belum', 'jangan dulu', '不', '不要', '不可以'];
const TUNGGU_WORDS = ['tunggu', 'sebentar', 'wait', 'sabar', 'nanti', '等等', '等一下', '稍等'];

/**
 * Memetakan teks balasan parent ke kategori gambar. Urutan cek disengaja
 * safety-first: penolakan dinilai sebelum persetujuan ("tidak boleh" harus
 * jatuh ke TIDAK walau mengandung kata "boleh"), penundaan sebelum oke.
 * Segala teks di luar ketiganya → default (gambar pesan umum).
 */
export const resolveVisualReply = (text: string): VisualReplyKind => {
  const normalized = (text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.some((w) => TIDAK_WORDS.includes(w))) return 'tidak';
  if (tokens.some((w) => TUNGGU_WORDS.includes(w))) return 'tunggu';
  if (tokens.some((w) => OKE_WORDS.includes(w))) return 'oke';
  return 'default';
};
