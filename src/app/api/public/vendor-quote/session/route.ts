import { NextRequest, NextResponse } from "next/server";
import { loadVendorQuoteSession } from "@/lib/vendor-quote-contact.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { limitPublicRequest, PRIVATE_HEADERS, VENDOR_QUOTE_SESSION_COOKIE } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const responseToken = request.cookies.get(VENDOR_QUOTE_SESSION_COOKIE.response)?.value;
  const withdrawalToken = request.cookies.get(VENDOR_QUOTE_SESSION_COOKIE.withdrawal)?.value;
  const sessions = [
    ...(responseToken ? [{ token: responseToken, purpose: "response" as const }] : []),
    ...(withdrawalToken ? [{ token: withdrawalToken, purpose: "withdrawal" as const }] : []),
  ];
  if (!sessions.length) return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  if (!(await limitPublicRequest(request, "session", sessions[0].token))) {
    return NextResponse.json({ ok: false }, { status: 429, headers: PRIVATE_HEADERS });
  }
  try {
    const db = createSupabaseServiceRoleClient();
    for (const session of sessions) {
      const projection = await loadVendorQuoteSession(db, session.token, session.purpose);
      if (projection) return NextResponse.json({ ok: true, purpose: session.purpose, projection }, { headers: PRIVATE_HEADERS });
    }
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  } catch {
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
}
