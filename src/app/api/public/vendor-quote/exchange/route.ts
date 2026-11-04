import { NextResponse } from "next/server";
import { exchangeVendorQuoteCapability } from "@/lib/vendor-quote-contact.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { hasSameOriginJson, limitPublicRequest, PRIVATE_HEADERS, readBoundedJson, VENDOR_QUOTE_SESSION_COOKIE } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasSameOriginJson(request)) return NextResponse.json({ ok: false }, { status: 403, headers: PRIVATE_HEADERS });
  const body = await readBoundedJson(request);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const purpose = body?.purpose;
  if (!token || token.length > 256 || (purpose !== "response" && purpose !== "withdrawal")) {
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
  if (!(await limitPublicRequest(request, "exchange", token))) {
    return NextResponse.json({ ok: false }, { status: 429, headers: PRIVATE_HEADERS });
  }
  try {
    const exchanged = await exchangeVendorQuoteCapability(createSupabaseServiceRoleClient(), { token, purpose });
    if (!exchanged) return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
    const response = NextResponse.json({ ok: true, projection: exchanged.projection }, { headers: PRIVATE_HEADERS });
    const secure = new URL(request.url).protocol === "https:";
    response.cookies.set(VENDOR_QUOTE_SESSION_COOKIE[purpose], exchanged.sessionToken, {
      httpOnly: true,
      secure,
      sameSite: "strict",
      path: "/api/public/vendor-quote",
      expires: new Date(exchanged.expiresAt),
      maxAge: Math.max(0, Math.floor((new Date(exchanged.expiresAt).getTime() - Date.now()) / 1000)),
    });
    return response;
  } catch {
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
}
