import "server-only";
import { NextResponse } from "next/server";
import { PHONE_AUTH_ERROR } from "@/lib/auth/phone-auth.server";
import { PHONE_AUTH_COPY, type PhoneAuthErrorKind } from "@/lib/auth/phone-auth-errors";
import { rateLimit } from "@/lib/rate-limit";

const HOUR_MS = 60 * 60 * 1000;
/** Whole-endpoint hourly send budget for phone codes. A text costs money, so pumping stops here. */
export const PHONE_START_GLOBAL_PER_HOUR = 300;

/**
 * The ONE endpoint-wide budget every door that texts a sign-in code must take from, so a second door (the
 * "finish setup" link) cannot spend SMS outside the ceiling the main one enforces.
 */
export async function allowPhoneStartGlobalBudget(): Promise<boolean> {
  return (await rateLimit("phone-auth-start-global", PHONE_START_GLOBAL_PER_HOUR, HOUR_MS)).ok;
}

export function phoneAuthResponse(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function phoneAuthFailure() {
  // Deliberately identical for expired, missing, taken, throttled, and bad codes.
  return phoneAuthResponse({ error: PHONE_AUTH_ERROR }, 400);
}

/**
 * The sign-in door's failure: a `kind` and its plain sentence (see `phone-auth-errors.ts` for which kinds may be named).
 * `off` is a 409 with `phoneOff: true` so the form can hide itself instead of leaving a dead phone box.
 */
export function phoneSignInFailure(kind: PhoneAuthErrorKind, extra: Record<string, unknown> = {}) {
  return phoneAuthResponse(
    { error: PHONE_AUTH_COPY[kind], kind, ...(kind === "off" ? { phoneOff: true } : {}), ...extra },
    kind === "off" ? 409 : 400,
  );
}

export function assertPhoneRequestOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) throw new Error(PHONE_AUTH_ERROR);
}

export function phoneProofCookieOptions(req: Request) {
  return { httpOnly: true, secure: new URL(req.url).protocol === "https:", sameSite: "strict" as const, path: "/api/auth/phone", maxAge: 600 };
}
