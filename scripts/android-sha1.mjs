#!/usr/bin/env node
/**
 * android-sha1.mjs — cetak SHA-1 & SHA-256 sidik jari sertifikat dari keystore
 * JKS, tanpa butuh `keytool`/Java.
 *
 * Kenapa ada: Firebase Console → Project settings → Your apps → AAC Sensoria
 * punya kolom "SHA certificate fingerprints" yang HARUS diisi, kalau tidak
 * Google Sign-In / App Check / (untuk Maps API key yang dibatasi per-app)
 * permintaan dari app akan ditolak. `keytool -list -v` adalah cara resmi, tapi
 * sering tidak tersedia di mesin build/dev (tidak ada JDK). JKS hanya format
 * biner sederhana, jadi cukup dibaca langsung.
 *
 * Pemakaian:
 *   node scripts/android-sha1.mjs                     # keystore release repo
 *   node scripts/android-sha1.mjs path/to/file.jks
 *
 * Catatan: keystore *password* tidak dibutuhkan. Sertifikat di dalam JKS
 * tersimpan sebagai DER polos (tidak terenkripsi) — hanya private key yang
 * dienkripsi. Kita cuma membaca sertifikat, jadi tidak ada rahasia yang
 * dibongkar di sini.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_KEYSTORES = ['@metamark__Sensoria.jks', 'android/app/debug.keystore'];

const MAGIC = 0xfeedfeed;

/** Baca satu entry JKS. Format: magic, version, count, lalu tiap entry. */
function parseJks(buf) {
  let o = 0;
  const u2 = () => {
    const v = buf.readUInt16BE(o);
    o += 2;
    return v;
  };
  const u4 = () => {
    const v = buf.readUInt32BE(o);
    o += 4;
    return v;
  };
  const utf = () => {
    const n = u2();
    const s = buf.toString('utf8', o, o + n);
    o += n;
    return s;
  };
  const skip = (n) => {
    o += n;
  };

  if (buf.length < 12 || u4() !== MAGIC) {
    throw new Error('bukan file JKS (magic 0xFEEDFEED tidak ditemukan)');
  }
  const version = u4();
  const count = u4();
  const entries = [];

  for (let i = 0; i < count; i++) {
    const tag = u4();
    const alias = utf();
    skip(8); // timestamp
    if (tag === 1) {
      skip(u4()); // panjang private key (terenkripsi) — tidak kita dekripsi
      const chainLen = u4();
      const certs = [];
      for (let c = 0; c < chainLen; c++) {
        const type = utf();
        const len = u4();
        certs.push({ type, der: buf.subarray(o, o + len) });
        skip(len);
      }
      entries.push({ alias, kind: 'privateKey', certs });
    } else if (tag === 2) {
      // Trusted certificate entry: satu sertifikat, tanpa private key.
      const type = utf();
      const len = u4();
      entries.push({ alias, kind: 'trustedCert', certs: [{ type, der: buf.subarray(o, o + len) }] });
      skip(len);
    } else {
      entries.push({ alias, kind: `unknown(${tag})`, certs: [] });
    }
  }
  return { version, entries };
}

const fingerprint = (der, algo) =>
  createHash(algo).update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':');

function report(file) {
  const abs = resolve(ROOT, file);
  const { version, entries } = parseJks(readFileSync(abs));
  console.log(`\n📄 ${file}  (JKS v${version}, ${entries.length} entry)`);
  let found = 0;
  for (const e of entries) {
    if (!e.certs.length) {
      console.log(`   • ${e.alias} — entry ${e.kind} tanpa sertifikat terbaca`);
      continue;
    }
    e.certs.forEach((c, idx) => {
      found++;
      console.log(`   • alias ${e.alias}${e.certs.length > 1 ? ` (cert #${idx})` : ''}`);
      console.log(`     SHA-1   ${fingerprint(c.der, 'sha1')}`);
      console.log(`     SHA-256 ${fingerprint(c.der, 'sha256')}`);
    });
  }
  return found;
}

const targets = process.argv.slice(2);
const files = targets.length ? targets : DEFAULT_KEYSTORES.filter((f) => {
  try {
    readFileSync(resolve(ROOT, f));
    return true;
  } catch {
    return false;
  }
});

if (!files.length) {
  console.error('✖ Tidak ada keystore ditemukan. Berikan path: node scripts/android-sha1.mjs <file.jks>');
  process.exit(1);
}

let total = 0;
for (const f of files) {
  try {
    total += report(f);
  } catch (err) {
    console.error(`✖ ${f}: ${err.message}`);
    process.exitCode = 1;
  }
}

if (!total) {
  console.error('\n✖ Tidak ada sertifikat yang bisa dibaca.');
  process.exit(1);
}
