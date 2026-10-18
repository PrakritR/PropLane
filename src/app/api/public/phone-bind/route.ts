import { NextResponse } from "next/server";
import { setLinkSessionCookie } from "@/lib/one-number/link-http.server";
import {
  isPublicBindKind,
  lookupEntryCode,
  publicBindPhoneKey,
  requestPublicBindCode,
  verifyPublicBind,
} from "@/lib/one-number/public-bind.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const INACTIVE = { error: "This link is not active." };

/**
 * Public phone-bind (`/apply/<code>`, `/tour/<code>`): ask for a phone, text a code to it, and once
 * the code is entered mint a phone-bound link for that phone and continue.
 *
 *   { code, kind: "apply" | "tour", action: "send", phone }
 *   { code, kind, action: "verify", phone, otp }
 *
 * The phone here is what the visitor typed, so the code proves they hold it, nothing more. Sending
 * is throttled three ways: per caller, per entry code, and (in the code module) three texts per
 * phone per hour, so the page cannot be used to spam a number.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    code?: unknown;
    kind?: unknown;
    action?: unknown;
    phone?: unknown;
    otp?: unknown;
  } | null;
  if (!body || !isPublicBindKind(body.kind)) return NextResponse.json(INACTIVE, { status: 404, headers: NO_STORE });

  const ip = clientIpFrom(req);
  const [byIp, byCode] = await Promise.all([
    rateLimit(`public-bind-ip:${ip}`, body.action === "send" ? 8 : 30, 60 * 60 * 1000),
    rateLimit(`public-bind-code:${String(body.code ?? "").toUpperCase().slice(0, 16)}`, 120, 60 * 60 * 1000),
  ]);
  if (!byIp.ok || !byCode.ok) {
    return NextResponse.json({ error: "Too many tries. Try again later." }, { status: 429, headers: NO_STORE });
  }

  const db = createSupabaseServiceRoleClient();
  const entry = await lookupEntryCode(db, body.code);
  if (!entry) return NextResponse.json(INACTIVE, { status: 404, headers: NO_STORE });
  const phoneKey = publicBindPhoneKey(body.phone);
  if (!phoneKey) return NextResponse.json({ error: "Enter a US phone number." }, { status: 400, headers: NO_STORE });

  if (body.action === "send") {
    const sent = await requestPublicBindCode(db, { entry, kind: body.kind, phoneKey });
    if (sent.ok) return NextResponse.json({ ok: true }, { headers: NO_STORE });
    if (sent.reason === "rate_limited") {
      return NextResponse.json({ error: "Too many codes were sent to this number. Try again in an hour." }, { status: 429, headers: NO_STORE });
    }
    return NextResponse.json({ error: "We could not text that number. Check it and try again." }, { status: 502, headers: NO_STORE });
  }

  if (body.action === "verify") {
    const bound = await verifyPublicBind(db, { entry, kind: body.kind, phoneKey, code: body.otp });
    if (!bound.ok) {
      if (bound.reason === "locked") {
        return NextResponse.json({ error: "Too many wrong codes. Ask for a new code." }, { status: 429, headers: NO_STORE });
      }
      if (bound.reason === "unavailable") {
        return NextResponse.json({ error: "We could not finish. Try again soon." }, { status: 503, headers: NO_STORE });
      }
      return NextResponse.json({ error: "That code did not work." }, { status: 400, headers: NO_STORE });
    }
    const response = NextResponse.json({ ok: true, href: `/l/${encodeURIComponent(bound.token)}` }, { headers: NO_STORE });
    if (bound.session) setLinkSessionCookie(response, bound.token, bound.session);
    return response;
  }

  return NextResponse.json({ error: "Unsupported request." }, { status: 400, headers: NO_STORE });
}
