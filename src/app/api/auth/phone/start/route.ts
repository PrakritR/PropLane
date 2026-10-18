import { cookies } from "next/headers";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { newPhoneBrowserSecret, PHONE_BROWSER_COOKIE, startPhoneChallenge, type PhonePurpose } from "@/lib/auth/phone-auth.server";
import { assertPhoneRequestOrigin, phoneAuthFailure, phoneAuthResponse, phoneProofCookieOptions } from "@/lib/auth/phone-auth-request.server";

export const runtime = "nodejs";
const PURPOSES: PhonePurpose[] = ["sign_in", "verify_phone", "change_number_old", "change_number_new"];

export async function POST(req: Request) {
  try {
    assertPhoneRequestOrigin(req);
    const body = await req.json();
    if (!PURPOSES.includes(body?.purpose)) return phoneAuthFailure();
    const jar = await cookies();
    const browser = jar.get(PHONE_BROWSER_COOKIE)?.value || newPhoneBrowserSecret();
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    const result = await startPhoneChallenge({ db: createSupabaseServiceRoleClient(), userId: user?.id ?? null,
      browser, phone: body.phone, purpose: body.purpose });
    jar.set(PHONE_BROWSER_COOKIE, browser, phoneProofCookieOptions(req));
    return phoneAuthResponse(result);
  } catch { return phoneAuthFailure(); }
}
