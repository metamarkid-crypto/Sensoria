import { Platform } from 'react-native';
import * as Application from 'expo-application';
import * as IntentLauncher from 'expo-intent-launcher';
// SDK 57: the progress-capable downloader lives in the legacy barrel
// (DownloadResumable + DownloadProgressData); the modern File/Directory API
// has no progress callback yet.
import * as FileSystem from 'expo-file-system/legacy';
import { QRIS_API_BASE_URL } from './db/paywall';

/**
 * App self-update — APK distribution hosted on OUR payment VPS (no Play
 * Store requirement for updates).
 *
 * Flow:
 *   1. checkForAppUpdate() — GET /api/app-update/check?version_code=N. The
 *      server compares against the version published from the admin panel
 *      and, when newer, answers an EXPIRING HMAC-signed download URL (never
 *      a static link) plus honest apk_ready flag.
 *   2. downloadUpdateApk() — DownloadResumable with progress callbacks
 *      (0..1) fed straight into the update modal's progress bar.
 *   3. installUpdateApk() — file:// → content:// via FileProvider, then
 *      ACTION_VIEW /application/vnd.android.package-archive so Package
 *      Installer takes over; the user must grant "install unknown apps".
 *      Android restarts the app itself once the package replaces ours.
 *
 * iOS is a no-op (updates go through Apple); every network failure resolves
 * to null instead of throwing so the splash never stalls.
 */

export interface AppUpdateInfo {
  update_available: boolean;
  latest_version_code: number;
  latest_version_name: string | null;
  release_notes: string | null;
  mandatory: boolean;
  download_url: string | null;
  apk_ready: boolean;
}

export interface InstallProgress {
  /** 0..1 (0 when Content-Length is absent until the first bytes land). */
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
}

const APK_MIME = 'application/vnd.android.package-archive';

/** Read the installed Android versionCode (app.json android.versionCode). */
function installedVersionCode(): number {
  try {
    // Constant name in this SDK: versionCode is numbers-only on Play Store,
    // but GitHub-distribution builds can also track the version name patch.
    const code = Application.nativeBuildVersion;
    if (typeof code === 'number') return code;
    if (typeof code === 'string' && code.trim() !== '' && Number.isFinite(Number(code))) {
      return Number(code);
    }
  } catch {
    /* fallthrough */
  }
  return 0;
}

/**
 * Outcome of one update check:
 *   • available — a newer, downloadable APK is published
 *   • none      — up to date, iOS/unknown version, or not yet downloadable
 *   • error     — transient failure (network, timeout, non-200, bad JSON);
 *                 the caller may retry
 */
export type AppUpdateCheck =
  | { status: 'available'; info: AppUpdateInfo }
  | { status: 'none' }
  | { status: 'error' };

const CHECK_TIMEOUT_MS = 15_000;

/** Check for an update. Never throws; the result says whether to retry. */
export async function checkForAppUpdate(): Promise<AppUpdateCheck> {
  if (Platform.OS !== 'android') return { status: 'none' };
  const code = installedVersionCode();
  if (!code || code <= 0) return { status: 'none' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${QRIS_API_BASE_URL}/api/app-update/check?version_code=${encodeURIComponent(String(code))}`,
      { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal },
    );
    if (!res.ok) return { status: 'error' };
    const body = (await res.json()) as AppUpdateInfo;
    if (!body || !body.update_available || !body.download_url || !body.apk_ready) {
      return { status: 'none' };
    }
    return { status: 'available', info: body };
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download the APK with progress. Resolves the local file:// URI of the
 * finished APK, or null on any failure. progress is throttled to 1% steps.
 */
export async function downloadUpdateApk(
  downloadUrl: string,
  onProgress?: (p: InstallProgress) => void,
): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const url = downloadUrl.startsWith('http') ? downloadUrl : `${QRIS_API_BASE_URL}${downloadUrl}`;
  const fileUri = `${FileSystem.documentDirectory}sensoria-update.apk`;

  let lastPercent = -1;
  const throttled = (data: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => {
    const total = data.totalBytesExpectedToWrite > 0 ? data.totalBytesExpectedToWrite : null;
    const progress = total ? data.totalBytesWritten / total : 0;
    const percent = Math.floor(progress * 100);
    if (percent > lastPercent) {
      lastPercent = percent;
      try {
        onProgress?.({ progress, downloadedBytes: data.totalBytesWritten, totalBytes: total });
      } catch {
        /* UI listener failure must never abort the download */
      }
    }
  };

  try {
    // Idempotent overwrite: a half-finished file from a previous attempt is
    // replaced (the server signs name+expiry, so the URL is always fresh).
    const resumable = FileSystem.createDownloadResumable(
      url,
      fileUri,
      { md5: false, cache: false },
      throttled,
    );
    const result = await resumable.downloadAsync();
    if (!result || result.status !== 200) return null;
    return result.uri;
  } catch {
    return null;
  }
}

/**
 * Hand the APK to Android's Package Installer:
 *   file:// → content:// (FileProvider of expo-file-system) →
 *   ACTION_VIEW with the APK mime type + FLAG_GRANT_READ_URI_PERMISSION.
 * Android requires the "install unknown apps" grant for our package; the
 * system sheet appears on first use. After install the system restarts us.
 */
export async function installUpdateApk(fileUri: string): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const contentUri = await FileSystem.getContentUriAsync(fileUri);
    // ActivityAction enum only carries settings screens; the VIEW action is a
    // plain string (same pattern as the expo-file-system docs).
    await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: APK_MIME,
      flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    });
    return true;
  } catch {
    return false;
  }
}

/** Delete a leftover APK (after install attempt or on modal dismiss). */
export async function cleanupUpdateApk(): Promise<void> {
  try {
    await FileSystem.deleteAsync(`${FileSystem.documentDirectory}sensoria-update.apk`, { idempotent: true });
  } catch {
    /* nothing to clean */
  }
}
