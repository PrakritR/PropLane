import { cookies } from "next/headers";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { PHONE_BROWSER_COOKIE, PHONE_OLD_COOKIE, verifyPhoneChallenge } from "@/lib/auth/phone-auth.server";
import { assertPhoneRequestOrigin, phoneAuthFailure, phoneAuthResponse, phoneProofCookieOptions } from "@/lib/auth/phone-auth-request.server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    assertPhoneRequestOrigin(req);
    const body = await req.json();
    if (typeof body?.challengeId !== "string" || typeof body?.code !== "string") return phoneAuthFailure();
    const jar = await cookies();
    const browser = jar.get(PHONE_BROWSER_COOKIE)?.value;
    if (!browser) return phoneAuthFailure();
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    const result = await verifyPhoneChallenge({ db: createSupabaseServiceRoleClient(), userId: user?.id ?? null,
      browser, challengeId: body.challengeId, code: body.code, oldChallengeId: jar.get(PHONE_OLD_COOKIE)?.value });
    if ("oldNumberVerified" in result) {
      jar.set(PHONE_OLD_COOKIE, body.challengeId, phoneProofCookieOptions(req));
    } else {
      if ("session" in result && result.session) {
        const installed = await client.auth.setSession(result.session);
        if (installed.error) return phoneAuthFailure();
      }
      jar.set(PHONE_OLD_COOKIE, "", { ...phoneProofCookieOptions(req), maxAge: 0 });
    }
    return phoneAuthResponse("oldNumberVerified" in result ? { ok: true, oldNumberVerified: true } : { ok: true });
  } catch { return phoneAuthFailure(); }
}
