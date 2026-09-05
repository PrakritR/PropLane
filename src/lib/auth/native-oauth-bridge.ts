import { NATIVE_OAUTH_SCHEME } from "@/lib/auth/native-oauth-callback";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Query flag on HTTPS OAuth callbacks opened in the system browser during native sign-in.
 * ANDROID ONLY now: the iOS WebAuthSession path hands Supabase the custom scheme directly and
 * never routes through this HTTPS bridge (see `resolveOAuthCallbackRedirectUrl`). The bridge
 * still runs for older iOS binaries whose stale WebView JS predates that change.
 */
export const NATIVE_OAUTH_BRIDGE_PARAM = "native_bridge";

export function appendNativeOAuthBridgeParam(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(NATIVE_OAUTH_BRIDGE_PARAM, "1");
  return parsed.toString();
}

/** Same OAuth callback URL without the bridge flag — completes sign-in in a normal browser. */
export function httpsCallbackWithoutBridgeParam(callbackUrl: URL): string {
  const parsed = new URL(callbackUrl.toString());
  parsed.searchParams.delete(NATIVE_OAUTH_BRIDGE_PARAM);
  return parsed.toString();
}

/** Map an https /auth/callback URL to the app custom scheme (Capacitor deep link). */
export function httpsCallbackToNativeSchemeUrl(callbackUrl: URL): string {
  const params = new URLSearchParams(callbackUrl.searchParams);
  params.delete(NATIVE_OAUTH_BRIDGE_PARAM);
  const query = params.toString();
  const pathParts = callbackUrl.pathname.replace(/^\//, "").split("/").filter(Boolean);
  const host = pathParts[0] ?? "auth";
  const rest = pathParts.slice(1).join("/");
  const schemePath = rest ? `/${rest}` : "";
  return `${NATIVE_OAUTH_SCHEME}://${host}${schemePath}${query ? `?${query}` : ""}${callbackUrl.hash}`;
}

export function shouldRenderNativeOAuthBridge(request: NextRequest): boolean {
  const userAgent = request.headers.get("user-agent") ?? "";
  // In-app WebView must exchange the code on /auth/callback — never bounce to custom scheme.
  if (/Capacitor/i.test(userAgent)) return false;
  if (request.nextUrl.searchParams.get(NATIVE_OAUTH_BRIDGE_PARAM) !== "1") return false;
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  return Boolean(code || error);
}

/** iOS Safari / SFSafariViewController user agents — never Android's Chrome Custom Tab. */
function isIosUserAgent(userAgent: string): boolean {
  return /iPad|iPhone|iPod/.test(userAgent) && !/Android/.test(userAgent);
}

/**
 * The HTML+JS bridge. This is the ANDROID path (Chrome Custom Tab): it deep-links to the
 * app and, if that fails, offers/auto-loads the web fallback.
 *
 * It is NOT the primary iOS path anymore — the iOS WebAuthSession hands Supabase the custom
 * scheme DIRECTLY, so `ASWebAuthenticationSession` dismisses on Supabase's own 302 and this
 * HTML never renders in that sheet. It still reaches iOS only through an OLDER binary whose
 * stale WebView JS predates that change (or a legacy SFSafariViewController build). For that
 * residual iOS case (defense in depth, per the fix's fix-3): attempt a TOP-LEVEL navigation to
 * the scheme immediately — more reliable than a synthesized anchor click inside the sheet —
 * and NEVER auto-navigate to the web fallback (the `isIos` gate), so the portal is never
 * dumped into in-app Safari.
 */
export function nativeOAuthBridgeResponse(callbackUrl: URL, opts?: { isIos?: boolean }): NextResponse {
  const schemeUrl = httpsCallbackToNativeSchemeUrl(callbackUrl);
  const webFallbackUrl = httpsCallbackWithoutBridgeParam(callbackUrl);
  const isIos = opts?.isIos === true;
  // On iOS the bridge only ever renders inside a legacy build (SFSafariViewController, or a
  // stale WebView bundle). Auto-navigating to the web fallback there loads the whole portal
  // inside in-app Safari — the exact "it's a website" defect. So iOS gets the deep-link
  // attempt + a MANUAL "continue" link only, never the timed fallback.
  const allowAutoWebFallback = !isIos;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Returning to PropLane</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; min-height: 100vh; margin: 0; padding: 1.5rem; background: #080b14; color: #e2e8f0; text-align: center; }
    a { color: #8fb4ff; font-weight: 600; text-decoration: none; }
    a:active { opacity: 0.85; }
    .hint { color: #94a3b8; font-size: 0.95rem; max-width: 20rem; }
  </style>
</head>
<body>
  <p>Returning to PropLane…</p>
  <p class="hint">If the app does not open automatically, continue in your browser below.</p>
  <p><a id="open-app" href="${schemeUrl.replace(/"/g, "&quot;")}">Open PropLane</a></p>
  <p><a id="continue-browser" href="${webFallbackUrl.replace(/"/g, "&quot;")}">Continue in your browser</a></p>
  <script>
    (function () {
      var schemeTarget = ${JSON.stringify(schemeUrl)};
      var webFallback = ${JSON.stringify(webFallbackUrl)};
      var isIos = ${JSON.stringify(isIos)};
      var leftPage = false;
      function markLeft() { leftPage = true; }
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") markLeft();
      });
      window.addEventListener("pagehide", markLeft);
      window.addEventListener("blur", markLeft);
      function openDeepLink() {
        // iOS (legacy binary reaching the bridge): a TOP-LEVEL navigation to the scheme is
        // what ASWebAuthenticationSession intercepts to dismiss the sheet — a synthesized
        // anchor click with no user gesture is unreliable inside it.
        if (isIos) {
          try { window.location.replace(schemeTarget); return; } catch (e0) {}
          try { window.location.href = schemeTarget; return; } catch (e1) {}
        }
        try {
          var link = document.getElementById("open-app");
          if (link) {
            link.click();
            return;
          }
        } catch (e) {}
        try {
          var a = document.createElement("a");
          a.href = schemeTarget;
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
        } catch (e2) {
          try { window.location.href = schemeTarget; } catch (e3) {}
        }
      }
      function continueInBrowser() {
        try { window.location.replace(webFallback); } catch (e) {
          try { window.location.href = webFallback; } catch (e2) {}
        }
      }
      openDeepLink();
      if (${JSON.stringify(allowAutoWebFallback)}) {
        setTimeout(function () {
          if (!leftPage && document.visibilityState === "visible") continueInBrowser();
        }, 1500);
      }
    })();
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export function maybeNativeOAuthBridgeResponse(request: NextRequest): NextResponse | null {
  if (!shouldRenderNativeOAuthBridge(request)) return null;
  const isIos = isIosUserAgent(request.headers.get("user-agent") ?? "");
  return nativeOAuthBridgeResponse(request.nextUrl, { isIos });
}
