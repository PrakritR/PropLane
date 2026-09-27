import { NextResponse } from "next/server";

import { assertGoogleCalendarProviderAllowed, buildGoogleCalendarOAuthUrl, googleCalendarOAuthRedirectUri } from "@/lib/google-calendar/api.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { isGoogleCalendarOAuthConfigured, warmGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";
import { sanitizeOAuthReturnPath } from "@/lib/auth/oauth-return-path";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Vendor clone of `/api/portal/google-calendar/connect` — same OAuth
 * machinery (`api.server.ts`/`settings.ts` operate purely on `userId`, with
 * no manager-specific behavior), gated on the vendor role instead of manager.
 * The shared callback route (`/api/portal/google-calendar/callback`) needs no
 * change: it resolves the return destination entirely from the signed state
 * this route mints, and `exchangeGoogleCalendarCode` writes by `userId` alone.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const originParam = url.searchParams.get("origin")?.trim();
  const origin = originParam || url.origin;
  // `sanitizeOAuthReturnPath` only allows /auth/ or /portal/ paths through, so
  // a vendor's own `returnTo` (e.g. /vendor/calendar) always falls back here —
  // reconnecting always lands back on the default Calendar tab.
  const returnPath = sanitizeOAuthReturnPath(url.searchParams.get("returnTo"), "/vendor/calendar");
  const returnTo = `${origin.replace(/\/$/, "")}${returnPath}`;

  try {
    await warmGoogleCalendarOAuthConfig();
    if (!isGoogleCalendarOAuthConfigured()) {
      debugGoogleCalendarLog("vendor/google-calendar/connect:GET", "calendar oauth not configured", { origin });
      const reason = encodeURIComponent("Google Calendar OAuth is not configured on this server.");
      return NextResponse.redirect(`${returnTo}?gcal=error&reason=${reason}`);
    }
    const resolved = await resolveVendorPortalUserId();
    if (!resolved.ok) {
      debugGoogleCalendarLog("vendor/google-calendar/connect:GET", "calendar oauth unauthorized", { origin });
      const reason = encodeURIComponent("Sign in as a vendor on this port, then try again.");
      return NextResponse.redirect(`${returnTo}?gcal=error&reason=${reason}`);
    }
    const userId = resolved.userId;
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    await assertGoogleCalendarProviderAllowed(createSupabaseServiceRoleClient(), userId, "oauth_start");
    const redirectUri = googleCalendarOAuthRedirectUri(origin);
    debugGoogleCalendarLog("vendor/google-calendar/connect:GET", "calendar oauth redirect", {
      vendorSuffix: userId.slice(-6),
      browserOrigin: origin,
      redirectUri,
    });
    const oauthUrl = buildGoogleCalendarOAuthUrl(origin, userId, returnPath, {
      loginHint: user?.email?.trim() || null,
    });
    return NextResponse.redirect(oauthUrl);
  } catch (e) {
    debugGoogleCalendarLog("vendor/google-calendar/connect:GET", "calendar oauth failed", {
      message: e instanceof Error ? e.message : "unknown",
      origin,
    });
    const reason = encodeURIComponent(e instanceof Error ? e.message : "Failed to start Google Calendar connect.");
    return NextResponse.redirect(`${returnTo}?gcal=error&reason=${reason}`);
  }
}
