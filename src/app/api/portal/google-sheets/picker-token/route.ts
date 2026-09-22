import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { resolveGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";
import { getGoogleSheetsAccessToken, googlePickerApiKey } from "@/lib/sheet-sync/google-sheets-auth";

export const runtime = "nodejs";

export async function GET() {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const accessToken = await getGoogleSheetsAccessToken(actor.db, actor.userId);
  if (!accessToken) {
    return NextResponse.json({ error: "Connect Google first." }, { status: 401 });
  }
  return NextResponse.json({
    accessToken,
    apiKey: googlePickerApiKey(),
    clientId: resolveGoogleCalendarOAuthConfig()?.clientId ?? null,
  });
}
