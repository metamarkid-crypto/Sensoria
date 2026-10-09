"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Image as ImageIcon,
  ListPlus,
  Trash2,
  Save,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Target,
} from "lucide-react";
import { Card } from "@/components/ui";
import { updateAboutContentAction, type AboutPayload, type AboutFeature } from "./actions";

/**
 * AboutPanel — full editor for the "Tentang Sensoria" content.
 *
 * Everything posts through updateAboutContentAction (Owner-only) which
 * validates + upserts public.app_content and writes the audit trail. The
 * feature/mission lists are dynamic (add/remove rows) and map 1:1 with the
 * JSON the mobile About screen renders.
 */

const EMPTY: AboutPayload = {
  description: "",
  missionParagraphs: [],
  featureList: [],
  contactEmail: "",
  whatsappNumber: "",
  version: "",
  privacyPolicyUrl: "",
  heroImageUrl: "",
};

const ICON_CHOICES = ["star", "heart", "bulb", "school", "people", "chatbubbles", "mic", "game", "shield", "sparkles"];

export default function AboutPanel({
  initial,
  loadError,
}: {
  initial: AboutPayload | null;
  loadError: string | null;
}) {
  const [form, setForm] = useState<AboutPayload>(initial ?? EMPTY);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    loadError ? { ok: false, text: loadError } : null,
  );
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const set = <K extends keyof AboutPayload>(k: K, v: AboutPayload[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const setFeature = (i: number, patch: Partial<AboutFeature>) =>
    setForm((f) => ({
      ...f,
      featureList: f.featureList.map((x, idx) => (idx === i ? { ...x, ...patch } : x)),
    }));

  const addFeature = () =>
    setForm((f) => ({
      ...f,
      featureList: [...f.featureList, { icon: "star", title: "", text: "" }],
    }));

  const addMission = () =>
    setForm((f) => ({ ...f, missionParagraphs: [...f.missionParagraphs, ""] }));

  const publish = () => {
    setMessage(null);
    startTransition(async () => {
      const res = await updateAboutContentAction(form);
      setMessage({ ok: res.ok, text: res.message });
      if (res.ok) router.refresh();
    });
  };

  const CHAR_WARN = 1800;
  const descLen = form.description.length;

  return (
    <div className="space-y-6">
      {/* ── Hero image + description ─────────────────────────────────── */}
      <Card title="Poster & Deskripsi">
        <label className="block">
          <span className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <ImageIcon className="h-3.5 w-3.5" /> URL gambar poster (opsional — tampil di atas halaman)
          </span>
          <input
            type="url"
            value={form.heroImageUrl}
            onChange={(e) => set("heroImageUrl", e.target.value)}
            placeholder="https://aacsensoria.id/assets/about-banner.png"
            className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
          />
        </label>
        {form.heroImageUrl && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={form.heroImageUrl}
            alt="Pratinjau poster"
            className="mt-3 max-h-48 rounded-xl border border-ink-line object-contain"
          />
        )}

        <label className="mt-4 block">
          <span className="text-xs font-medium text-slate-400">
            Deskripsi utama ({descLen}/{CHAR_WARN} — tampil sebagai teks panjang)
          </span>
          <textarea
            rows={6}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="Sensoria AAC adalah aplikasi komunikasi augmentatif dan alternatif…"
            className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 text-sm leading-relaxed text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
          />
          {descLen > CHAR_WARN && (
            <span className="mt-1 flex items-center gap-1 text-[11px] text-amber-300">
              <AlertTriangle className="h-3 w-3" /> mendekati batas 2000 karakter
            </span>
          )}
        </label>
      </Card>

      {/* ── Mission paragraphs ────────────────────────────────────────── */}
      <Card title="Misi (paragraf)">
        <div className="space-y-3">
          {form.missionParagraphs.map((p, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-2.5 text-xs font-mono text-slate-500">{i + 1}.</span>
              <textarea
                rows={2}
                value={p}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    missionParagraphs: f.missionParagraphs.map((x, idx) => (idx === i ? e.target.value : x)),
                  }))
                }
                placeholder="Paragraf misi…"
                className="flex-1 rounded-lg border border-ink-line bg-ink-soft px-3 py-2 text-sm leading-relaxed text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
              />
              <button
                type="button"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    missionParagraphs: f.missionParagraphs.filter((_, idx) => idx !== i),
                  }))
                }
                className="mt-1 rounded-md bg-red-500/10 p-2 text-red-300 transition hover:bg-red-500/20"
                aria-label="Hapus paragraf"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addMission}
            disabled={form.missionParagraphs.length >= 6}
            className="inline-flex items-center gap-2 rounded-lg border border-ink-line px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
          >
            <Target className="h-3.5 w-3.5" /> Tambah paragraf misi ({form.missionParagraphs.length}/6)
          </button>
        </div>
      </Card>

      {/* ── Feature list ─────────────────────────────────────────────── */}
      <Card title="Fitur unggulan">
        <div className="space-y-4">
          {form.featureList.map((f, i) => (
            <div key={i} className="rounded-xl border border-ink-line p-3">
              <div className="flex items-center gap-2">
                <select
                  value={f.icon}
                  onChange={(e) => setFeature(i, { icon: e.target.value })}
                  className="rounded-lg border border-ink-line bg-ink-soft px-2 py-1.5 text-xs text-slate-200 focus:border-teal focus:outline-none"
                >
                  {ICON_CHOICES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <input
                  value={f.title}
                  onChange={(e) => setFeature(i, { title: e.target.value })}
                  placeholder="Judul fitur"
                  className="flex-1 rounded-lg border border-ink-line bg-ink-soft px-3 py-1.5 text-sm font-semibold text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() =>
                    setForm((f0) => ({
                      ...f0,
                      featureList: f0.featureList.filter((_, idx) => idx !== i),
                    }))
                  }
                  className="rounded-md bg-red-500/10 p-1.5 text-red-300 transition hover:bg-red-500/20"
                  aria-label="Hapus fitur"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <textarea
                rows={2}
                value={f.text}
                onChange={(e) => setFeature(i, { text: e.target.value })}
                placeholder="Deskripsi singkat fitur…"
                className="mt-2 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
              />
            </div>
          ))}
          <button
            type="button"
            onClick={addFeature}
            disabled={form.featureList.length >= 8}
            className="inline-flex items-center gap-2 rounded-lg border border-ink-line px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/5 disabled:opacity-40"
          >
            <ListPlus className="h-3.5 w-3.5" /> Tambah fitur ({form.featureList.length}/8)
          </button>
        </div>
      </Card>

      {/* ── Contact & meta ──────────────────────────────────────────── */}
      <Card title="Kontak & Metadata">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-slate-400">Email kontak</span>
            <input
              type="email"
              value={form.contactEmail}
              onChange={(e) => set("contactEmail", e.target.value)}
              placeholder="support@aacsensoria.id"
              className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-400">WhatsApp (opsional, digit saja)</span>
            <input
              value={form.whatsappNumber}
              onChange={(e) => set("whatsappNumber", e.target.value)}
              placeholder="6281234567890"
              className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-400">Label versi</span>
            <input
              value={form.version}
              onChange={(e) => set("version", e.target.value)}
              placeholder="v1.0.10"
              className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-400">URL Kebijakan Privasi</span>
            <input
              type="url"
              value={form.privacyPolicyUrl}
              onChange={(e) => set("privacyPolicyUrl", e.target.value)}
              placeholder="https://aacsensoria.id/privacy"
              className="mt-1 w-full rounded-lg border border-ink-line bg-ink-soft px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus:border-teal focus:outline-none"
            />
          </label>
        </div>
      </Card>

      {/* ── Publish ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <Sparkles className="h-3.5 w-3.5" /> Tersimpan ke public.app_content
          (about_sensoria) — aplikasi memuatnya saat layar dibuka & via realtime.
        </p>
        <button
          onClick={publish}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-ink-strong transition hover:bg-teal-deep disabled:opacity-50"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {pending ? "Menyimpan…" : "Terbitkan"}
        </button>
      </div>

      {message && (
        <div
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
            message.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-red-500/30 bg-red-500/10 text-red-300"
          }`}
        >
          {message.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
}
