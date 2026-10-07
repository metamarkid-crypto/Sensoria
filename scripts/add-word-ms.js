/**
 * One-off: inject `word_ms` (Bahasa Melayu) into assets/data/arasaac.json.
 *
 * STRICT mode: every seed entry MUST have an explicit hand-picked mapping in
 * MS_MAP below (keyed by the entry `id` because word_id values are NOT unique,
 * e.g. Tolong ×2 / Jalan ×2). False friends vs Indonesian are deliberately
 * resolved to proper Malaysian vocabulary (mobil→Kereta, dingin→Sejuk,
 * dadah→Selamat Tinggal, dokter→Doktor, kapan→Bila, dll). Nothing is copied
 * silently from the Indonesian column.
 *
 * Run: node scripts/add-word-ms.js
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../assets/data/arasaac.json');

const MS_MAP = {
  1: 'Saya', 2: 'Awak', 3: 'Nak', 4: 'Suka', 5: 'Makan', 6: 'Minum',
  7: 'Tolong', 8: 'Tolong', 9: 'Berhenti', 10: 'Selesai', 11: 'Lagi',
  12: 'Ya', 13: 'Tidak', 14: 'Tandas', 15: 'Main', 16: 'Tidur', 17: 'Sakit',
  18: 'Bagus', 19: 'Dia', 20: 'Dia', 21: 'Kami', 22: 'Mereka', 23: 'Ibu',
  24: 'Ayah', 25: 'Keluarga', 26: 'Rumah', 27: 'Sekolah', 28: 'Kereta',
  29: 'Air', 30: 'Makanan', 31: 'Buku', 32: 'Mainan', 33: 'Katil',
  34: 'Pergi', 35: 'Lihat', 36: 'Dengar', 37: 'Bercakap', 38: 'Beri',
  39: 'Buka', 40: 'Tutup', 41: 'Mandi', 42: 'Buruk', 43: 'Gembira',
  44: 'Sedih', 45: 'Marah', 46: 'Panas', 47: 'Sejuk', 48: 'Besar',
  49: 'Kecil', 50: 'Lapar', 51: 'Dahaga', 52: 'Penat', 53: 'Terima Kasih',
  54: 'Maaf', 55: 'Hai', 56: 'Selamat Tinggal', 57: 'Tunggu', 58: 'Kepala',
  59: 'Mata', 60: 'Hidung', 61: 'Mulut', 62: 'Telinga', 63: 'Tangan',
  64: 'Kaki', 65: 'Perut', 66: 'Gigi', 67: 'Rambut', 68: 'Jari', 69: 'Lidah',
  70: 'Leher', 71: 'Bahu', 72: 'Lutut', 73: 'Dada', 74: 'Belakang',
  75: 'Pipi', 76: 'Kuku', 77: 'Tulang', 78: 'Sifar', 79: 'Satu', 80: 'Dua',
  81: 'Tiga', 82: 'Empat', 83: 'Lima', 84: 'Enam', 85: 'Tujuh', 86: 'Lapan',
  87: 'Sembilan', 88: 'Sepuluh', 89: 'Doktor', 90: 'Guru', 91: 'Polis',
  92: 'Jururawat', 93: 'Koki', 94: 'Petani', 95: 'Pemandu', 96: 'Juruterbang',
  97: 'Bomba', 98: 'Tentera', 99: 'Nelayan', 100: 'Penjual',
  101: 'Tukang Kayu', 102: 'Penjahit', 103: 'Doktor Gigi', 104: 'Astronot',
  105: 'Pemandu Kereta Api', 106: 'Pemuzik', 107: 'Pelukis', 108: 'Atlet',
  109: 'Nasi', 110: 'Roti', 111: 'Telur', 112: 'Susu', 113: 'Buah',
  114: 'Epal', 115: 'Pisang', 116: 'Oren', 117: 'Sayur', 118: 'Daging',
  119: 'Ayam', 120: 'Ikan', 121: 'Kek', 122: 'Biskut', 123: 'Gula-Gula',
  124: 'Ais Krim', 125: 'Jus', 126: 'Sup', 127: 'Keju', 128: 'Mi',
  129: 'Taman', 130: 'Pasar', 131: 'Masjid', 132: 'Gereja', 133: 'Hospital',
  134: 'Kedai', 135: 'Dapur', 136: 'Bilik', 137: 'Kelas', 138: 'Jalan',
  139: 'Bandar', 140: 'Kampung', 141: 'Pantai', 142: 'Gunung',
  143: 'Restoran', 144: 'Farmasi', 145: 'Bank', 146: 'Stesen',
  147: 'Lapangan Terbang', 148: 'Perpustakaan', 149: 'Pagi',
  150: 'Tengah Hari', 151: 'Petang', 152: 'Malam', 153: 'Hari', 154: 'Minggu',
  155: 'Bulan', 156: 'Tahun', 157: 'Sekarang', 158: 'Nanti', 159: 'Semalam',
  160: 'Esok', 161: 'Hari Ini', 162: 'Jam', 163: 'Bila', 164: 'Kucing',
  165: 'Anjing', 166: 'Burung', 167: 'Lembu', 168: 'Kambing', 169: 'Itik',
  170: 'Kuda', 171: 'Arnab', 172: 'Monyet', 173: 'Gajah', 174: 'Harimau',
  175: 'Ular', 176: 'Rama-Rama', 177: 'Ayam Jantan', 178: 'Kura-Kura',
  179: 'Baju', 180: 'Seluar', 181: 'Kasut', 182: 'Stokin', 183: 'Topi',
  184: 'Jaket', 185: 'Rok', 186: 'Kemeja', 187: 'Sandal',
  188: 'Sarung Tangan', 189: 'Syal', 190: 'Cermin Mata', 191: 'Beg',
  192: 'Jam Tangan', 193: 'Seluar Pendek', 194: 'Merah', 195: 'Biru',
  196: 'Kuning', 197: 'Hijau', 198: 'Hitam', 199: 'Putih', 200: 'Coklat',
  201: 'Ungu', 202: 'Oren', 203: 'Pink', 204: 'Kelabu', 205: 'Duduk',
  206: 'Berdiri', 207: 'Lari', 208: 'Berjalan', 209: 'Lompat', 210: 'Menangis',
  211: 'Ketawa', 212: 'Menulis', 213: 'Membaca', 214: 'Menyanyi',
  215: 'Menari', 216: 'Takut', 217: 'Terkejut', 218: 'Malu', 219: 'Bosan',
  220: 'Tenang', 221: 'Cepat', 222: 'Lambat', 223: 'Tinggi', 224: 'Pendek',
  225: 'Baru', 226: 'Meja', 227: 'Kerusi', 228: 'Pintu', 229: 'Tingkap',
  230: 'Lampu', 231: 'Televisyen', 232: 'Telefon', 233: 'Kunci', 234: 'Gelas',
  235: 'Piring', 236: 'Syabas', 237: 'Berhati-Hati', 238: 'Boleh',
  239: 'Jangan', 240: 'Bantu', 241: 'Ini', 242: 'Itu', 243: 'Sendiri',
  244: 'Semua',
};

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const missing = [];
const sameAsId = [];

const out = data.map((entry) => {
  const idNum = parseInt(entry.id, 10);
  const ms = MS_MAP[idNum];
  if (!ms || !ms.trim()) {
    missing.push(`${entry.id} (${entry.word_id})`);
    return entry;
  }
  if (ms === entry.word_id) sameAsId.push(`${entry.id}:${entry.word_id}→${ms}`);
  // Rebuild the object so `word_ms` sits right after `word_zh`.
  const rebuilt = {};
  for (const [k, v] of Object.entries(entry)) {
    rebuilt[k] = v;
    if (k === 'word_zh') rebuilt.word_ms = ms;
  }
  return rebuilt;
});

if (missing.length) {
  console.error('✗ FAIL — entries without an explicit ms mapping:', missing.join(', '));
  process.exit(1);
}

fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`✓ word_ms injected into ${out.length} entries.`);
console.log(`  identical to Indonesian (expected for cognates): ${sameAsId.length}`);
console.log('  ' + sameAsId.join(', '));
