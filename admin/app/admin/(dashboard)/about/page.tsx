import AboutPanel from "./AboutPanel";
import { requireOwner } from "@/lib/auth";
import { getAboutContentAction } from "./actions";

export const metadata = {
  title: "Tentang Sensoria — Sensoria Admin",
};

/**
 * /admin/about — edit the "Tentang Sensoria" screen content that ships to
 * every installed app through public.app_content (id='about_sensoria').
 *
 * Owner-only: requireOwner() throws for Support and the dashboard error
 * boundary renders the standard gate. The initial payload loads server-side
 * through the same action the panel uses to refresh (single source of truth).
 */
export default async function AboutPage() {
  const admin = await requireOwner();

  const loaded = await getAboutContentAction();
  const initial = loaded.data ?? null;
  const loadError = loaded.ok ? null : loaded.message;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-50">Tentang Sensoria</h1>
        <p className="mt-1 text-sm text-slate-400">
          Konten halaman “Tentang” di aplikasi: deskripsi, misi, fitur unggulan,
          poster, dan kontak. Owner: {admin.email}
          {initial && (
            <span className="ml-2 text-slate-500">
              · terakhir diubah {initial.version ? `(${initial.version})` : ""}
            </span>
          )}
        </p>
      </header>

      <AboutPanel initial={initial} loadError={loadError} />
    </div>
  );
}
