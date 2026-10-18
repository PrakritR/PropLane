import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { newPhoneBrowserSecret, PHONE_BROWSER_COOKIE, startPhoneChallenge } from "@/lib/auth/phone-auth.server";
import { assertPhoneRequestOrigin, phoneAuthFailure, phoneAuthResponse, phoneProofCookieOptions } from "@/lib/auth/phone-auth-request.server";
import { allowLinkRequest, expiredLinkResponse } from "@/lib/one-number/link-http.server";
import { resolveSetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { e164FromPhoneKey } from "@/lib/one-number/unassigned-leads.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Text the sign-in code for a "finish setup" link. A link texted to a phone sends its code to THAT
 * phone only; nothing in the request chooses the destination. A web-demo link has no phone, so the
 * visitor's own number (`{ phone }`) is used. The code is then checked by `/api/auth/phone/verify`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  try {
    assertPhoneRequestOrigin(req);
    if (!(await allowLinkRequest(req, token, "setup-send", 10, 6))) {
      return NextResponse.json({ error: "Too many tries. Wait a few minutes." }, { status: 429, headers: { "Cache-Control": "no-store" } });
    }
    const body = (await req.json().catch(() => null)) as { phone?: unknown } | null;
    const db = createSupabaseServiceRoleClient();
    const link = await resolveSetupLink(db, token);
    if (!link) return expiredLinkResponse();
    const phone = link.phoneKey ? e164FromPhoneKey(link.phoneKey) : body?.phone;
    const jar = await cookies();
    const browser = jar.get(PHONE_BROWSER_COOKIE)?.value || newPhoneBrowserSecret();
    const result = await startPhoneChallenge({ db, userId: null, browser, phone, purpose: "sign_in" });
    jar.set(PHONE_BROWSER_COOKIE, browser, phoneProofCookieOptions(req));
    return phoneAuthResponse(result);
  } catch {
    return phoneAuthFailure();
  }
}
