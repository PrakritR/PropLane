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
    // Not eligible is the common case — nearly every account is not a
    // test-workspace member. That is a normal "no" answer, not a missing
    // resource, so it is a 200 with a null capability rather than a 404: the
    // global assistant widget probes this on effectively every portal page
    // load, and a 404 status makes an expected, silently-handled response
    // look like a broken endpoint in the network log (Night QA finding #5).
    return NextResponse.json({ capability }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    const unavailable = error instanceof Error && (
      error.message.includes("unavailable")
      || error.message.includes("approved non-production database")
    );
    if (!unavailable) console.error("[agent/sms-test/capability] capability lookup failed", error);
    if (unavailable) return NextResponse.json({ capability: null }, { headers: PRIVATE_HEADERS });
    return NextResponse.json({ error: "Could not check SMS test access." }, { status: 503, headers: PRIVATE_HEADERS });
  }
}
