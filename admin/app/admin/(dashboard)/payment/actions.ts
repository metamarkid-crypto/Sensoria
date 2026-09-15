"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import {
  getMerchantStatus,
  startMerchantOtp,
  verifyMerchantOtp,
  setMerchantQrisPayload,
  setMerchantQrisImage,
  refreshMerchantToken,
  runWorkerSweep,
  QrisApiError,
  QRIS_API_ERRORS,
  DEFAULT_QR_IMAGE_MAX_BYTES,
  type MerchantStatusResponse,
  type OtpStartResponse,
  type VerifyResponse,
  type MerchantView,
  type QrisImageUploadResponse,
} from "@/lib/qrisApi";

/**
 * /admin/payment — QRIS merchant provisioning (blueprint §6 step 5).
 *
 * Access model: EVERY action here is Owner-only (support admins see the
 * panel read-only). Each mutating action writes an audit entry
 * (qris_merchant_link / qris_static_qr_set / qris_token_refresh /
 * qris_worker_run) BEFORE its result is returned — the trail is the reason
 * these endpoints exist behind a dashboard instead of raw curl.
 *
 * Failure mapping: QrisApiError codes → friendly Indonesian messages; the
 * panel shows them inline. Nothing here trusts the API response shape
 * blindly — every wrapper result is narrowed before use.
 */

type ActionResult<T = undefined> = { ok: true; data?: T; message: string } | { ok: false; message: string };

/** PNG/JPEG magic-byte sniff — mirrors what qris-api/decodeQris.js will do. */
async function imageKind(file: File): Promise<"png" | "jpeg" | null> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head.length > 3 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (head.length > 2 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  return null;
}

function friendlyError(err: unknown): string {
  if (err instanceof QrisApiError) {
    switch (err.code) {
      case QRIS_API_ERRORS.NOT_CONFIGURED:
        return "QRIS_API_SECRET belum di-set di environment dashboard.";
      case QRIS_API_ERRORS.SIGNATURE_REJECTED:
        return "Tanda tangan ditolak — QRIS_API_SECRET dashboard berbeda dari server pembayaran.";
      case QRIS_API_ERRORS.TIMEOUT:
        return "Server pembayaran tidak menjawab (timeout). Coba lagi.";
      case QRIS_API_ERRORS.UNREACHABLE:
        return "Server pembayaran tidak dapat dihubungi. Periksa status layanan.";
      case "INVALID_QRIS":
      case "DECODE_FAILED":
      case "UNSUPPORTED_TYPE":
      case "IMAGE_CORRUPT":
      case "IMAGE_TOO_LARGE":
        // qr-image decode/validation failures — the server messages are
        // already written for the operator, pass them through untouched.
        return err.serverMessage ?? err.message;
      case "HTTP_400":
        // GoBiz rejects the OTP exchange with HTTP 400 (expired/wrong OTP).
        if (err.serverMessage && /expired/i.test(err.serverMessage)) {
          return "OTP sudah kedaluwarsa — kirim ulang OTP, lalu masukkan kode baru sebelum 5 menit.";
        }
        return err.serverMessage ?? err.message;
      case "NETWORK_ERROR":
        return "Koneksi ke GoBiz timeout (WAF lambat menjawab) — tunggu beberapa detik lalu coba verifikasi lagi.";
      case "MERCHANT_NOT_FOUND":
        return "Merchant belum tertaut di server pembayaran.";
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : "Terjadi kesalahan yang tidak diketahui.";
}

/** Read-only: panel data (Owner-only page; support sees the page but the
 *  page component calls this through its own non-gated path? No — simpler:
 *  the page itself requires admin, the panel data action stays Owner-gated
 *  too because the page is Owner-only.) */
export async function fetchMerchantStatusAction(): Promise<ActionResult<MerchantStatusResponse>> {
  try {
    await requireOwner();
    const data = await getMerchantStatus();
    return { ok: true, data, message: "OK" };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

// ─── OTP link flow (two steps; state lives in the client panel) ────────────

export async function startLinkAction(phone: string): Promise<ActionResult<OtpStartResponse>> {
  try {
    await requireOwner();
    const trimmed = phone.trim();
    if (!trimmed) return { ok: false, message: "Nomor telepon wajib diisi." };

    const data = await startMerchantOtp(trimmed);
    return {
      ok: true,
      data,
      // Never echo the otp_token into the UI beyond what the flow needs —
      // it is a short-lived bearer for the NEXT call only.
      message: `OTP dikirim via SMS ke ${data.phone}.`,
    };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

export async function verifyLinkAction(input: {
  phone: string;
  otp: string;
  otpToken: string;
  deviceId: string;
}): Promise<ActionResult<VerifyResponse>> {
  try {
    await requireOwner();
    if (!input.otp.trim()) return { ok: false, message: "Kode OTP wajib diisi." };

    const data = await verifyMerchantOtp({
      phone: input.phone,
      otp: input.otp.trim(),
      otpToken: input.otpToken,
      deviceId: input.deviceId,
    });

    const admin = await requireOwner();
    await writeAudit({
      action: "qris_merchant_link",
      scope: `merchant:${data.merchant_id}`,
      description: data.linked
        ? `Linked GoBiz merchant ${data.merchant_name} (${data.merchant_id}) via OTP.`
        : `Refreshed web session for ${data.merchant_id}.`,
      actorEmail: admin.email,
      metadata: { linked: data.linked, has_static_qris: data.has_static_qris },
    });

    revalidatePath("/admin/payment");
    return {
      ok: true,
      data,
      message: data.linked
        ? `${data.merchant_name} tertaut. ${data.has_static_qris ? "" : "Langkah berikutnya: unggah QRIS statis."}`
        : `Sesi ${data.merchant_name} diperbarui.`,
    };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

// ─── Static QRIS ───────────────────────────────────────────────────────────

export async function setQrisPayloadAction(
  merchantId: string,
  payload: string,
): Promise<ActionResult<MerchantView>> {
  try {
    const admin = await requireOwner();
    const cleaned = payload.trim();
    if (!cleaned) return { ok: false, message: "Payload QRIS wajib diisi." };
    if (cleaned.length > 883) {
      return { ok: false, message: "Payload terlalu panjang — pastikan Anda menempel string QRIS, bukan teks lain." };
    }

    const data = await setMerchantQrisPayload(merchantId, cleaned);

    await writeAudit({
      action: "qris_static_qr_set",
      scope: `merchant:${merchantId}`,
      description: `Static QRIS set (paste) for ${merchantId}.`,
      actorEmail: admin.email,
      metadata: { source: "paste", payload_length: cleaned.length },
    });

    revalidatePath("/admin/payment");
    return { ok: true, data, message: "QRIS statis tersimpan." };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

/**
 * QRIS upload (blueprint §4.3): forward the picked PNG/JPEG to
 * /internal/merchant/qr-image as multipart. The API decodes the QR
 * server-side (jsQR) and stores the validated payload with source 'image' —
 * the payload itself never crosses the browser, so even a huge official
 * export stays a two-click flow.
 */
export async function uploadQrisImageAction(
  merchantId: string,
  file: File,
): Promise<ActionResult<QrisImageUploadResponse>> {
  try {
    const admin = await requireOwner();
    if (!merchantId) return { ok: false, message: "Merchant tidak valid." };

    // Local pre-flight so obvious mistakes never leave the dashboard; the API
    // re-sniffs magic bytes anyway (it never trusts headers or filenames).
    const kind = await imageKind(file);
    if (!kind) return { ok: false, message: "Format tidak didukung — unggah gambar PNG atau JPEG." };
    if (file.size <= 0) return { ok: false, message: "Berkas kosong — pilih ulang gambar QRIS." };
    if (file.size > DEFAULT_QR_IMAGE_MAX_BYTES) {
      return { ok: false, message: "Gambar terlalu besar (maks 5 MB) — kompres atau ambil ulang tangkapan layar." };
    }

    const data = await setMerchantQrisImage(merchantId, new Uint8Array(await file.arrayBuffer()));

    await writeAudit({
      action: "qris_static_qr_set",
      scope: `merchant:${merchantId}`,
      description: `Static QRIS set (upload) for ${merchantId}.`,
      actorEmail: admin.email,
      metadata: { source: "image", file_size: file.size, file_type: kind },
    });

    revalidatePath("/admin/payment");
    return { ok: true, data, message: data.message ?? "QRIS statis tersimpan (dari gambar)." };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

// ─── Token refresh ─────────────────────────────────────────────────────────

export async function refreshMerchantAction(
  merchantId: string,
): Promise<ActionResult<{ rotated: boolean; refreshed_at: string }>> {
  try {
    const admin = await requireOwner();
    const data = await refreshMerchantToken(merchantId);

    await writeAudit({
      action: "qris_token_refresh",
      scope: `merchant:${merchantId}`,
      description: `Manual token refresh for ${merchantId} (${data.rotated ? "rotated" : "kept"} refresh token).`,
      actorEmail: admin.email,
    });

    revalidatePath("/admin/payment");
    return { ok: true, data, message: data.message };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}

// ─── Worker trigger (ops) ──────────────────────────────────────────────────

export async function runWorkerAction(): Promise<ActionResult<{ expired: number; polled: number; settled: number }>> {
  try {
    const admin = await requireOwner();
    const data = await runWorkerSweep();

    await writeAudit({
      action: "qris_worker_run",
      scope: "worker",
      description: `Manual sweep: expired=${data.expired} polled=${data.polled} settled=${data.settled}.`,
      actorEmail: admin.email,
    });

    return {
      ok: true,
      data: { expired: data.expired, polled: data.polled, settled: data.settled },
      message: `Sweep selesai — expired ${data.expired}, polled ${data.polled}, settled ${data.settled}.`,
    };
  } catch (err) {
    return { ok: false, message: friendlyError(err) };
  }
}
