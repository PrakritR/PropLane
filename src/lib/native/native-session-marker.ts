/**
 * First-party marker cookie proving a page load came from inside the Capacitor
 * native shell — read server-side (src/lib/legacy-host-redirect.ts) as one of
 * three signals that a legacy-host request must NOT be bounced to proplane.ai.
 *
 * Cookie, not localStorage/header: it rides along automatically on every
 * same-origin navigation the WebView makes, including the very first server
 * request for a page the client JS hasn't run on yet.
 */
export const NATIVE_SESSION_MARKER_COOKIE = "proplane_native";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/**
 * Called once NativeBridge confirms it is running inside the Capacitor shell.
 * Scoped to the CURRENT host on purpose — an old installed binary may still be
 * pointed at a legacy host (see capacitor.config.ts), and the cookie must ride
 * along on that same host's later requests, never assume proplane.ai.
 */
export function markNativeSession(doc: Document = document): void {
  try {
    const secure = doc.location.protocol === "https:" ? "; Secure" : "";
    doc.cookie = `${NATIVE_SESSION_MARKER_COOKIE}=1; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure}`;
  } catch {
    /* cookie writes can throw in locked-down webviews — never fatal */
  }
}
