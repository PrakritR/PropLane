import { cookies } from "next/headers";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { newPhoneBrowserSecret, PHONE_AUTH_ERROR, PHONE_BROWSER_COOKIE, startPhoneChallenge, type PhonePurpose } from "@/lib/auth/phone-auth.server";
import { allowPhoneStartGlobalBudget, assertPhoneRequestOrigin, phoneAuthFailure, phoneAuthResponse, phoneProofCookieOptions, phoneSignInFailure } from "@/lib/auth/phone-auth-request.server";
import { phoneAuthKindOf, type PhoneAuthErrorKind } from "@/lib/auth/phone-auth-errors";
import { PhoneOwnFlowError } from "@/lib/auth/phone-own-errors";
import { PHONE_SEND_FAILED_COOKIE, phoneSendFailedCookieOptions, phoneSendFailedValue, PhoneSendFailedError } from "@/lib/auth/phone-required.server";

export const runtime = "nodejs";
const HOUR_MS = 60 * 60 * 1000;
/** Per-IP hourly send budget; the whole-endpoint one is shared with every other door that texts a code. */
const START_PER_IP_PER_HOUR = 5;
/** Per-account hourly send budget for the Settings "Verify" flow, on top of the per-IP and endpoint-wide ones. */
const START_PER_USER_PER_HOUR = 5;
const PURPOSES: PhonePurpose[] = ["sign_in", "verify_phone", "verify_own_phone", "change_number_old", "change_number_new"];

export async function POST(req: Request) {
  // Only the signed-out sign-in door names a failure (`phone-auth-errors.ts`); every other purpose keeps the one generic message.
  let signIn = false;
  const fail = (kind: PhoneAuthErrorKind) => (signIn ? phoneSignInFailure(kind) : phoneAuthFailure());
  try {
    assertPhoneRequestOrigin(req);
    const body = await req.json();
    if (!PURPOSES.includes(body?.purpose)) return phoneAuthFailure();
    signIn = body.purpose === "sign_in";
    // Counted per device / per endpoint, never per number, so naming it tells a caller nothing about any number.
    const byIp = await rateLimit(`phone-auth-start-ip:${clientIpFrom(req)}`, START_PER_IP_PER_HOUR, HOUR_MS);
    if (!byIp.ok) return fail("throttled");
    if (!(await allowPhoneStartGlobalBudget())) return fail("throttled");
    const jar = await cookies();
    const browser = jar.get(PHONE_BROWSER_COOKIE)?.value || newPhoneBrowserSecret();
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    if (body.purpose === "verify_own_phone") {
      // Own-phone flow: a session is the only way in, and the number is the one on that user's profile, not the body's.
      if (!user?.id) return phoneAuthFailure();
      if (!(await rateLimit(`phone-auth-start-user:${user.id}`, START_PER_USER_PER_HOUR, HOUR_MS)).ok) return phoneAuthFailure();
    }
    try {
      const result = await startPhoneChallenge({ db: createSupabaseServiceRoleClient(), userId: user?.id ?? null,
        browser, phone: body.phone, purpose: body.purpose });
      jar.set(PHONE_BROWSER_COOKIE, browser, phoneProofCookieOptions(req));
      return phoneAuthResponse(result);
    } catch (error) {
      if (error instanceof PhoneOwnFlowError) return phoneAuthResponse({ error: error.message }, 400);
      // The ONE failure that offers "Skip for now": the code could not be sent (a provider outage must not lock anyone out).
      // The cookie is the signed proof of that, so the skip route cannot be used by an account whose send worked.
      if (error instanceof PhoneSendFailedError && user?.id && body.purpose === "verify_phone") {
        const proof = phoneSendFailedValue(user.id, Date.now());
        if (proof) jar.set(PHONE_SEND_FAILED_COOKIE, proof, phoneSendFailedCookieOptions(new URL(req.url).protocol === "https:"));
        const failure = phoneAuthResponse({ error: PHONE_AUTH_ERROR, sendFailed: true }, 400);
        return failure;
      }
      throw error;
    }
  } catch (error) { return signIn ? phoneSignInFailure(phoneAuthKindOf(error)) : phoneAuthFailure(); }
}
