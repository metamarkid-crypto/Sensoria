import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

/**
 * Two strictly separated Supabase clients:
 *
 *  • createAdminAuthClient — cookie-bound USER context (Supabase Auth).
 *    Only ever used to read the session and its email; RLS applies.
 *
 *  • createServiceClient  — SERVICE ROLE, bypasses RLS. Reserved STRICTLY
 *    for server-side code that has already verified the caller is an
 *    authenticated admin (see requireAdmin() in lib/auth.ts). Never import
 *    this from a client component; the key lives only in server env vars.
 */

export async function createAdminAuthClient() {
  // Next.js 15: request APIs are asynchronous.
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components cannot set cookies — the middleware refresh
            // handles it; safe to ignore here.
          }
        },
      },
    },
  );
}

export function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
