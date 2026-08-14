import {
  buildNativeOAuthNavigationUrl,
  nativeOAuthSignInFailureUrl,
  resolveNativeOAuthCallbackTarget,
} from "@/lib/auth/complete-native-oauth";
import {
  appendOAuthContextToCallbackPath,
  completeNativeOAuthInWebView,
} from "@/lib/auth/complete-native-oauth-client";
import {
  NATIVE_OAUTH_SCHEME,
  webPathFromNativeOAuthUrl,
  isNativeOAuthShell,
} from "@/lib/auth/native-oauth-callback";
import {
  NATIVE_IOS_OAUTH_NO_WINDOW_MESSAGE,
  NATIVE_IOS_OAUTH_REBUILD_MESSAGE,
  NATIVE_IOS_OAUTH_START_FAILED_MESSAGE,
  NATIVE_OAUTH_GENERIC_FAILURE_MESSAGE,
  nativeOAuthNoReturnMessage,
  nativeOAuthUnexpectedCallbackMessage,
} from "@/lib/auth/oauth-failure-messages";
import { usesIosAsWebAuthenticationSession } from "@/lib/native/ios-oauth";
import { detectNativePlatformSync } from "@/lib/native/detect-native";
import { WebAuthSession } from "@/lib/native/web-auth-session";

export const NATIVE_OAUTH_IN_PROGRESS_KEY = "axis_oauth_in_progress";

export {
  NATIVE_IOS_OAUTH_REBUILD_MESSAGE,
  NATIVE_IOS_OAUTH_NO_WINDOW_MESSAGE,
  NATIVE_IOS_OAUTH_START_FAILED_MESSAGE,
};

/**
 * `WebAuthSessionPlugin` rejection codes that mean nothing was ever presented, mapped to the
 * user-facing copy shown for each.
 */
const NATIVE_IOS_OAUTH_PREFLIGHT_MESSAGES = new Map<string, string>([
  ["NO_ANCHOR", NATIVE_IOS_OAUTH_NO_WINDOW_MESSAGE],
  ["START_FAILED", NATIVE_IOS_OAUTH_START_FAILED_MESSAGE],
]);

/**
 * The native shell cannot run this OAuth flow at all — nothing was opened and the WebView is
 * still sitting on the sign-in screen.
 *
 * This is a PRE-FLIGHT failure, so it is thrown back to the caller to render in place rather
 * than delivered by navigating to `/auth/sign-in?error=oauth&message=…`. That navigation is
 * what a user experiences as the page "just refreshing and going back": it reloads the screen,
 * throws away anything typed, and — because `/auth/sign-in` renders `NativeAuthHub`, which did
 * not read those params — dropped the explanation entirely. Post-flight failures (the OAuth
 * sheet came back with an error, a deep link arrived while the app was backgrounded) still
 * travel by navigation; see `navigateToNativeOAuthFailure`.
 */
export class NativeOAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeOAuthUnavailableError";
  }
}

/**
 * iOS or Android? Prefers the live Capacitor bridge, then the `data-native` tag set in
 * <head>. Unknown-but-native resolves to null so callers can pick the safer (iOS) path.
 */
function resolveNativeOAuthPlatform(): "ios" | "android" | null {
  const platform = detectNativePlatformSync();
  if (platform === "ios" || platform === "android") return platform;
  if (typeof document !== "undefined") {
    const tagged = document.documentElement.getAttribute("data-native");
    if (tagged === "ios" || tagged === "android") return tagged;
  }
  return null;
}
const NATIVE_OAUTH_CALLBACK_CODE_KEY = "axis_oauth_callback_code";

const PORTAL_PATH_PREFIXES = ["/portal", "/resident", "/admin", "/auth/choose-portal"] as const;

function isPortalDestinationPath(pathname: string): boolean {
  return PORTAL_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Non-reversible fingerprint of the OAuth callback code — only used to detect a
 * duplicate callback delivery, never to recover the code, so we avoid persisting
 * the single-use authorization code itself in cleartext sessionStorage.
 */
function fingerprintOAuthCode(code: string): string {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = (Math.imul(hash, 31) + code.charCodeAt(i)) | 0;
  }
  return `${code.length}.${(hash >>> 0).toString(36)}`;
}

async function redirectSignedInUserToContinue(): Promise<boolean> {
  try {
    const { createSupabaseBrowserClient } = await import("@/lib/supabase/browser");
    const { waitForOAuthUser } = await import("@/lib/auth/wait-for-oauth-user");
    const supabase = createSupabaseBrowserClient();
    const user = await waitForOAuthUser(supabase, { attempts: 5, delayMs: 120 });
    if (!user) return false;
    window.location.replace("/auth/continue");
    return true;
  } catch {
    return false;
  }
}

/** Open a URL in the WebView on web; native uses the system in-app browser when needed. */
export function isNativeAppShell(): boolean {
  return isNativeOAuthShell();
}

/** Stripe Connect onboarding — popups fail in mobile WebViews; navigate in-place. */
export function shouldUseInAppConnectFlow(): boolean {
  return isNativeAppShell();
}

/** Supabase OAuth lands on /auth/callback or /auth/callback/... */
export function isAuthCallbackUrl(url: string): boolean {
  if (webPathFromNativeOAuthUrl(url, "https://local") !== null) return true;
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/auth/callback" || parsed.pathname.startsWith("/auth/callback/");
  } catch {
    return /\/auth\/callback(\/|$|\?)/.test(url);
  }
}

function markNativeOAuthInProgress(): void {
  try {
    sessionStorage.setItem(NATIVE_OAUTH_IN_PROGRESS_KEY, "1");
    sessionStorage.removeItem(NATIVE_OAUTH_CALLBACK_CODE_KEY);
  } catch {
    /* ignore */
  }
}

export function clearNativeOAuthInProgress(): void {
  try {
    sessionStorage.removeItem(NATIVE_OAUTH_IN_PROGRESS_KEY);
    sessionStorage.removeItem(NATIVE_OAUTH_CALLBACK_CODE_KEY);
  } catch {
    /* ignore */
  }
}

export function isNativeOAuthInProgress(): boolean {
  try {
    return sessionStorage.getItem(NATIVE_OAUTH_IN_PROGRESS_KEY) === "1";
  } catch {
    return false;
  }
}

function navigateToNativeOAuthCallback(pathAndQuery: string): void {
  try {
    const parsed = new URL(pathAndQuery, window.location.origin);
    const code = parsed.searchParams.get("code");
    if (code) {
      const fingerprint = fingerprintOAuthCode(code);
      const seen = sessionStorage.getItem(NATIVE_OAUTH_CALLBACK_CODE_KEY);
      if (seen === fingerprint) {
        const path = window.location.pathname;
        if (isPortalDestinationPath(path) || path.startsWith("/auth/continue")) return;
        void redirectSignedInUserToContinue();
        return;
      }
      sessionStorage.setItem(NATIVE_OAUTH_CALLBACK_CODE_KEY, fingerprint);
    }
  } catch {
    /* ignore */
  }

  void (async () => {
    const result = await completeNativeOAuthInWebView(pathAndQuery);
    clearNativeOAuthInProgress();
    if (result.ok) {
      window.location.replace(result.redirectTo);
      return;
    }

    if (result.fallbackPath) {
      const destination = buildNativeOAuthNavigationUrl(
        appendOAuthContextToCallbackPath(result.fallbackPath, window.location.origin),
        window.location.origin,
      );
      window.location.href = destination;
      return;
    }

    navigateToNativeOAuthFailure(result.error);
  })();
}

function navigateToNativeOAuthFailure(message: string): void {
  clearNativeOAuthInProgress();
  window.location.href = nativeOAuthSignInFailureUrl(message, window.location.origin);
}

async function tryLaunchUrlOAuthComplete(
  getLaunchUrl: () => Promise<{ url: string } | undefined>,
): Promise<boolean> {
  try {
    const launch = await getLaunchUrl();
    if (!launch?.url) return false;
    const pathAndQuery = resolveNativeOAuthCallbackTarget(launch.url, window.location.origin);
    if (!pathAndQuery) return false;
    navigateToNativeOAuthCallback(pathAndQuery);
    return true;
  } catch {
    return false;
  }
}

function finishNativeOAuthFromRawUrl(rawUrl: string): boolean {
  const pathAndQuery = resolveNativeOAuthCallbackTarget(rawUrl, window.location.origin);
  if (!pathAndQuery) return false;

  const parsed = new URL(pathAndQuery, window.location.origin);
  if (parsed.searchParams.get("error")) {
    const message =
      parsed.searchParams.get("error_description")?.replace(/\+/g, " ").trim() ||
      NATIVE_OAUTH_GENERIC_FAILURE_MESSAGE;
    navigateToNativeOAuthFailure(message);
    return true;
  }

  navigateToNativeOAuthCallback(pathAndQuery);
  return true;
}

/**
 * Google OAuth in the native shell — WKWebView is blocked (403 disallowed_useragent).
 * iOS: ASWebAuthenticationSession intercepts the custom-scheme callback natively — a
 *   system-managed sheet, NOT SFSafariViewController. SFSafariViewController is never
 *   used for OAuth on iOS: it renders PropLane's own pages inside an in-app Safari
 *   browser (URL bar + Safari toolbar), which is exactly the "it's a website, not an
 *   app" defect we are eliminating.
 * Android: Chrome Custom Tab + HTTPS bridge redirect back to the app.
 */
export async function openOAuthUrl(url: string): Promise<void> {
  if (!url) return;
  if (!isNativeAppShell()) {
    window.location.assign(url);
    return;
  }

  // Anything not positively identified as Android takes the iOS path — the stricter
  // one, which never opens SFSafariViewController.
  //
  // There is deliberately no `isPluginAvailable` pre-flight here any more. It gated the whole
  // flow on a probe that answers false for "not registered YET" as well as "not in this
  // binary" — `WebAuthSessionPlugin` is attached at runtime by `BridgeViewController` — and a
  // false negative dead-ended sign-in with an "update the app" message on a fresh install.
  // A genuinely missing plugin now surfaces from the `authenticate()` call itself, which is the
  // only source that can tell the difference.
  if (resolveNativeOAuthPlatform() !== "android") {
    await openOAuthUrlWithWebAuthSession(url);
    return;
  }

  await openOAuthUrlWithSystemBrowser(url);
}

async function openOAuthUrlWithWebAuthSession(oauthUrl: string): Promise<void> {
  markNativeOAuthInProgress();
  try {
    const { url: callbackUrl } = await WebAuthSession.authenticate({
      url: oauthUrl,
      callbackScheme: NATIVE_OAUTH_SCHEME,
    });
    if (!finishNativeOAuthFromRawUrl(callbackUrl)) {
      navigateToNativeOAuthFailure(nativeOAuthUnexpectedCallbackMessage());
    }
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : "";
    if (code === "CANCELED") {
      clearNativeOAuthInProgress();
      return;
    }
    // The binary really does not carry `WebAuthSessionPlugin`, so Capacitor rejected the call
    // rather than the plugin rejecting it. This is the ONE place that can tell that apart from
    // "the probe ran too early", which is why the update hint lives here now instead of in a
    // pre-flight gate that dead-ended sign-in for everyone it guessed wrong about.
    if (code === "UNIMPLEMENTED" || code === "UNAVAILABLE") {
      clearNativeOAuthInProgress();
      throw new NativeOAuthUnavailableError(NATIVE_IOS_OAUTH_REBUILD_MESSAGE);
    }
    // Every code in this map means the plugin never presented anything — no window to anchor
    // to (NO_ANCHOR), bad arguments or `session.start()` returning false (START_FAILED). Those
    // are PRE-FLIGHT failures like the missing-plugin case: throw them back for the caller to
    // render in place instead of reloading the WebView, and never surface the plugin's own
    // developer-phrased reason. A new plugin rejection is pre-flight only by being listed here.
    const preflightMessage = NATIVE_IOS_OAUTH_PREFLIGHT_MESSAGES.get(code);
    if (typeof preflightMessage === "string") {
      clearNativeOAuthInProgress();
      throw new NativeOAuthUnavailableError(preflightMessage);
    }
    const message = error instanceof Error ? error.message : NATIVE_OAUTH_GENERIC_FAILURE_MESSAGE;
    navigateToNativeOAuthFailure(message);
  }
}

/**
 * ANDROID ONLY. Opens the OAuth URL in the system browser (Chrome Custom Tabs) and
 * deep-links back via the HTTPS bridge. Never call this on iOS — `@capacitor/browser`
 * there is SFSafariViewController, the in-app Safari that must never render PropLane.
 */
async function openOAuthUrlWithSystemBrowser(url: string): Promise<void> {
  markNativeOAuthInProgress();
  const { Browser } = await import("@capacitor/browser");
  const { App } = await import("@capacitor/app");

  let settled = false;
  const cleanups: Array<() => void> = [];

  const completeFromRawUrl = (rawUrl: string): boolean => {
    const pathAndQuery = resolveNativeOAuthCallbackTarget(rawUrl, window.location.origin);
    if (!pathAndQuery) return false;
    if (settled) return true;
    settled = true;
    cleanups.forEach((fn) => fn());
    void Browser.close().catch(() => {});
    return finishNativeOAuthFromRawUrl(rawUrl) || true;
  };

  const appUrlListener = await App.addListener("appUrlOpen", (event) => {
    if (!event.url) return;
    completeFromRawUrl(event.url);
  });
  cleanups.push(() => void appUrlListener.remove());

  const resumeListener = await App.addListener("resume", () => {
    if (settled) return;
    void tryLaunchUrlOAuthComplete(() => App.getLaunchUrl()).then((handled) => {
      if (handled) {
        settled = true;
        cleanups.forEach((fn) => fn());
      }
    });
  });
  cleanups.push(() => void resumeListener.remove());

  const finished = await Browser.addListener("browserFinished", () => {
    if (settled) return;
    void (async () => {
      if (await tryLaunchUrlOAuthComplete(() => App.getLaunchUrl())) {
        settled = true;
        cleanups.forEach((fn) => fn());
        await Browser.close().catch(() => {});
        return;
      }

      // appUrlOpen / client exchange may still be running — wait before failing.
      for (let attempt = 0; attempt < 30; attempt++) {
        if (settled) return;
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        const path = window.location.pathname;
        if (isPortalDestinationPath(path)) {
          settled = true;
          cleanups.forEach((fn) => fn());
          clearNativeOAuthInProgress();
          return;
        }
        if (path.startsWith("/auth/callback") || path.startsWith("/auth/continue")) {
          continue;
        }
        try {
          const { createSupabaseBrowserClient } = await import("@/lib/supabase/browser");
          const { waitForOAuthUser } = await import("@/lib/auth/wait-for-oauth-user");
          const supabase = createSupabaseBrowserClient();
          const user = await waitForOAuthUser(supabase, { attempts: 1, delayMs: 0 });
          if (user) {
            const oauthCode = sessionStorage.getItem(NATIVE_OAUTH_CALLBACK_CODE_KEY);
            if (oauthCode) {
              // appUrlOpen started the callback exchange — wait for it to route.
              continue;
            }
            settled = true;
            cleanups.forEach((fn) => fn());
            clearNativeOAuthInProgress();
            window.location.replace("/auth/continue");
            return;
          }
        } catch {
          /* retry */
        }
      }

      if (settled) return;
      const path = window.location.pathname;
      if (path.startsWith("/auth/callback") || path.startsWith("/auth/continue")) {
        clearNativeOAuthInProgress();
        return;
      }

      if (await redirectSignedInUserToContinue()) {
        settled = true;
        cleanups.forEach((fn) => fn());
        clearNativeOAuthInProgress();
        return;
      }

      settled = true;
      cleanups.forEach((fn) => fn());
      navigateToNativeOAuthFailure(nativeOAuthNoReturnMessage());
    })();
  });
  cleanups.push(() => void finished.remove());

  await Browser.open({ url, presentationStyle: "fullscreen" });
}

/** Handle OAuth/universal-link return when the app is already running. */
export async function handleNativeOAuthReturnUrl(rawUrl: string): Promise<boolean> {
  if (!isNativeAppShell() || !rawUrl) return false;
  if (!resolveNativeOAuthCallbackTarget(rawUrl, window.location.origin)) return false;

  const { Browser } = await import("@capacitor/browser");
  await Browser.close().catch(() => {});

  return finishNativeOAuthFromRawUrl(rawUrl);
}

/** External https links on native (Stripe Connect, etc.) — in-app browser, not WKWebView. */
export async function openAppUrl(url: string): Promise<void> {
  if (!url) return;
  if (!isNativeAppShell()) {
    window.location.assign(url);
    return;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) {
    const { Browser } = await import("@capacitor/browser");
    await Browser.open({ url, presentationStyle: "fullscreen" });
    return;
  }
  window.location.assign(url);
}
