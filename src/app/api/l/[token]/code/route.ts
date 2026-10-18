import { NextResponse } from "next/server";
import { expiredLinkResponse, allowLinkRequest, setLinkSessionCookie } from "@/lib/one-number/link-http.server";
import { requestLinkUnlockCode, verifyLinkUnlockCode } from "@/lib/one-number/link-unlock.server";
import { resolvePhoneBoundLink } from "@/lib/one-number/links.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The code step behind `/l/<token>`.
 *
 *   { action: "send" }           text a one-time code to the phone the link is bound to
 *   { action: "verify", code }   check it; on success set the verified-session cookie
 *
 * The destination of a code is the link's own phone, read from the link row. Nothing in the
 * request chooses it, so a forwarded link sends its code to the original phone and the person
 * holding the link cannot read it. A dead link, a link with no code step and an unknown token all
 * answer identically.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!(await allowLinkRequest(req, token, "code"))) {
    return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: NO_STORE });
  }
  const body = (await req.json().catch(() => null)) as { action?: unknown; code?: unknown } | null;
  const db = createSupabaseServiceRoleClient();
  const resolved = await resolvePhoneBoundLink(db, token, { count: false });
  if (!resolved || !resolved.link.requiresOtp) return expiredLinkResponse();
  const { link } = resolved;

  if (body?.action === "send") {
    const sent = await requestLinkUnlockCode(db, link);
    if (sent.ok) return NextResponse.json({ ok: true }, { headers: NO_STORE });
    if (sent.reason === "rate_limited") {
      return NextResponse.json({ error: "Too many codes were sent. Try again in an hour." }, { status: 429, headers: NO_STORE });
    }
    return NextResponse.json({ error: "We could not text a code right now. Try again soon." }, { status: 502, headers: NO_STORE });
  }

  if (body?.action === "verify") {
    const verified = await verifyLinkUnlockCode(db, link, body.code);
    if (verified.ok) {
      const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
      setLinkSessionCookie(response, token, verified.session);
      return response;
    }
    if (verified.reason === "locked") {
      return NextResponse.json({ error: "Too many wrong codes. Ask for a new code." }, { status: 429, headers: NO_STORE });
    }
    return NextResponse.json({ error: "That code did not work." }, { status: 400, headers: NO_STORE });
  }

  return NextResponse.json({ error: "Unsupported request." }, { status: 400, headers: NO_STORE });
}
