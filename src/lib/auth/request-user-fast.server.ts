import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * The identity a READ route needs, taken from the verified access-token claims
 * instead of a GoTrue round trip.
 *
 * `supabase.auth.getUser()` is a network call to the auth server on every API
 * request. `getClaims()` verifies the token's signature locally against the
 * project's cached JWKS (ES256 on this project) and rejects an expired token;
 * it falls back to `getUser(token)` itself for a symmetric (HS256) project, so
 * this stays correct there too, just not faster.
 *
 * SECURITY CONTRACT: claims reflect the TOKEN, not a fresh read of the user.
 * A session that was revoked, a user who was banned or deleted, or a changed
 * `user_metadata` stays "valid" here until the access token expires. That is
 * acceptable for reading the caller's own data and NOT acceptable for a write.
 * So this is for GET/HEAD handlers only: every POST/PUT/PATCH/DELETE keeps
 * `getUser()`. `tests/unit/request-user-fast.test.ts` fails a mutating export
 * that calls this or passes `fast: true`.
 *
 * Fails closed: any error, a missing/invalid `sub`, or a thrown exception
 * returns null. Callers treat null as "not proven" and fall back to `getUser()`
 * (which then decides 401 or not), never as "allowed".
 *
 * Refreshed cookies: with no jwt argument `getClaims()` reads the session via
 * `getSession()`, the same path `getUser()` takes, so an expired access token
 * is refreshed and the cookies are written through the server client's
 * `setAll` exactly as before.
 */
export type FastRequestUser = Pick<User, "id" | "email" | "user_metadata" | "app_metadata" | "role">;

export async function getRequestUserFast(supabase: SupabaseClient): Promise<FastRequestUser | null> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    const claims = data.claims;
    const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
    if (!sub) return null;
    return {
      id: sub,
      email: typeof claims.email === "string" ? claims.email : undefined,
      user_metadata: (claims.user_metadata ?? {}) as FastRequestUser["user_metadata"],
      app_metadata: (claims.app_metadata ?? {}) as FastRequestUser["app_metadata"],
      role: typeof claims.role === "string" ? claims.role : undefined,
    };
  } catch {
    return null;
  }
}

/** True for the request methods that may use the fast path. */
export function isReadMethod(method: string | undefined | null): boolean {
  const m = (method ?? "").toUpperCase();
  return m === "GET" || m === "HEAD";
}
