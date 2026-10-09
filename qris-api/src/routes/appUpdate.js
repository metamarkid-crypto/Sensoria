'use strict';

/**
 * routes/appUpdate.js — mobile APP self-update (VPS-hosted distribution).
 *
 *   GET  /api/app-update/check?version_code=N  → {update_available, ...}
 *   GET  /api/app-update/download?f=<apk>&exp=<ts>&sig=<hmac> → APK bytes
 *   POST /internal/app-update   (HMAC QRIS_INTERNAL_SECRET, multipart or raw)
 *        → publishes the new config + stores the APK on the VPS
 *   GET  /internal/app-update/status → current published config
 *
 * SECURITY:
 *   • Writes only via the internal HMAC mount (+ dashboard Owner gating).
 *   • The public check leaks versions + an EXPIRING signed URL only.
 *   • Download filename is sanitised (.apk basename), signature covers
 *     name+expiry (replay dies with the expiry).
 *   • Range requests supported (Android DownloadManager/resumable).
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const appUpdate = require('../appUpdate');

const router = express.Router();

// Public: latest-version check (called by the app at launch + settings).
async function checkUpdate(req, res, next) {
  try {
    const cfg = appUpdate.readConfig();
    const clientCode = Number(req.query.version_code);
    const updateAvailable =
      Number.isFinite(clientCode) && clientCode > 0 && cfg.latest_version_code > clientCode;

    let downloadUrl = null;
    if (updateAvailable && cfg.apk_file) {
      const secret = process.env.QRIS_API_SECRET || 'insecure-dev-secret';
      const { exp, sig } = appUpdate.signDownload(cfg.apk_file, 6 * 3600, secret);
      downloadUrl = `/api/app-update/download?f=${encodeURIComponent(cfg.apk_file)}&exp=${exp}&sig=${sig}`;
    }

    return res.json({
      update_available: updateAvailable,
      latest_version_code: cfg.latest_version_code,
      latest_version_name: cfg.latest_version_name,
      release_notes: cfg.release_notes || null,
      mandatory: Boolean(cfg.mandatory),
      download_url: downloadUrl, // relative — app prepends QRIS_API_BASE_URL
      apk_ready: Boolean(cfg.apk_file && fs.existsSync(path.join(appUpdate.updatesDir(), cfg.apk_file))),
    });
  } catch (err) {
    return next(err);
  }
}

// Public: stream the APK (signature-verified, resumable).
function downloadApk(req, res, next) {
  try {
    const f = String(req.query.f || '');
    const { exp, sig } = req.query;
    const secret = process.env.QRIS_API_SECRET || 'insecure-dev-secret';
    if (!appUpdate.APK_RE.test(f) || !appUpdate.verifyDownload(f, exp, sig, secret)) {
      return res.status(403).json({ error: 'BAD_SIGNATURE', message: 'Link unduhan tidak valid/kedaluwarsa. Buka aplikasi lagi.' });
    }
    const filePath = path.join(appUpdate.updatesDir(), f);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'APK_NOT_FOUND', message: 'File update tidak tersedia.' });
    }
    return res.download(filePath, f);
  } catch (err) {
    return next(err);
  }
}

// Internal: publish/update the version entry (multipart file + fields, or config-only).
async function publishUpdate(req, res, next) {
  try {
    const b = req.body || {};
    const patch = {};

    if (b.version_code !== undefined) {
      const code = Number(b.version_code);
      if (!Number.isInteger(code) || code < 0) {
        return res.status(400).json({ error: 'BAD_VERSION_CODE', message: 'version_code harus integer ≥ 0.' });
      }
      patch.latest_version_code = code;
    }
    if (b.version_name !== undefined) patch.latest_version_name = String(b.version_name).slice(0, 32) || null;
    if (b.notes !== undefined) patch.release_notes = String(b.notes).slice(0, 2000) || null;
    if (b.mandatory !== undefined) patch.mandatory = /^(1|true|yes)$/i.test(String(b.mandatory));

    // APK upload: multipart field `file`, or raw application/vnd.android.package-archive body.
    const apk = req.file && req.file.buffer ? req.file.buffer : Buffer.isBuffer(req.body) ? req.body : null;
    if (apk && apk.length > 0) {
      const name =
        (req.file && req.file.originalname) ||
        (b.apk_name ? `${String(b.apk_name).replace(/[^\w.\-]/g, '_')}.apk` : `sensoria-${patch.latest_version_code || 'latest'}.apk`);
      patch.apk_file = appUpdate.storeApk(name, apk);
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'NOTHING_TO_UPDATE', message: 'Kirim minimal satu field.' });
    }
    const cfg = appUpdate.writeConfig(patch);
    return res.json({ ok: true, config: cfg });
  } catch (err) {
    if (err.code === 'BAD_APK') {
      return res.status(400).json({ error: 'BAD_APK', message: err.message });
    }
    return next(err);
  }
}

// Internal: read current config (dashboard panel render).
async function updateStatus(req, res) {
  return res.json({ config: appUpdate.readConfig() });
}

// NOTE: this router is mounted at app root ('/') in app.js — the public
// check/download MUST carry the /api prefix here; the publish/status pair
// resolves under the /internal mount (app.use('/internal', ...)).
router.get('/api/app-update/check', checkUpdate);
router.get('/api/app-update/download', downloadApk);
router.post('/app-update', publishUpdate);
router.get('/app-update/status', updateStatus);

module.exports = { router, checkUpdate, downloadApk, publishUpdate };
