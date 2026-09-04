import type { NextRequest } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";

import { getUserOrRejection } from "@/lib/auth/session-rejection";

/**
 * Resolve the signed-in user from SSR cookies, falling back to a Bearer access
 * token.
 *
 * A refusal is logged with its REASON (`session-rejection.ts`). Routes still
 * answer a bare 401 — the reason is for the server log, never the body — but a
 * rejected session is no longer indistinguishable from an expired one, a
 * missing cookie, or a cookie the server could not read. See PRP-259: proving
 * which of those it was previously required minting a token by hand and
 * comparing two servers.
 */
export async function getRequestAuthUser(
  supabase: SupabaseClient,
  req: NextRequest,
): Promise<User | null> {
  const path = (() => {
    try {
      return new URL(req.url).pathname;
    } catch {
      return "request";
    }
  })();

  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  // With a Bearer token present the cookie is only the first of two chances, so
  // a cookie miss is not yet a rejection worth reporting.
  if (bearer) {
    const {
      data: { user: cookieUser },
    } = await supabase.auth.getUser();
    if (cookieUser) return cookieUser;

    const {
      data: { user: tokenUser },
      error,
    } = await supabase.auth.getUser(bearer);
    if (error || !tokenUser) {
      console.warn(
        `[auth] bearer token rejected at ${path}${error?.message ? ` — ${error.message}` : ""}`,
      );
      return null;
    }
    return tokenUser;
  }

  const { user } = await getUserOrRejection(supabase, path);
  return user;
}
