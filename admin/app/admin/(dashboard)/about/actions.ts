"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getAdminOrNull, OwnerRequiredError } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";

/**
 * /admin/about — "Tentang Sensoria" content management (public.app_content,
 * row id = 'about_sensoria'). Owner-only server actions; every mutation is
 * audited (about_content_update) and validated BEFORE it hits Supabase.
 *
 * content_json shape mirrors the mobile AboutContent contract (see
 * src/store/useAACStore.ts AboutContent + the extended rich fields the
 * About screen renders):
 *   description        : long text (up to 2000 chars)
 *   heroImageUrl?      : banner image shown at the top of the About screen
 *   missionParagraphs? : string[] — render as paragraph blocks (max 6)
 *   featureList?       : { icon: string; title: string; text: string }[] (max 8)
 *   contactEmail       : email
 *   whatsappNumber?    : international format, digits only
 *   version, privacyPolicyUrl
 */

const ABOUT_ROW_ID = "about_sensoria";
const MAX_DESCRIPTION = 2000;

export interface AboutFeature {
  icon: string;
  title: string;
  text: string;
}

export interface AboutPayload {
  description: string;
  missionParagraphs: string[];
  featureList: AboutFeature[];
  contactEmail: string;
  whatsappNumber: string;
  version: string;
  privacyPolicyUrl: string;
  heroImageUrl: string;
}

function cleanString(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function normalizeUrl(v: string): string {
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

export async function getAboutContentAction(): Promise<{ ok: boolean; data?: AboutPayload; message: string }> {
  try {
    const admin = await getAdminOrNull();
    if (!admin) return { ok: false, message: "Unauthorized" };
    const db = createServiceClient();
    const { data, error } = await db
      .from("app_content")
      .select("content_json")
      .eq("id", ABOUT_ROW_ID)
      .single();
    if (error) return { ok: false, message: `Gagal memuat konten: ${error.message}` };
    const j = (data?.content_json ?? {}) as Record<string, unknown>;
    const payload: AboutPayload = {
      description: cleanString(j.description, MAX_DESCRIPTION),
      missionParagraphs: Array.isArray(j.missionParagraphs)
        ? (j.missionParagraphs as unknown[]).slice(0, 6).map((p) => cleanString(p, 800))
        : [],
      featureList: Array.isArray(j.featureList)
        ? (j.featureList as unknown[]).slice(0, 8).map((f) => {
            const o = (f ?? {}) as Record<string, unknown>;
            return {
              icon: cleanString(o.icon, 40),
              title: cleanString(o.title, 80),
              text: cleanString(o.text, 400),
            };
          })
        : [],
      contactEmail: cleanString(j.contactEmail, 120),
      whatsappNumber: cleanString(j.whatsappNumber, 20),
      version: cleanString(j.version, 40),
      privacyPolicyUrl: cleanString(j.privacyPolicyUrl, 300),
      heroImageUrl: cleanString(j.heroImageUrl, 600),
    };
    return { ok: true, data: payload, message: "Konten dimuat." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Terjadi kesalahan." };
  }
}

function validate(input: AboutPayload): string | null {
  if (!input.description || input.description.length < 20) {
    return "Deskripsi minimal 20 karakter.";
  }
  if (input.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.contactEmail)) {
    return "Email kontak tidak valid.";
  }
  if (input.whatsappNumber && !/^\d{8,15}$/.test(input.whatsappNumber.replace(/[+\-\s]/g, ""))) {
    return "Nomor WhatsApp hanya angka (8–15 digit), boleh diawali +.";
  }
  if (input.heroImageUrl && !/^https?:\/\/.+/i.test(input.heroImageUrl)) {
    return "URL gambar poster harus http(s)://…";
  }
  for (const f of input.featureList) {
    if (!f.title) return "Setiap fitur butuh judul.";
    if (!f.text) return `Fitur "${f.title}" butuh deskripsi singkat.`;
  }
  if (input.missionParagraphs.some((p) => p.length < 10)) {
    return "Setiap paragraf misi minimal 10 karakter.";
  }
  return null;
}

export async function updateAboutContentAction(
  input: AboutPayload,
): Promise<{ ok: boolean; message: string }> {
  const admin = await getAdminOrNull();
  if (!admin) return { ok: false, message: "Unauthorized" };
  if (admin.role !== "owner") throw new OwnerRequiredError();

  const validation = validate(input);
  if (validation) return { ok: false, message: validation };

  const db = createServiceClient();
  const content_json = {
    // Fields the OLD About screen already reads (backward compatible):
    description: input.description,
    contactEmail: input.contactEmail,
    version: input.version,
    privacyPolicyUrl: input.privacyPolicyUrl,
    // Rich/new fields — silently ignored by older app builds:
    heroImageUrl: normalizeUrl(input.heroImageUrl),
    missionParagraphs: input.missionParagraphs.filter(Boolean),
    featureList: input.featureList
      .filter((f) => f.title && f.text)
      .map((f) => ({ icon: f.icon, title: f.title, text: f.text })),
    whatsappNumber: input.whatsappNumber.replace(/[+\-\s]/g, ""),
    updatedBy: admin.email,
    updatedAt: new Date().toISOString(),
  };

  const { error } = await db
    .from("app_content")
    .upsert({ id: ABOUT_ROW_ID, content_json, updated_at: new Date().toISOString() });

  if (error) return { ok: false, message: `Gagal menyimpan: ${error.message}` };

  await writeAudit({
    action: "about_content_update",
    scope: "app_content:about_sensoria",
    description: `"Tentang Sensoria" diperbarui: ${input.description.length} char deskripsi, ${input.featureList.length} fitur, ${input.missionParagraphs.length} paragraf misi.`,
    actorEmail: admin.email,
    metadata: {
      feature_count: input.featureList.length,
      mission_count: input.missionParagraphs.length,
      hero_image: Boolean(content_json.heroImageUrl),
    },
  });
  revalidatePath("/admin/about");
  return { ok: true, message: "Konten diterbitkan — aplikasi memuat versi terbaru saat dibuka / di-pull-refresh." };
}
