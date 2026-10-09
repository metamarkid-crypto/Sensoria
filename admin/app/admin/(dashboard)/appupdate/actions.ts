"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import {
  getAppUpdateStatus,
  publishAppUpdateConfig,
  publishAppUpdateApk,
  APK_MAX_BYTES,
  QrisApiError,
  QRIS_API_ERRORS,
  type AppUpdateConfig,
} from "@/lib/qrisApi";

/**
 * /admin/appupdate — VPS-hosted Android self-update publishing.
 *
 * Owner-only server actions mirroring payment/actions.ts conventions:
 * each mutation writes an audit entry (app_update_publish) and maps
 * QrisApiError codes to friendly Indonesian messages.
 */

type ActionResult<T = undefined> = { ok: true; data?: T; message: string } | { ok: false; message: string };

function friendlyError(err: unknown): string {
  if (err instanceof QrisApiError) {
    switch (err.code) {
      case QRIS_API_ERRORS.NOT_CONFIGURED:
        return "QRIS_INTERNAL_SECRET belum di-set di environment dashboard.";
      case QRIS_API_ERRORS.SIGNATURE_REJECTED:
        return "Tanda tangan ditolak — QRIS_INTERNAL_SECRET dashboard berbeda dari server.";
      case QRIS_API_ERRORS.TIMEOUT:
        return "Server tidak menjawab (timeout). Untuk upload APK besar, coba lagi.";
      case QRIS_API_ERRORS.UNREACHABLE:
        return "Server tidak dapat dihubungi. Periksa status layanan.";
      case "BAD_VERSION_CODE":
        return "version_code harus angka bulat ≥ 0.";
      case "BAD_APK":
        return err.serverMessage || "File harus .apk.";
      case "NOTHING_TO_UPDATE":
        return "Tidak ada perubahan untuk dipublikasikan.";
      default:
        return err.message || "Terjadi kesalahan pada server aplikasi.";
    }
  }
  return err instanceof Error ? err.message : "Terjadi kesalahan tak terduga.";
}

export async function getAppUpdateStatusAction(): Promise<ActionResult<AppUpdateConfig>> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, message: "Hanya Owner yang boleh mengelola rilis aplikasi." };
  }
  try {
    const res = await getAppUpdateStatus();
    return { ok: true, data: res.config, message: "Status rilis dimuat." };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

export async function publishAppUpdateAction(input: {
  versionCode: string;
  versionName: string;
  notes: string;
  mandatory: boolean;
  apk?: File | null;
}): Promise<ActionResult<AppUpdateConfig>> {
  const admin = await requireOwner().catch(() => null);
  if (!admin) {
    return { ok: false, message: "Hanya Owner yang boleh mengelola rilis aplikasi." };
  }

  const trimmedCode = input.versionCode?.trim() ?? "";
  if (!trimmedCode && !input.versionName?.trim() && !input.notes?.trim() && !input.apk) {
    return { ok: false, message: "Isi minimal satu field atau lampirkan APK." };
  }

  let versionCodeNum: number | undefined;
  if (trimmedCode) {
    versionCodeNum = Number(trimmedCode);
    if (!Number.isInteger(versionCodeNum) || versionCodeNum < 0) {
      return { ok: false, message: "Version code harus angka bulat ≥ 0 (mis. 10)." };
    }
  }

  try {
    let config: AppUpdateConfig;
    if (input.apk && input.apk.size > 0) {
      if (input.apk.size > APK_MAX_BYTES) {
        return { ok: false, message: "APK melebihi 100 MB." };
      }
      if (!/\.apk$/i.test(input.apk.name || "")) {
        return { ok: false, message: "File harus berformat .apk." };
      }
      const bytes = new Uint8Array(await input.apk.arrayBuffer());
      const res = await publishAppUpdateApk(bytes, input.apk.name);
      config = res.config;
      // Attach optional metadata AFTER the upload (the API stores the file in
      // one call; notes/version/mandatory come in a second small signed call).
      const meta: { version_code?: number; version_name?: string; notes?: string; mandatory?: boolean } = {};
      if (versionCodeNum !== undefined) meta.version_code = versionCodeNum;
      if (input.versionName?.trim()) meta.version_name = input.versionName.trim();
      if (input.notes?.trim()) meta.notes = input.notes.trim();
      meta.mandatory = input.mandatory;
      if (Object.keys(meta).filter((k) => k !== "mandatory" || meta.mandatory === true).length > 0) {
        const metaRes = await publishAppUpdateConfig(meta);
        config = metaRes.config;
      }
    } else {
      const patch: { version_code?: number; version_name?: string; notes?: string; mandatory?: boolean } = {};
      if (versionCodeNum !== undefined) patch.version_code = versionCodeNum;
      if (input.versionName?.trim()) patch.version_name = input.versionName.trim();
      if (input.notes?.trim()) patch.notes = input.notes.trim();
      patch.mandatory = input.mandatory;
      const res = await publishAppUpdateConfig(patch);
      config = res.config;
    }

    await writeAudit({
      action: "app_update_publish",
      scope: "app-update",
      description: `Published app update: version_code=${config.latest_version_code}${config.latest_version_name ? ` (v${config.latest_version_name})` : ""}${config.apk_file ? `, apk=${config.apk_file}` : ""}${config.mandatory ? " [MANDATORY]" : ""}.`,
      actorEmail: admin.email,
      metadata: {
        latest_version_code: config.latest_version_code,
        latest_version_name: config.latest_version_name,
        apk_file: config.apk_file,
        mandatory: config.mandatory,
      },
    });
    revalidatePath("/admin/appupdate");
    return {
      ok: true,
      data: config,
      message: `Rilis version_code=${config.latest_version_code}${config.latest_version_name ? ` (v${config.latest_version_name})` : ""} dipublikasikan.`,
    };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}
