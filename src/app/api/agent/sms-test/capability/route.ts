import { NextResponse } from "next/server";

import {
  resolveSmsTestCapability,
  type SmsTestPortal,
} from "@/lib/agent/sms-test-context.server";

export const runtime = "nodejs";
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

function portalFromRequest(request: Request): SmsTestPortal | null {
  const portal = new URL(request.url).searchParams.get("portal");
  return portal === "manager" || portal === "resident" ? portal : null;
}

export async function GET(request: Request) {
  const portal = portalFromRequest(request);
  if (!portal) return NextResponse.json({ error: "Invalid portal." }, { status: 400, headers: PRIVATE_HEADERS });

  try {
    const capability = await resolveSmsTestCapability(portal);
    if (!capability) return NextResponse.json({ error: "Not found." }, { status: 404, headers: PRIVATE_HEADERS });
    return NextResponse.json({ capability }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    const unavailable = error instanceof Error && (
      error.message.includes("unavailable")
      || error.message.includes("approved non-production database")
    );
    if (!unavailable) console.error("[agent/sms-test/capability] capability lookup failed", error);
    return NextResponse.json(
      { error: unavailable ? "Not found." : "Could not check SMS test access." },
      { status: unavailable ? 404 : 503, headers: PRIVATE_HEADERS },
    );
  }
}
