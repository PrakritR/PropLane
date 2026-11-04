import { NextResponse } from "next/server";
import { assertVendorQuoteSessionBinding, requestVendorQuoteSmsChallenge } from "@/lib/vendor-quote-contact.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { hasSameOriginJson, limitPublicRequest, PRIVATE_HEADERS, readBoundedJson, VENDOR_QUOTE_SESSION_COOKIE } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasSameOriginJson(request)) return NextResponse.json({ ok: false }, { status: 403, headers: PRIVATE_HEADERS });
  const body = await readBoundedJson(request);
  const phoneE164 = typeof body?.phoneE164 === "string" ? body.phoneE164.trim() : "";
  if (!body || body.consented !== true || !/^\+[1-9]\d{7,14}$/.test(phoneE164)) {
    return NextResponse.json({ ok: false }, { status: 400, headers: PRIVATE_HEADERS });
  }
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${VENDOR_QUOTE_SESSION_COOKIE.response}=`))?.slice(VENDOR_QUOTE_SESSION_COOKIE.response.length + 1);
  if (!token || !(await limitPublicRequest(request, "sms-challenge", token))) {
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
  try {
    const db = createSupabaseServiceRoleClient();
    await assertVendorQuoteSessionBinding(db, token, request.headers.get("x-vendor-quote-binding"), "response");
    const challenge = await requestVendorQuoteSmsChallenge(db, token, { phoneE164, consented: true });
    return NextResponse.json({ ok: true, challenge }, { headers: PRIVATE_HEADERS });
  } catch {
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
}
