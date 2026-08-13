import { NextResponse } from "next/server";

import { exchangeGoogleCalendarCode, googleCalendarOAuthReturnTo, verifyOAuthState } from "@/lib/google-calendar/api.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const oauthError = url.searchParams.get("error");
  const oauthErrorDescription = url.searchParams.get("error_description");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const callbackOrigin = url.origin;

  if (oauthError) {
    debugGoogleCalendarLog("callback/route.ts:GET", "google oauth error redirect", {
      hypothesisId: "H2",
      error: oauthError,
      description: oauthErrorDescription?.slice(0, 200) ?? null,
    });
    const oauthState = state ? verifyOAuthState(state) : null;
    const returnTo = googleCalendarOAuthReturnTo(oauthState, callbackOrigin);
    const reason = encodeURIComponent(oauthErrorDescription ?? oauthError);
    return NextResponse.redirect(`${returnTo}?gcal=error&reason=${reason}`);
  }

  if (!code || !state) {
    const reason = encodeURIComponent("Google did not return an authorization code. Try Connect again.");
    return NextResponse.redirect(`${callbackOrigin}/portal/calendar?gcal=error&reason=${reason}`);
  }

  const oauthState = verifyOAuthState(state);
  if (!oauthState) {
    debugGoogleCalendarLog("callback/route.ts:GET", "invalid oauth state", { hypothesisId: "H17" });
    const reason = encodeURIComponent(
      "Calendar connect session expired or was invalid. Click Connect again (once) and approve in Google.",
    );
    return NextResponse.redirect(`${callbackOrigin}/portal/calendar?gcal=error&reason=${reason}`);
  }

  const returnTo = `${oauthState.returnOrigin}${oauthState.returnPath}`;

  try {
    const db = createSupabaseServiceRoleClient();
    await exchangeGoogleCalendarCode(db, oauthState.userId, code, oauthState.returnOrigin);
    debugGoogleCalendarLog("callback/route.ts:GET", "calendar connected", {
      hypothesisId: "H2",
      runId: "post-fix-v8",
      managerSuffix: oauthState.userId.slice(-6),
      returnOrigin: oauthState.returnOrigin,
      callbackOrigin,
    });
    return NextResponse.redirect(`${returnTo}?gcal=connected`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    debugGoogleCalendarLog("callback/route.ts:GET", "calendar connect failed", {
      managerSuffix: oauthState.userId.slice(-6),
      message,
    });
    const reason = encodeURIComponent(message);
    return NextResponse.redirect(`${returnTo}?gcal=error&reason=${reason}`);
  }
}
