import { isManagerPurchaseReadError } from "@/lib/auth/manager-onboarding";
import { ManagerEntitlementUnavailable } from "@/lib/auth/legacy-manager-entitlement.server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestAuthUser } from "@/lib/auth/request-auth-user";
import { normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";
import { LAST_PORTAL_COOKIE } from "@/lib/auth/last-portal";
import { applyPortalCookies, resolvePostSignInDestination } from "@/lib/auth/post-sign-in-destination.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { readOAuthIntentFromRequest, readOAuthSurfaceFromRequest } from "@/lib/auth/oauth-next-cookie";

export const runtime = "nodejs";

/** Resolve where an OAuth user may go after sign-in (portal vs pricing vs finish signup). */
export async function GET(req: NextRequest) {
  try {
    const supabaseAuth = await createSupabaseServerClient();
    const user = await getRequestAuthUser(supabaseAuth, req);

    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const url = new URL(req.url);
    const rawNext = url.searchParams.get("next")?.trim() ?? "/auth/continue";
    const intendedPath = normalizePostAuthPath(rawNext.startsWith("/") ? rawNext : "/auth/continue");

    const destination = await resolvePostSignInDestination({
      service: createSupabaseServiceRoleClient(),
      user,
      intendedPath,
      intent: readOAuthIntentFromRequest(req),
      surface: readOAuthSurfaceFromRequest(req),
      lastPortalRole: req.cookies.get(LAST_PORTAL_COOKIE)?.value,
    });

    const res = NextResponse.json({ redirectTo: destination.redirectTo }, { headers: { "Cache-Control": "private, no-store" } });
    applyPortalCookies(res, destination, process.env.NODE_ENV === "production");
    return res;
  } catch (e) {
    if (e instanceof ManagerEntitlementUnavailable || isManagerPurchaseReadError(e)) return NextResponse.json({ error: "Account access is temporarily unavailable. Please try again." }, { status: 503 });
    return NextResponse.json({ error: "Could not resolve account access." }, { status: 500 });
  }
}
