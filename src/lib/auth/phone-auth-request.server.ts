import "server-only";
import { NextResponse } from "next/server";
import { PHONE_AUTH_ERROR } from "@/lib/auth/phone-auth.server";

export function phoneAuthResponse(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export function phoneAuthFailure() {
  // Deliberately identical for expired, missing, taken, throttled, and bad codes.
  return phoneAuthResponse({ error: PHONE_AUTH_ERROR }, 400);
}

export function assertPhoneRequestOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) throw new Error(PHONE_AUTH_ERROR);
}

export function phoneProofCookieOptions(req: Request) {
  return { httpOnly: true, secure: new URL(req.url).protocol === "https:", sameSite: "strict" as const, path: "/api/auth/phone", maxAge: 600 };
}
