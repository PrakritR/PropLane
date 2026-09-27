import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { resolveGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";
import { getGoogleSheetsAccessTokenDetailed, googlePickerApiKey, googlePickerAppId } from "@/lib/sheet-sync/google-sheets-auth";

export const runtime = "nodejs";

const PICKER_TOKEN_ERROR_MESSAGE: Record<"not_connected" | "revoked" | "transient_error", string> = {
  not_connected: "Connect Google first.",
  revoked: "Google access was revoked or expired. Reconnect Google, then try again.",
  transient_error: "Could not reach Google right now. Try again in a moment.",
};

export async function GET() {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const result = await getGoogleSheetsAccessTokenDetailed(actor.db, actor.userId);
  if (!result.ok) {
    return NextResponse.json(
      { error: PICKER_TOKEN_ERROR_MESSAGE[result.reason], reason: result.reason },
      { status: 401 },
    );
  }
  return NextResponse.json({
    accessToken: result.accessToken,
    apiKey: googlePickerApiKey(),
    clientId: resolveGoogleCalendarOAuthConfig()?.clientId ?? null,
    appId: googlePickerAppId(),
  });
}
