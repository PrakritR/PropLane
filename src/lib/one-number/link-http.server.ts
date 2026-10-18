import "server-only";

import { NextResponse } from "next/server";
import { hashPhoneBoundToken, linkSessionCookieName } from "@/lib/one-number/links.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

/** The one body every dead, unknown, used or mismatched link answers with. */
export const LINK_EXPIRED_MESSAGE = "This link has expired.";

export function expiredLinkResponse(): NextResponse {
  return NextResponse.json({ error: LINK_EXPIRED_MESSAGE }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * Throttle a public link endpoint per caller and per token, before anything else runs. A token's
 * bucket is keyed on its hash prefix, never the token itself.
 */
export async function allowLinkRequest(req: Request, token: string, scope: string, perIp = 30, perToken = 20): Promise<boolean> {
  const [byIp, byToken] = await Promise.all([
    rateLimit(`pbl-${scope}-ip:${clientIpFrom(req)}`, perIp, 10 * 60 * 1000),
    rateLimit(`pbl-${scope}-token:${hashPhoneBoundToken(token).slice(0, 32)}`, perToken, 10 * 60 * 1000),
  ]);
  return byIp.ok && byToken.ok;
}

/** Attach a verified-session cookie: httpOnly, secure in production, scoped to this one link. */
export function setLinkSessionCookie(
  response: NextResponse,
  token: string,
  session: { token: string; maxAgeSeconds: number },
): void {
  response.cookies.set(linkSessionCookieName(token), session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: session.maxAgeSeconds,
  });
}
