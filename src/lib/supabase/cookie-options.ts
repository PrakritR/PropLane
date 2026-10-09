/**
 * Auth cookie persistence, pinned explicitly. `@supabase/ssr` defaults to the
 * same 400-day lifetime today; writing it down here means a library bump can
 * never quietly turn the mobile app into a session-cookie app that logs the
 * captain out every time iOS evicts the web view.
 *
 * `secure` is dropped only for plain-http localhost, where browsers refuse to
 * store a Secure cookie at all.
 */
export const SUPABASE_AUTH_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export type SupabaseAuthCookieOptions = {
  path: "/";
  maxAge: number;
  sameSite: "lax";
  secure: boolean;
};

export function supabaseAuthCookieOptions(opts: { secure: boolean }): SupabaseAuthCookieOptions {
  return {
    path: "/",
    maxAge: SUPABASE_AUTH_COOKIE_MAX_AGE_SECONDS,
    sameSite: "lax",
    secure: opts.secure,
  };
}

/** Secure everywhere except plain-http localhost / 127.0.0.1 / ::1. */
export function isSecureAuthContext(
  protocol: string | null | undefined,
  hostname: string | null | undefined,
): boolean {
  const host = (hostname ?? "").toLowerCase();
  const local =
    host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
  if (local && (protocol ?? "").replace(":", "") === "http") return false;
  return true;
}
