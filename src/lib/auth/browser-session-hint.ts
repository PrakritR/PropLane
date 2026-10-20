/** The portal's localStorage note that this browser holds a live session (set by the keepalive, cleared on sign-out). */
const SIGNED_IN_FLAG_KEY = "axis:signed_in";
/** Supabase's session cookie, `sb-<project>-auth-token`, whole or in chunks (`.0`, `.1`, …). */
const SESSION_COOKIE = /(?:^|;\s*)sb-[^=;]+-auth-token(?:\.\d+)?=[^;]/;

/**
 * Whether someone looks signed in on this browser, for public chrome that must never boot Supabase auth (the public
 * bar's Get started / Portal). Reads only the session cookie's presence and the portal's flag: a hint for which link
 * to draw, never authorization (the destination re-checks the session).
 */
export function hasBrowserSessionHint(): boolean {
  if (typeof document === "undefined") return false;
  if (SESSION_COOKIE.test(document.cookie)) return true;
  try {
    return window.localStorage.getItem(SIGNED_IN_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}
