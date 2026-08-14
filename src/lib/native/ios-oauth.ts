import { detectNativePlatformSync } from "@/lib/native/detect-native";

/**
 * iOS native OAuth uses ASWebAuthenticationSession instead of SFSafariViewController.
 *
 * The ONE gate for that decision: `resolveOAuthCallbackRedirectUrl` picks `redirect_to` with it
 * and `openOAuthUrl` picks the transport with it, and those two must never disagree. Reads the
 * injected `window.Capacitor` global the same way `detectNativePlatformSync` does rather than
 * importing `@capacitor/core`, so the `/auth/callback*` server route handlers — which reach this
 * module through `native-oauth-callback` — never pull the browser-only Capacitor SDK into the
 * server bundle.
 *
 * This used to additionally require `Capacitor.isPluginAvailable("WebAuthSession")`, and a FALSE
 * answer there sent the user to "Google sign-in needs the latest version of the PropLane app" —
 * on a fresh install, which reads as a broken app and is an automatic App Review rejection
 * (2.1 App Completeness, "we received an error message after we attempted to log in").
 *
 * That probe is not trustworthy as a gate. `WebAuthSessionPlugin` is attached at runtime by
 * `BridgeViewController` via `registerPluginInstance`, so a negative answer can mean "not
 * registered YET" rather than "not in this binary" — and the cost of a false negative is a dead
 * sign-in screen, while the cost of assuming capability is one rejected promise we can handle.
 * Every iOS binary has shipped the plugin since 2026-07-30, so iOS now implies
 * ASWebAuthenticationSession, and a genuinely missing plugin is caught where it actually shows
 * up: the `authenticate()` call in `openOAuthUrl`, which maps an unimplemented rejection back to
 * the same update hint.
 */
export function usesIosAsWebAuthenticationSession(): boolean {
  if (typeof window === "undefined") return false;
  return detectNativePlatformSync() === "ios";
}
