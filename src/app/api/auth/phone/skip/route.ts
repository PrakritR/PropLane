import { cookies } from "next/headers";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { phoneAuthEnabled } from "@/lib/auth/phone-auth.server";
import { assertPhoneRequestOrigin, phoneAuthFailure, phoneAuthResponse } from "@/lib/auth/phone-auth-request.server";
import {
  loadPhoneRequired,
  PHONE_SEND_FAILED_COOKIE,
  PHONE_SKIP_COOKIE,
  phoneSkipAllowance,
  phoneSkipCookieOptions,
  phoneSkipValue,
  readPhoneSendFailed,
  recordPhoneSkip,
} from "@/lib/auth/phone-required.server";

export const runtime = "nodejs";

/**
 * "Skip for now" on the verify-phone screen. Allowed only when (1) `phone_required` is on and the line is not in shared
 * mode (shared mode never skips), (2) the caller is signed in, and (3) a verification code to this very account really
 * could not be sent in the last 15 minutes (a signed cookie set by `/api/auth/phone/start`), and (4) the account is
 * within its skip allowance (one per 7 days, 3 in its lifetime - the person chooses the number, so an undeliverable
 * one would otherwise manufacture that proof on demand). It sets a cookie bound to the account AND its current
 * sign-in, so the NEXT sign-in is asked again. It never marks the phone verified.
 */
export async function POST(req: Request) {
  try {
    assertPhoneRequestOrigin(req);
    const db = createSupabaseServiceRoleClient();
    if ((await phoneAuthEnabled(db)) || !(await loadPhoneRequired(db))) return phoneAuthFailure();
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) return phoneAuthFailure();
    const jar = await cookies();
    if (!readPhoneSendFailed(user.id, jar.get(PHONE_SEND_FAILED_COOKIE)?.value)) return phoneAuthFailure();
    const allowance = await phoneSkipAllowance(db, user.id);
    if (!allowance.allowed) return phoneAuthFailure();
    const auth = await db.auth.admin.getUserById(user.id);
    if (auth.error || !auth.data.user) return phoneAuthFailure();
    const value = phoneSkipValue(user.id, auth.data.user.last_sign_in_at);
    if (!value) return phoneAuthFailure();
    // The count and the insert are ONE transaction (`record_phone_required_skip`), so parallel requests cannot all pass the
    // allowance read above; only a platform-wide send outage lifts the cap.
    if (!(await recordPhoneSkip(db, user.id, new Date(), { enforce: !allowance.outage }))) return phoneAuthFailure();
    jar.set(PHONE_SKIP_COOKIE, value, phoneSkipCookieOptions(new URL(req.url).protocol === "https:"));
    jar.set(PHONE_SEND_FAILED_COOKIE, "", { ...phoneSkipCookieOptions(new URL(req.url).protocol === "https:"), maxAge: 0 });
    return phoneAuthResponse({ ok: true });
  } catch { return phoneAuthFailure(); }
}
