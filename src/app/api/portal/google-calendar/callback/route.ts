import { NextResponse } from "next/server";

import { exchangeGoogleCalendarCode, googleCalendarOAuthReturnTo, verifyOAuthState } from "@/lib/google-calendar/api.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { ensureProplaneCalendarId } from "@/lib/google-calendar/proplane-calendar.server";
import { exchangeGoogleSheetsCode } from "@/lib/sheet-sync/google-sheets-auth";
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
    const flag = oauthState?.purpose === "sheets" ? "gsheet" : "gcal";
    return NextResponse.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}${flag}=error&reason=${reason}`);
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
    if (oauthState.purpose === "sheets") {
      await exchangeGoogleSheetsCode(db, oauthState.userId, code, oauthState.returnOrigin);
      debugGoogleCalendarLog("callback/route.ts:GET", "sheets connected", {
        hypothesisId: "H2",
        managerSuffix: oauthState.userId.slice(-6),
        returnOrigin: oauthState.returnOrigin,
        callbackOrigin,
      });
      return NextResponse.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}gsheet=connected`);
    }
    await exchangeGoogleCalendarCode(db, oauthState.userId, code, oauthState.returnOrigin);
    // Best-effort: create (or find) the dedicated "PropLane" secondary
    // calendar right away so the very first tour/service-visit push already
    // lands there instead of the user's primary calendar. Never blocks or
    // fails the connect itself — an older consent grant without
    // `calendar.app.created`, or any other Google-side hiccup, just leaves
    // writes on the primary calendar until the next reconnect.
    await ensureProplaneCalendarId(db, oauthState.userId).catch((e) => {
      debugGoogleCalendarLog("callback/route.ts:GET", "proplane calendar creation failed", {
        managerSuffix: oauthState.userId.slice(-6),
        message: e instanceof Error ? e.message : "unknown",
      });
    });
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
    const flag = oauthState.purpose === "sheets" ? "gsheet" : "gcal";
    return NextResponse.redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}${flag}=error&reason=${reason}`);
  }
}
