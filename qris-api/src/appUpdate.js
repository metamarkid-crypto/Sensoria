'use strict';

/**
 * appUpdate.js — mobile APP self-update config (VPS-hosted distribution).
 *
 * The admin dashboard publishes "the latest app version" as a small JSON
 * blob on disk (updates/config.json) plus the .apk file itself
 * (updates/<version>.apk). The public check endpoint reads the config and —
 * when the client's versionCode is older — answers a signed download URL
 * (HMAC, short-lived) pointing back at our own /api/app-update/download.
 *
 * SECURITY:
 *   • Writes go ONLY through POST /internal/app-update (HMAC QRIS_INTERNAL_SECRET).
 *   • The public check leaks nothing but versions + a scoped, expiring URL.
 *   • File name is sanitised (basename, .apk only) — no traversal.
 *   • Download requires a valid signature over version+expiry.
 *
 * Storage: plain filesystem next to the app (updates/). Kept OUT of git
 * (deploy tarball only ships code); backups cover config.json.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

let updatesDirPath = path.join(__dirname, '..', 'updates');
/** Live getter + test hook: ALWAYS call updatesDir() instead of capturing
 *  the path (setUpdatesDir lets tests redirect storage atomically). */
function updatesDir() {
  return updatesDirPath;
}
function setUpdatesDir(p) {
  updatesDirPath = p;
}
function configPath() {
  return path.join(updatesDir(), 'config.json');
}

const DEFAULT_CONFIG = { latest_version_code: 0, latest_version_name: null, apk_file: null, release_notes: null, mandatory: false, updated_at: null };

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch, updated_at: new Date().toISOString() };
  fs.mkdirSync(updatesDir(), { recursive: true });
  // Atomic-ish write: temp file + rename so a crash never leaves a torn JSON.
  const CONFIG_PATH = configPath();
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

/** Save an uploaded APK next to the config; returns the stored file name. */
function storeApk(fileName, buffer) {
  const safe = path.basename(String(fileName || 'app.apk')).replace(/[^\w.\-]/g, '_');
  if (!/\.apk$/i.test(safe)) {
    const e = new Error('Hanya file .apk yang diterima.');
    e.code = 'BAD_APK';
    throw e;
  }
  fs.mkdirSync(updatesDir(), { recursive: true });
  fs.writeFileSync(path.join(updatesDir(), safe), buffer);
  return safe;
}

/** HMAC-signed, expiring download URL params for the mtime-less file name. */
function signDownload(fileName, ttlSeconds, secret) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${fileName}.${exp}`)
    .digest('hex');
  return { exp, sig };
}

function verifyDownload(fileName, exp, sig, secret) {
  if (!fileName || !exp || !sig) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  const expect = crypto.createHmac('sha256', secret).update(`${fileName}.${expNum}`).digest('hex');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const APK_RE = /^[\w.\-]+\.apk$/i;

module.exports = {
  readConfig,
  writeConfig,
  storeApk,
  signDownload,
  verifyDownload,
  APK_RE,
  updatesDir,
  setUpdatesDir,
};
