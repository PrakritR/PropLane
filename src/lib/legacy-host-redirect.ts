/**
 * Browser-only redirect off legacy marketing domains to the canonical
 * `proplane.ai` host. Consumed by `src/middleware.ts`.
 *
 * HARD CONSTRAINT (docs/mobile-app.md, docs/agents/deployment-workflow.md,
 * commit fa823048): already-installed iOS/Android shells can still have
 * `prop-lane.space` baked into their native `server.url` (capacitor.config.ts),
 * and `proplane.ai` is not on every old build's `allowNavigation` list. A
 * cross-host 308 for those requests strands the WebView on a permanent black
 * splash (the Sep 24 2026 incident) — there is no way to recover client-side.
 * A domain-level Vercel redirect can't tell a phone's browser tab from that
 * WebView, so this must run in application middleware and read real evidence
 * before ever redirecting a legacy-host GET.
 *
 * Three independent, OR'd signals prove native and suppress the redirect:
 *   1. The request path is the Capacitor native shell's entry path — the one
 *      constant `capacitor.config.ts` uses to build `nativeAppUrl`. An old
 *      binary's very first cold-launch request lands here before any cookie
 *      or distinguishing UA is available.
 *   2. The first-party `proplane_native` cookie NativeBridge sets once JS
 *      confirms the Capacitor bridge is up — covers every navigation after
 *      that first page load.
 *   3. The request's own User-Agent looks like an in-app WebView.
 * Any one of the three is enough; none of them require the others.
 */
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { nativeShellEntryPath } from "@/lib/auth/native-shell-entry";
import { normalizeCrawlHostname } from "@/lib/seo/public-crawl-host";
import { NATIVE_SESSION_MARKER_COOKIE } from "@/lib/native/native-session-marker";

export { NATIVE_SESSION_MARKER_COOKIE };

/**
 * Domains that predate `proplane.ai`. A superset of
 * `capacitor.config.ts`'s `CAPACITOR_ALLOW_NAVIGATION_HOSTS` — that list only
 * needs the hosts an installed shell might actually be pointed at, while this
 * one also covers `proplane.space` (no hyphen), a separate domain no shell has
 * ever loaded, so it carries no native exemption need beyond the ones below.
 */
export const LEGACY_REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  "prop-lane.space",
  "www.prop-lane.space",
  "proplane.space",
  "www.proplane.space",
  "axis-seattle-housing.com",
  "www.axis-seattle-housing.com",
]);

export function isLegacyRedirectHost(hostname: string): boolean {
  return LEGACY_REDIRECT_HOSTS.has(normalizeCrawlHostname(hostname));
}

type HeaderReader = { get(name: string): string | null };

/**
 * True only for a top-level document load (typed URL, link click, bookmark,
 * redirect chain) per the Fetch Metadata request headers modern browsers send.
 * False for `fetch()`/XHR, `<img>`/`<script>`/`<link>` subresource loads, and
 * any client that omits both headers (older browser, curl, a webhook, a cron
 * hit) — omission means "no evidence", never "assume browser".
 */
export function isTopLevelDocumentNavigation(headers: HeaderReader): boolean {
  if (headers.get("sec-fetch-dest") === "document") return true;
  return headers.get("sec-fetch-mode") === "navigate";
}

/**
 * In-app WebView UA heuristic: an iPhone/iPad AppleWebKit UA that dropped the
 * `Safari/` build token real Safari (and a stock WKWebView) always carries, or
 * an explicit Capacitor/app UA token some builds add. Never matches desktop or
 * Android Chrome UAs.
 */
export function isNativeWebViewUserAgent(userAgent: string): boolean {
  if (!userAgent) return false;
  if (/Capacitor/i.test(userAgent)) return true;
  const isIosTouchDevice = /iPad|iPhone|iPod/.test(userAgent);
  const isAppleWebKit = /AppleWebKit/.test(userAgent);
  return isIosTouchDevice && isAppleWebKit && !/Safari\//.test(userAgent);
}

/** The Capacitor native shell's entry path — see `capacitor.config.ts`'s `nativeAppUrl`. */
export function isNativeShellEntryPath(pathname: string): boolean {
  const entry = nativeShellEntryPath();
  return pathname === entry || pathname.startsWith(`${entry}/`);
}

export interface LegacyHostVisitorSignals {
  pathname: string;
  method: string;
  hostname: string;
  headers: HeaderReader;
  hasNativeMarkerCookie: boolean;
}

/**
 * The one decision: redirect this request to `proplane.ai`, or leave it alone.
 * Never redirects `/api/**`, a non-GET/HEAD request (webhooks, cron), a host
 * outside `LEGACY_REDIRECT_HOSTS` (so localhost, `*.vercel.app`, and the
 * staging host are never in scope), a non-navigation request (assets, fetch),
 * or any request carrying native evidence.
 */
export function shouldRedirectLegacyHostVisitor(signals: LegacyHostVisitorSignals): boolean {
  if (signals.pathname.startsWith("/api/")) return false;
  if (signals.method !== "GET" && signals.method !== "HEAD") return false;
  if (!isLegacyRedirectHost(signals.hostname)) return false;
  if (!isTopLevelDocumentNavigation(signals.headers)) return false;
  if (signals.hasNativeMarkerCookie) return false;
  if (isNativeShellEntryPath(signals.pathname)) return false;
  if (isNativeWebViewUserAgent(signals.headers.get("user-agent") ?? "")) return false;
  return true;
}

/** Same path + query, on the canonical host. */
export function legacyHostCanonicalRedirectUrl(pathname: string, search: string): string {
  return `${PRODUCTION_APP_ORIGIN}${pathname}${search}`;
}
