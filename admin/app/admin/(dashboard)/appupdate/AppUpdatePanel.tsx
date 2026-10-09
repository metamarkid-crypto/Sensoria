"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CloudUpload, Rocket, AlertTriangle, CheckCircle2, Loader2, Info } from "lucide-react";
import { Card } from "@/components/ui";
import { publishAppUpdateAction } from "./actions";
import type { AppUpdateConfig } from "@/lib/qrisApi";

/**
 * AppUpdatePanel — publish an Android release (config bump + optional APK).
 *
 * The form posts through publishAppUpdateAction (Owner-only server action):
 * config-only when no APK is attached, APK upload (+ metadata patch) when it
 * is. The current published config is shown read-only above the form.
 */

export default function AppUpdatePanel({
  initialConfig,
  loadError,
}: {
  initialConfig: AppUpdateConfig | null;
  loadError: string | null;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    loadError ? { ok: false, text: loadError } : null,
  );
  const [pending, startTransition] = useTransition();

  const [versionCode, setVersionCode] = useState("");
  const [versionName, setVersionName] = useState("");
  const [notes, setNotes] = useState("");
  const [mandatory, setMandatory] = useState(false);
  const [apk, setApk] = useState<File | null>(null);

  const publish = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await publishAppUpdateAction({ versionCode, versionName, notes, mandatory, apk });
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) {
        setVersionCode("");
        setVersionName("");
        setNotes("");
        setMandatory(false);
        setApk(null);
        router.refresh();
      }
    });
  };

  const cfg = initialConfig;
  const apduReady = Boolean(cfg?.apk_file);

  return (
    <div className="space-y-6">
      {/* Current published state */}
      <Card title="Rilis Aktif">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-100">Rilis Aktif</h2>
        </div>
        {cfg ? (
          <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">Version code</dt>
              <dd className="font-mono text-slate-100">{cfg.latest_version_code || "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Version name</dt>
              <dd className="font-mono text-slate-100">{cfg.latest_version_name || "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">File APK</dt>
              <dd className="font-mono text-slate-100">
                {cfg.apk_file || "belum ada"}
                {!apduReady && cfg.latest_version_code > 0 && (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
                    <AlertTriangle className="h-3 w-3" /> upload APK belum dilakukan
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Wajib (mandatory)</dt>
              <dd className="text-slate-100">{cfg.mandatory ? "Ya" : "Tidak"}</dd>
            </div>
            {cfg.release_notes && (
              <div className="sm:col-span-2">
                <dt className="text-slate-500">Catatan rilis</dt>
                <dd className="whitespace-pre-wrap text-slate-100">{cfg.release_notes}</dd>
              </div>
            )}
            {cfg.updated_at && (
              <div className="sm:col-span-2">
                <dt className="text-slate-500">Terakhir diubah</dt>
                <dd className="text-slate-400">{new Date(cfg.updated_at).toLocaleString("id-ID")}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-slate-400">{loadError || "Belum ada rilis yang dipublikasikan."}</p>
        )}
      </Card>

      {/* Publish form */}
      <Card title="Publikasikan Rilis Baru">
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-teal" />
          <h2 className="text-sm font-semibold text-slate-100">Publikasikan Rilis Baru</h2>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Lampirkan file .apk untuk mengunggahnya ke VPS; atau isi kolom saja
          untuk mengubah catatan/wajib dari rilis yang ada.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-slate-400">Version code</span>
            <input
              type="number"
              min={0}
              value={versionCode}
              onChange={(e) => setVersionCode(e.target.value)}
              placeholder="10"
              className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-400">Version name</span>
            <input
              type="text"
              value={versionName}
              onChange={(e) => setVersionName(e.target.value)}
              placeholder="1.0.10"
              className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-slate-400">Catatan rilis (tampil di aplikasi)</span>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Perbaikan bug dan peningkatan stabilitas."
              className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-slate-400">File APK (opsional, maks 100 MB)</span>
            <input
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              onChange={(e) => setApk(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full cursor-pointer rounded-lg border border-dashed border-ink-line bg-ink-soft px-3 py-2 text-sm text-slate-300 file:mr-3 file:rounded-md file:border-0 file:bg-teal-soft file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-teal hover:border-teal"
            />
            {apk && <span className="mt-1 block text-xs text-slate-500">{apk.name} — {(apk.size / 1024 / 1024).toFixed(1)} MB</span>}
          </label>
          <label className="flex items-center gap-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={mandatory}
              onChange={(e) => setMandatory(e.target.checked)}
              className="h-4 w-4 rounded border-ink-line accent-teal"
            />
            <span className="text-xs text-slate-300">
              Wajib update — aplikasi lama tidak bisa dipakai sampai selesai update
            </span>
          </label>
        </div>

        <button
          onClick={publish}
          disabled={pending}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-ink-strong transition hover:bg-teal-strong disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CloudUpload className="h-4 w-4" />}
          {pending ? "Mengunggah…" : "Publikasikan"}
        </button>

        {message && (
          <div
            className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
              message.ok
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-red-500/30 bg-red-500/10 text-red-300"
            }`}
          >
            {message.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{message.text}</span>
          </div>
        )}
      </Card>
    </div>
  );
}
