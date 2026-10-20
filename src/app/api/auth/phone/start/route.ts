import { cookies } from "next/headers";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { newPhoneBrowserSecret, PHONE_AUTH_ERROR, PHONE_BROWSER_COOKIE, startPhoneChallenge, type PhonePurpose } from "@/lib/auth/phone-auth.server";
import { assertPhoneRequestOrigin, phoneAuthFailure, phoneAuthResponse, phoneProofCookieOptions } from "@/lib/auth/phone-auth-request.server";
import { PHONE_SEND_FAILED_COOKIE, phoneSendFailedCookieOptions, phoneSendFailedValue, PhoneSendFailedError } from "@/lib/auth/phone-required.server";

export const runtime = "nodejs";
const HOUR_MS = 60 * 60 * 1000;
/** Per-IP and whole-endpoint hourly send budgets: a text costs money, so pumping stops here. */
const START_PER_IP_PER_HOUR = 5;
const START_GLOBAL_PER_HOUR = 300;
const PURPOSES: PhonePurpose[] = ["sign_in", "verify_phone", "change_number_old", "change_number_new"];

export async function POST(req: Request) {
  try {
    assertPhoneRequestOrigin(req);
    const body = await req.json();
    if (!PURPOSES.includes(body?.purpose)) return phoneAuthFailure();
    // Same generic refusal as every other failure: a throttled caller learns nothing about a number.
    const byIp = await rateLimit(`phone-auth-start-ip:${clientIpFrom(req)}`, START_PER_IP_PER_HOUR, HOUR_MS);
    if (!byIp.ok) return phoneAuthFailure();
    const global = await rateLimit("phone-auth-start-global", START_GLOBAL_PER_HOUR, HOUR_MS);
    if (!global.ok) return phoneAuthFailure();
    const jar = await cookies();
    const browser = jar.get(PHONE_BROWSER_COOKIE)?.value || newPhoneBrowserSecret();
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    try {
      const result = await startPhoneChallenge({ db: createSupabaseServiceRoleClient(), userId: user?.id ?? null,
        browser, phone: body.phone, purpose: body.purpose });
      jar.set(PHONE_BROWSER_COOKIE, browser, phoneProofCookieOptions(req));
      return phoneAuthResponse(result);
    } catch (error) {
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
  } catch { return phoneAuthFailure(); }
}
