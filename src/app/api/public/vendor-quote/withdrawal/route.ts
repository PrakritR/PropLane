import { NextResponse } from "next/server";
import { assertVendorQuoteSessionBinding, stopVendorQuoteEmail } from "@/lib/vendor-quote-contact.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { hasSameOriginJson, limitPublicRequest, PRIVATE_HEADERS, readBoundedJson, VENDOR_QUOTE_SESSION_COOKIE } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!hasSameOriginJson(request)) return NextResponse.json({ ok: false }, { status: 403, headers: PRIVATE_HEADERS });
  const body = await readBoundedJson(request);
  if (!body || body.action !== "stop_email") return NextResponse.json({ ok: false }, { status: 400, headers: PRIVATE_HEADERS });
  const token = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${VENDOR_QUOTE_SESSION_COOKIE.withdrawal}=`))?.slice(VENDOR_QUOTE_SESSION_COOKIE.withdrawal.length + 1);
  if (!token || !(await limitPublicRequest(request, "withdrawal", token))) {
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
  try {
    const db = createSupabaseServiceRoleClient();
    await assertVendorQuoteSessionBinding(db, token, request.headers.get("x-vendor-quote-binding"), "withdrawal");
    await stopVendorQuoteEmail(db, token);
    const response = NextResponse.json({ ok: true }, { headers: PRIVATE_HEADERS });
    response.cookies.set(VENDOR_QUOTE_SESSION_COOKIE.withdrawal, "", {
      httpOnly: true,
      secure: new URL(request.url).protocol === "https:",
      sameSite: "strict",
      path: "/api/public/vendor-quote",
      expires: new Date(0),
      maxAge: 0,
    });
    return response;
  } catch {
    return NextResponse.json({ ok: false }, { status: 404, headers: PRIVATE_HEADERS });
  }
}
