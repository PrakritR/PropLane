import { NextResponse } from "next/server";
import { sendGuestSignupLink } from "@/lib/guest-signup-link/send.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
export const GUEST_LINK_REQUESTS_PER_IP_PER_HOUR = 10;

/**
 * "Text me a link" for a renter with no account (captain, Nov 14).
 *
 *   POST { kind: "apply", draftToken }      the held application's token (its own phone is the destination)
 *   POST { kind: "tour",  tourInquiryId }   a guest tour that ticked the SMS box (its own phone is the destination)
 *
 * The request never names a phone. The answer says only whether a text left: never whether the number already has an
 * account. Per-IP, per-phone and per-subject limits apply, and the link itself is the existing phone-bound `account` link.
 */
export async function POST(req: Request) {
  if (!(await rateLimit(`guest-signup-link-ip:${clientIpFrom(req)}`, GUEST_LINK_REQUESTS_PER_IP_PER_HOUR, 60 * 60 * 1000)).ok) {
    return NextResponse.json({ error: "Too many tries. Please try again later." }, { status: 429, headers: NO_STORE });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (body.kind !== "apply" && body.kind !== "tour")) {
    return NextResponse.json({ error: "We could not text that number. Use a code or email instead." }, { status: 400, headers: NO_STORE });
  }
  const result = await sendGuestSignupLink(
    createSupabaseServiceRoleClient(),
    body.kind === "tour" ? { kind: "tour", tourInquiryId: body.tourInquiryId } : { kind: "apply", draftToken: body.draftToken },
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
