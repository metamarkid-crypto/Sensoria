"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Link2,
  QrCode,
  RefreshCw,
  PlayCircle,
  ShieldAlert,
  ShieldCheck,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Copy,
  Upload,
  Paperclip,
} from "lucide-react";
import { Card } from "@/components/ui";
import {
  fetchMerchantStatusAction,
  startLinkAction,
  verifyLinkAction,
  setQrisPayloadAction,
  uploadQrisImageAction,
  refreshMerchantAction,
  runWorkerAction,
} from "./actions";
import type { MerchantView } from "@/lib/qrisApi";

/**
 * PaymentGatewayPanel — QRIS provisioning UI (blueprint §6 step 5).
 *
 * Flow state (otp_token / device_id of an in-flight link) lives HERE in the
 * client for the two-step OTP handshake; the server actions are stateless.
 * All mutations are Owner-only server actions — this component just renders
 * their results.
 */

type LinkStep = "phone" | "otp";

const STATUS_STYLES: Record<MerchantView["status"], { badge: string; label: string }> = {
  active: { badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", label: "Aktif" },
  token_expired: { badge: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "Token Kedaluwarsa" },
  disabled: { badge: "bg-slate-500/15 text-slate-400 border-slate-500/30", label: "Nonaktif" },
};

export default function PaymentGatewayPanel({
  initialMerchants,
  loadError,
}: {
  initialMerchants: MerchantView[];
  loadError: string | null;
}) {
  const router = useRouter();
  const [merchants, setMerchants] = useState(initialMerchants);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(loadError ? { ok: false, text: loadError } : null);
  const [pending, startTransition] = useTransition();

  // ── Link flow state ──
  const [linkStep, setLinkStep] = useState<LinkStep>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpToken, setOtpToken] = useState("");
  const [deviceId, setDeviceId] = useState("");

  // ── QRIS paste state ──
  const [qrMerchantId, setQrMerchantId] = useState<string | null>(null);
  const [qrPayload, setQrPayload] = useState("");
  // ── QRIS image-upload state (mirrors the paste flow) ──
  const [qrFile, setQrFile] = useState<File | null>(null);
  const [uploading, startUploading] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; message: string; data?: unknown }>, after?: () => void) {
    setMessage(null);
    startTransition(async () => {
      const res = await fn();
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) {
        after?.();
        router.refresh(); // server-rendered merchant list is refetched
      }
    });
  }

  /** File picker → multipart upload via uploadQrisImageAction. Runs in its
   *  own transition so the upload spinner is independent of other buttons. */
  const uploadQris = (merchantId: string) => {
    if (!qrFile) return;
    setMessage(null);
    startUploading(async () => {
      const res = await uploadQrisImageAction(merchantId, qrFile);
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) {
        setQrFile(null);
        setQrMerchantId(null);
        router.refresh();
      }
    });
  };

  const startOtp = () =>
    run(async () => {
      const res = await startLinkAction(phone);
      if (res.ok && res.data) {
        setOtpToken(res.data.otp_token);
        setDeviceId(res.data.device_id);
        setLinkStep("otp");
      }
      return { ok: res.ok, message: res.message };
    });

  const verifyOtp = () =>
    run(
      async () => {
        const res = await verifyLinkAction({ phone, otp, otpToken, deviceId });
        if (res.ok) {
          setLinkStep("phone");
          setOtp("");
          setOtpToken("");
          setDeviceId("");
        }
        return { ok: res.ok, message: res.message };
      },
    );

  const pasteQris = (merchantId: string) =>
    run(async () => {
      const res = await setQrisPayloadAction(merchantId, qrPayload);
      if (res.ok) {
        setQrPayload("");
        setQrMerchantId(null);
      }
      return { ok: res.ok, message: res.message };
    });

  const summary = {
    total: merchants.length,
    ready: merchants.filter((m) => m.ready).length,
    tokenExpired: merchants.filter((m) => m.status === "token_expired").length,
  };

  return (
    <div className="space-y-6">
      {message ? (
        <div
          className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${
            message.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/10 text-rose-200"
          }`}
        >
          {message.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
          {message.text}
        </div>
      ) : null}

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Merchant</p>
          <p className="mt-1 text-2xl font-bold text-slate-50">{summary.total}</p>
        </Card>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Siap menerima</p>
          <p className="mt-1 text-2xl font-bold text-emerald-300">{summary.ready}</p>
        </Card>
        <Card>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Perlu link ulang</p>
          <p className={`mt-1 text-2xl font-bold ${summary.tokenExpired > 0 ? "text-amber-300" : "text-slate-50"}`}>
            {summary.tokenExpired}
          </p>
        </Card>
      </div>

      {/* Merchant list */}
      <Card title="Akun Merchant GoBiz" action={
        <button
          onClick={() => run(() => runWorkerAction())}
          disabled={pending}
          className="inline-flex items-center gap-1.5 rounded-lg border border-teal/40 bg-teal-soft/40 px-3 py-1.5 text-xs font-semibold text-teal transition hover:bg-teal-soft/70 disabled:opacity-50"
        >
          {pending ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
          Jalankan Sweep
        </button>
      }>
        {merchants.length === 0 ? (
          <p className="rounded-xl border border-dashed border-ink-line px-6 py-8 text-center text-sm text-slate-500">
            Belum ada merchant tertaut. Tautkan akun GoBiz di bawah.
          </p>
        ) : (
          <div className="space-y-3">
            {merchants.map((m) => {
              const st = STATUS_STYLES[m.status];
              return (
                <div key={m.merchant_id} className="rounded-xl border border-ink-line bg-ink-soft/40 p-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${st.badge}`}>
                      {st.label}
                    </span>
                    <span className="font-bold text-slate-100">{m.merchant_name}</span>
                    <span className="text-xs text-slate-500">{m.merchant_id}</span>
                    {m.phone ? <span className="text-xs text-slate-500">· {m.phone}</span> : null}
                    <span className="ml-auto flex items-center gap-2 text-xs text-slate-400">
                      {m.ready ? (
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <ShieldCheck size={13} /> Siap
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-300">
                          <ShieldAlert size={13} /> Belum siap
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={12} />
                      Token: {m.token_age_hours === null ? "—" : `${m.token_age_hours} jam lalu`}
                    </span>
                    <span>
                      QRIS: {m.has_static_qris ? `ada (${m.static_qris_source === "image" ? "gambar" : "tempel"})` : "belum ada"}
                    </span>
                    <span>Last sync: {m.last_sync ? new Date(m.last_sync).toLocaleString("id-ID") : "—"}</span>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => run(() => refreshMerchantAction(m.merchant_id))}
                      disabled={pending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-line px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
                    >
                      <RefreshCw size={12} /> Refresh token
                    </button>
                    <button
                      onClick={() => { setQrMerchantId(qrMerchantId === m.merchant_id ? null : m.merchant_id); setQrPayload(""); setQrFile(null); }}
                      disabled={pending || uploading}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-ink-line px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
                    >
                      <QrCode size={12} /> {m.has_static_qris ? "Ganti QRIS" : "Set QRIS"}
                    </button>
                  </div>

                  {qrMerchantId === m.merchant_id ? (
                    <div className="mt-3 space-y-2">
                      <textarea
                        value={qrPayload}
                        onChange={(e) => setQrPayload(e.target.value)}
                        rows={3}
                        placeholder="Tempel payload QRIS STATIS di sini (string EMV yang diawali 0002…). Upload gambar QRIS resmi via endpoint /internal/merchant/qr-image."
                        className="w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:border-teal/50 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => pasteQris(m.merchant_id)}
                          disabled={pending || uploading || !qrPayload.trim()}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-xs font-bold text-ink transition hover:opacity-90 disabled:opacity-50"
                        >
                          <Copy size={12} /> Simpan payload
                        </button>
                        <button
                          onClick={() => { setQrMerchantId(null); setQrPayload(""); setQrFile(null); }}
                          className="rounded-lg border border-ink-line px-3 py-1.5 text-xs font-semibold text-slate-400 transition hover:bg-white/5"
                        >
                          Batal
                        </button>
                      </div>

                      {/* Image upload — the "official QRIS image" path: the
                          payload is decoded server-side from the PNG/JPEG. */}
                      <div className="border-t border-dashed border-ink-line pt-2">
                        <p className="text-[11px] text-slate-500">
                          atau unggah gambar QRIS resmi (PNG/JPEG, maks 5 MB) — payload dibaca server dari gambar:
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <label
                            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-ink-line px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/5 ${
                              pending || uploading ? "pointer-events-none opacity-50" : ""
                            }`}
                          >
                            <Paperclip size={12} />
                            {qrFile ? "Ganti berkas" : "Pilih berkas"}
                            <input
                              type="file"
                              accept="image/png,image/jpeg"
                              className="hidden"
                              onChange={(e) => {
                                setQrFile(e.target.files?.[0] ?? null);
                                e.target.value = ""; // re-picking the same file re-fires onChange
                              }}
                            />
                          </label>
                          {qrFile ? (
                            <span className="inline-flex max-w-full items-center gap-1 truncate rounded-lg bg-ink-soft px-2.5 py-1 text-[11px] text-slate-400">
                              <Paperclip size={11} /> {qrFile.name} · {Math.ceil(qrFile.size / 1024)} KB
                            </span>
                          ) : null}
                          <button
                            onClick={() => uploadQris(m.merchant_id)}
                            disabled={pending || uploading || !qrFile}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-xs font-bold text-ink transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                            {uploading ? "Mengunggah…" : "Unggah gambar"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Link flow */}
      <Card title="Taut Akun GoBiz (OTP)">
        {linkStep === "phone" ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              Masukkan nomor HP terdaftar Gojek/GoBiz (format 08… / +62…). OTP dikirim via SMS; device
              sesi dibuat otomatis dan dipakai permanen untuk refresh token.
            </p>
            <div className="flex gap-2">
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0812 3456 7890"
                inputMode="tel"
                className="flex-1 rounded-lg border border-ink-line bg-ink-soft px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-teal/50 focus:outline-none"
              />
              <button
                onClick={startOtp}
                disabled={pending || !phone.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-teal px-4 py-2 text-sm font-bold text-ink transition hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />}
                Kirim OTP
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-slate-400">
              OTP dikirim ke <span className="font-semibold text-slate-200">{phone}</span>. Sesi sementara
              tersimpan di panel ini — jangan tutup halaman sebelum verifikasi.
            </p>
            <div className="flex gap-2">
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder="Kode OTP (6 digit)"
                inputMode="numeric"
                maxLength={8}
                className="flex-1 rounded-lg border border-ink-line bg-ink-soft px-3 py-2 font-mono text-sm tracking-widest text-slate-200 placeholder:text-slate-600 focus:border-teal/50 focus:outline-none"
              />
              <button
                onClick={verifyOtp}
                disabled={pending || !otp.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-teal px-4 py-2 text-sm font-bold text-ink transition hover:opacity-90 disabled:opacity-50"
              >
                {pending ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                Verifikasi
              </button>
              <button
                onClick={() => { setLinkStep("phone"); setOtp(""); }}
                className="rounded-lg border border-ink-line px-3 py-2 text-xs font-semibold text-slate-400 transition hover:bg-white/5"
              >
                Batal
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
