import { recoverySetupRedirect } from "@/lib/auth/account-recovery.server";
import { NextRequest, NextResponse } from "next/server";
import { getRequestAuthUser } from "@/lib/auth/request-auth-user";
import { normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";
import { reconcileAuthAccountsByEmail } from "@/lib/auth/reconcile-auth-accounts-by-email";
import { finalizeOAuthPortalRedirect } from "@/lib/auth/resolve-oauth-portal-access";
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

    const service = createSupabaseServiceRoleClient();
    const recovery = await recoverySetupRedirect(service, user.id);
    if (recovery) return NextResponse.json({ redirectTo: recovery }, { headers: { "Cache-Control": "private, no-store" } });
    // Password sign-in reaches this resolver without an OAuth callback, so keep
    // email/password and OAuth portal rows merged before choosing a destination.
    try {
      await reconcileAuthAccountsByEmail(service, user);
    } catch (reconcileError) {
      console.error("[oauth-portal-access] reconcileAuthAccountsByEmail failed:", reconcileError);
    }
    const redirectTo = await finalizeOAuthPortalRedirect(service, user, intendedPath, {
      intent: readOAuthIntentFromRequest(req),
      surface: readOAuthSurfaceFromRequest(req),
    });

    return NextResponse.json({ redirectTo });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
