import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { PHONE_BROWSER_COOKIE, PHONE_OLD_COOKIE, phoneResendAllowed, verifyPhoneChallenge } from "@/lib/auth/phone-auth.server";
import { phoneAuthKindOf } from "@/lib/auth/phone-auth-errors";
import { PhoneOwnFlowError } from "@/lib/auth/phone-own-errors";
import { assertPhoneRequestOrigin, phoneAuthFailure, phoneAuthResponse, phoneProofCookieOptions, phoneSignInFailure } from "@/lib/auth/phone-auth-request.server";
import { GET_STARTED_PATH } from "@/lib/auth/get-started-path";
import { LAST_PORTAL_COOKIE } from "@/lib/auth/last-portal";
import { isUnsafeRedirectPath, normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";
import { applyPortalCookies, resolvePostSignInDestination, type PostSignInDestination } from "@/lib/auth/post-sign-in-destination.server";

export const runtime = "nodejs";

/** A `next` the form carried (a deep link), or the generic continue path. Same-origin paths only. */
function intendedPathFrom(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/") || isUnsafeRedirectPath(raw)) return "/auth/continue";
  return normalizePostAuthPath(raw);
}

/** A number with no account has just been given a role-less login: say so, then offer the three ways in (P7). */
function newNumberPath(intendedPath: string): string {
  const params = new URLSearchParams({ phone_new: "1" });
  if (intendedPath !== "/auth/continue") params.set("next", intendedPath);
  return `${GET_STARTED_PATH}?${params.toString()}`;
}

export async function POST(req: Request) {
  // The form says which door it is; that only picks the wording (a sign-in failure names its kind, see phone-auth-errors.ts).
  let signIn = false;
  try {
    assertPhoneRequestOrigin(req);
    const body = await req.json();
    signIn = body?.purpose === "sign_in";
    const failure = (error?: unknown) => {
      if (!signIn) return phoneAuthFailure();
      const kind = phoneAuthKindOf(error);
      return phoneSignInFailure(kind);
    };
    if (typeof body?.challengeId !== "string" || typeof body?.code !== "string") return failure();
    const jar = await cookies();
    const browser = jar.get(PHONE_BROWSER_COOKIE)?.value;
    // The proof cookie lives ten minutes, like the code: without it this browser's challenge is gone.
    if (!browser) return signIn ? phoneSignInFailure("expired") : phoneAuthFailure();
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    const ownPhone = body.purpose === "verify_own_phone";
    if (ownPhone && !user?.id) return phoneAuthFailure();
    const db = createSupabaseServiceRoleClient();
    let result: Awaited<ReturnType<typeof verifyPhoneChallenge>>;
    try {
      result = await verifyPhoneChallenge({ db, userId: user?.id ?? null,
        browser, challengeId: body.challengeId, code: body.code, oldChallengeId: jar.get(PHONE_OLD_COOKIE)?.value, ownPhone, signIn });
    } catch (error) {
      if (error instanceof PhoneOwnFlowError) return phoneAuthResponse({ error: error.message }, 400);
      if (signIn && phoneAuthKindOf(error) === "expired") {
        // This browser's own number: tell the form whether a fresh code would still be sent, so it never spends the hourly cap blind.
        return phoneSignInFailure("expired", { canResend: await phoneResendAllowed(db, body.challengeId, browser) });
      }
      return failure(error);
    }
    if ("oldNumberVerified" in result) {
      jar.set(PHONE_OLD_COOKIE, body.challengeId, phoneProofCookieOptions(req));
      return phoneAuthResponse({ ok: true, oldNumberVerified: true });
    }
    let next: string | undefined;
    let destination: PostSignInDestination | null = null;
    if ("session" in result && result.session) {
      const installed = await client.auth.setSession(result.session);
      if (installed.error) return failure();
      // Straight to the portal (P5): the same resolver /auth/continue would call, run now for the new session. Any
      // failure leaves `next` unset and the form falls back to /auth/continue exactly as before.
      try {
        const intendedPath = intendedPathFrom(body.next);
        if (result.created) {
          next = newNumberPath(intendedPath);
        } else {
          destination = await resolvePostSignInDestination({
            service: db, user: result.user, intendedPath, lastPortalRole: jar.get(LAST_PORTAL_COOKIE)?.value,
          });
          next = destination.redirectTo;
        }
      } catch {
        next = undefined;
        destination = null;
      }
    }
    jar.set(PHONE_OLD_COOKIE, "", { ...phoneProofCookieOptions(req), maxAge: 0 });
    const res = phoneAuthResponse(next ? { ok: true, next } : { ok: true });
    if (destination) applyPortalCookies(res as NextResponse, destination, process.env.NODE_ENV === "production");
    return res;
  } catch (error) { return signIn ? phoneSignInFailure(phoneAuthKindOf(error)) : phoneAuthFailure(); }
}
