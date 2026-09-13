import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Auth middleware for /admin:
 *  • refreshes the Supabase session cookie on every navigation,
 *  • sends anonymous visitors to /admin/login,
 *  • allowlist verification itself happens server-side (lib/auth.ts) —
 *    the middleware only enforces "has a session", the DB decides "is admin".
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isLogin = pathname === "/admin/login";

  if (!user && !isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    return NextResponse.redirect(url);
  }

  if (user && isLogin) {
    // An explicit error/denied/mfa flag means lib/auth.ts just bounced the
    // user HERE on purpose (not allowlisted, MFA required, …). Render the
    // message — bouncing back to /admin would bounce here again and loop
    // forever (ERR_TOO_MANY_REDIRECTS).
    const sp = request.nextUrl.searchParams;
    const bouncedOnPurpose = sp.has("denied") || sp.has("error") || sp.has("mfa");
    if (!bouncedOnPurpose) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin";
      url.search = "";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*"],
};
