import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { legacyPaidPortalToPortal } from "@/lib/legacy-portal-redirect";
import { isStaleRefreshTokenError } from "@/lib/supabase/safe-browser-session";

const PROTECTED_PREFIXES = ["/portal", "/pro", "/manager", "/owner", "/resident", "/admin", "/vendor"];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/demo" || path.startsWith("/demo/")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }
  if (path === "/dashboard" || path === "/dashboard/") {
    const url = request.nextUrl.clone();
    url.pathname = "/auth/continue";
    return NextResponse.redirect(url);
  }
  if (path === "/portal/resident" || path === "/portal/resident/") {
    const url = request.nextUrl.clone();
    url.pathname = "/resident";
    return NextResponse.redirect(url);
  }

  const canonical = legacyPaidPortalToPortal(path);
  if (canonical && canonical !== path) {
    const url = request.nextUrl.clone();
    url.pathname = canonical;
    return NextResponse.redirect(url);
  }

  // `x-pathname` must travel on the REQUEST, because that is where a server
  // component's `headers()` reads it (a header set on the response is never
  // visible to the render). Setting it only on the response had two effects,
  // and the harmless-looking one hid the other:
  //
  //   1. `src/app/resident/layout.tsx` read whatever the CALLER sent, and feeds
  //      it to `allowSignedInApplyGate` — which `assertPortalLayoutRole` treats
  //      as a full role-check bypass for any signed-in user.
  //   2. On a normal request the header was absent, so the resident apply and
  //      tour gates never opened for legitimate residents either.
  //
  // The inbound value is deleted first so a caller can never supply their own.
  // Rebuilt on every call rather than captured once: the Supabase `setAll`
  // below mutates `request.cookies` and relies on the forwarded request picking
  // the refreshed values up, so a stale header snapshot would drop a refreshed
  // session cookie.
  const forwarded = () => {
    const headers = new Headers(request.headers);
    headers.delete("x-pathname");
    headers.set("x-pathname", path);
    return { request: { headers } };
  };

  let supabaseResponse = NextResponse.next(forwarded());

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    const response = NextResponse.next(forwarded());
    response.headers.set("x-pathname", path);
    return response;
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Write refreshed cookies back to request so subsequent getAll() calls see them.
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next(forwarded());
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options));
      },
    },
  });

  // Validate the session server-side so corrupt refresh cookies are cleared before portal routes run.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError && isStaleRefreshTokenError(userError)) {
    await supabase.auth.signOut();
  }

  const needsAuth = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

  if (needsAuth && !user) {
    const redirectUrl = new URL("/auth/sign-in", request.url);
    redirectUrl.searchParams.set("next", path);
    return NextResponse.redirect(redirectUrl);
  }

  supabaseResponse.headers.set("x-pathname", path);
  return supabaseResponse;
}

export const config = {
  matcher: [
    "/demo",
    "/demo/:path*",
    "/dashboard",
    "/dashboard/",
    "/portal/:path*",
    "/pro/:path*",
    "/manager/:path*",
    "/owner/:path*",
    "/resident/:path*",
    "/admin/:path*",
    "/vendor/:path*",
  ],
};
