import { NextResponse } from "next/server";

import { buildGoogleCalendarOAuthUrl } from "@/lib/google-calendar/api.server";
import { isGoogleCalendarOAuthConfigured, warmGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";
import { sanitizeOAuthReturnPath } from "@/lib/auth/oauth-return-path";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { GOOGLE_SHEETS_OAUTH_SCOPES } from "@/lib/sheet-sync/google-sheets-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.searchParams.get("origin")?.trim() || url.origin;
  const returnPath = sanitizeOAuthReturnPath(url.searchParams.get("returnTo"), "/portal/profile?tab=spreadsheets");
  const returnTo = `${origin.replace(/\/$/, "")}${returnPath}`;

  try {
    await warmGoogleCalendarOAuthConfig();
    if (!isGoogleCalendarOAuthConfigured()) {
      const reason = encodeURIComponent("Google Sheets OAuth is not configured on this server.");
      return NextResponse.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}gsheet=error&reason=${reason}`);
    }
    const actor = await requireManagerRouteUser();
    if (!actor) {
      const reason = encodeURIComponent("Sign in as a manager, then try again.");
      return NextResponse.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}gsheet=error&reason=${reason}`);
    }
    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("email").eq("id", actor.userId).maybeSingle();
    const oauthUrl = buildGoogleCalendarOAuthUrl(origin, actor.userId, returnPath, {
      loginHint: profile?.email ?? null,
      purpose: "sheets",
      scopes: GOOGLE_SHEETS_OAUTH_SCOPES,
    });
    return NextResponse.redirect(oauthUrl);
  } catch (error) {
    const reason = encodeURIComponent(error instanceof Error ? error.message : "Could not start Google Sheets connect.");
    return NextResponse.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}gsheet=error&reason=${reason}`);
  }
}
