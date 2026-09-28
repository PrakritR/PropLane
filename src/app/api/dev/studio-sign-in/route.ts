import { NextResponse } from "next/server";
import { ACTIVE_PORTAL_COOKIE } from "@/lib/auth/portal-access";
import { safeNextPath } from "@/lib/auth/safe-next-path";
import { isStudioSignInRole, studioAccountFor, studioSignInAllowed } from "@/lib/dev/studio-sign-in.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Dev-only: GET /api/dev/studio-sign-in?as=<manager|resident|vendor|admin>&next=<path>
 *
 * Signs the browser in as that role's shared dev test account (real Supabase
 * auth cookies via @supabase/ssr, same as a normal password sign-in) and
 * redirects to `next`. Used by the PropLane mock-kit studio's Live mode
 * (docs/agents/studio-live.md) to frame the real app already authenticated,
 * instead of an iframed sign-in screen that cross-site cookies can't complete.
 *
 * Refuses with a bare 404 (see studio-sign-in.server.ts for the three
 * required conditions) rather than any error body — this must not be a
 * discoverable surface outside local development.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const host = req.headers.get("host");
  if (!studioSignInAllowed(host)) {
    return new NextResponse(null, { status: 404 });
  }

  const role = url.searchParams.get("as");
  if (!isStudioSignInRole(role)) {
    return NextResponse.json({ error: "as must be one of manager, resident, vendor, admin." }, { status: 400 });
  }

  // Same-origin only — never follow an attacker- or misconfigured-caller-chosen
  // absolute/protocol-relative destination (open-redirect guard shared with the
  // rest of auth: src/lib/auth/safe-next-path.ts).
  const next = safeNextPath(url.searchParams.get("next")) ?? "/";

  const account = studioAccountFor(role);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (error) {
    return NextResponse.json({ error: `Could not sign in as ${role}: ${error.message}` }, { status: 500 });
  }

  // Redirect back to the SAME host the caller used (localhost vs. 127.0.0.1 — both allowed by
  // the guard above), not `url.origin`: `next dev --hostname 0.0.0.0` can report an origin whose
  // host is the bind address (0.0.0.0) rather than what the browser actually requested, and
  // studio-live's whole point is landing back on the exact host/port the iframe is same-site
  // with (docs/agents/studio-live.md).
  const res = NextResponse.redirect(`${url.protocol}//${host}${next}`);
  // The `manager` role signs in as the all-portals testeverything@ sandbox account (see
  // studioAccountFor), which otherwise lands on /auth/choose-portal — a manual "which portal?"
  // click the app shows any multi-role account, requiring a real user's affirmative choice.
  // Since this route only ever signs in as a fixed, known dev fixture (never captain-authored
  // input), pre-selecting the role it was asked for is safe and is exactly what clicking that
  // picker does (src/app/api/auth/set-active-portal/route.ts): same cookie, same value. This is
  // what makes Live mode land straight on `next` instead of stalling on that picker inside the
  // iframe.
  res.cookies.set(ACTIVE_PORTAL_COOKIE, role, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: false,
  });
  return res;
}
