import { NextResponse } from "next/server";
import { readPhoneIdentity } from "@/lib/auth/phone-auth.server";
import { verifiedSessionEmail } from "@/lib/auth/verified-session-email";
import { claimGuestApplicationDraft } from "@/lib/rental-application/guest-draft.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Take the guest application the signed-in renter started before they had an account.
 *
 *   POST { propertyId, token? }  ->  { ok, form } | { ok: false }
 *
 * The session is the proof: a draft is handed over only when it names the session's CONFIRMED email or VERIFIED phone
 * (both read from Auth, never from the body), so the token and the property id are lookup keys, not authority. Single
 * use: the stored body is wiped as it is taken. The caller then submits through the ordinary signed-in write, which
 * runs the per-listing pre-apply gate and every other submit check.
 */
export async function POST(req: Request) {
  const client = await createRealIdentitySupabaseServerClient();
  const { data: { user } } = await client.auth.getUser().catch(() => ({ data: { user: null } }));
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401, headers: NO_STORE });
  if (!(await rateLimit(`guest-draft-claim:${user.id}:${clientIpFrom(req)}`, 20, 60 * 60 * 1000)).ok) {
    return NextResponse.json({ error: "Too many tries." }, { status: 429, headers: NO_STORE });
  }
  const body = (await req.json().catch(() => null)) as { propertyId?: unknown; token?: unknown } | null;
  const propertyId = typeof body?.propertyId === "string" ? body.propertyId.trim() : "";
  if (!propertyId) return NextResponse.json({ ok: false }, { headers: NO_STORE });

  const db = createSupabaseServiceRoleClient();
  const phone = await readPhoneIdentity(db, user.id).catch(() => null);
  const claimed = await claimGuestApplicationDraft(db, {
    userId: user.id,
    contact: {
      email: verifiedSessionEmail(user) || null,
      phoneE164: phone?.verified ? phone.phone : null,
    },
    propertyId,
    token: typeof body?.token === "string" ? body.token : undefined,
  });
  if (!claimed.ok) {
    return NextResponse.json({ ok: false }, { status: claimed.reason === "unavailable" ? 503 : 200, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, form: claimed.form }, { headers: NO_STORE });
}
