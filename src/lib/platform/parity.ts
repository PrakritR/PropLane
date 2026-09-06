/**
 * Web + native platform parity for Axis.
 *
 * Architecture: one Next.js app serves the browser and the Capacitor shell.
 * The iOS/Android apps load the deployed site in a WebView — portal UI, auth,
 * and API routes are shared. Deploying to Vercel updates both web and app UI.
 *
 * When adding product surfaces, update the registries in this file (and the
 * portal section lists in src/lib/portals/*) so deep links, push taps, and
 * CI checks stay aligned. See docs/web-and-native-parity.md.
 */

/** Paths that load inside the product (browser tab or Capacitor WebView). */
export const IN_APP_PATH_PREFIXES = [
  "/auth/",
  "/resident/",
  "/portal/", // Includes /portal/inspections/{move-in|move-out}/{id}.
  "/admin/",
  "/pro/",
  "/rent/",
  "/partner/",
  "/billing/",
  "/vendor/",
] as const;

/** Exact paths (no trailing segment) that are also in-app. */
export const IN_APP_PATH_EXACT = ["/", "/partner", "/pricing", "/contact", "/tos", "/privacy", "/app"] as const;

/**
 * Push notification tap targets used in server code — keep in sync when adding
 * new notification flows. platform-parity.test.ts validates each entry.
 *
 * Every Communication entry here is a LEGACY folder-tab path that now lands via
 * a `renderPortalSection` redirect — one extra hop, correct destination. Manager
 * / resident / vendor route on a list segment
 * (`/{portal}/communication/{active|unread|archived}`); admin still has real
 * `inbox/*` tabs, so its `email/unopened` entry redirects one hop within admin.
 * Retargeting them is a cross-cutting rename — dashboards, notification
 * builders, `claw-resident-links.ts`, and the e2e specs all mint the same URLs —
 * so change them together or not at all. See AGENTS.md → "Communication is one
 * unified, conversation-based inbox".
 */
export const REGISTERED_PUSH_DEEP_LINKS = [
  "/resident/payments",
  "/resident/dashboard",
  "/resident/applications",
  "/resident/communication/active",
  "/portal/communication/active",
  "/admin/communication/inbox/unopened",
  "/vendor/communication/active",
] as const;

/** Deep-link a message-notification tap into the recipient's own inbox. */
export function inboxDeepLinkForRole(role: string | null | undefined): string {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "manager" || normalized === "pro") return "/portal/communication/active";
  if (normalized === "admin") return "/admin/communication/inbox/unopened";
  if (normalized === "vendor") return "/vendor/communication/active";
  return "/resident/communication/active";
}

export type PlatformSurface = "web" | "native-webview";

/** Both web and native app use the same routes and React components. */
export const SHARED_UI_SURFACES: PlatformSurface[] = ["web", "native-webview"];

export function isInAppPath(pathname: string): boolean {
  if (!pathname.startsWith("/")) return false;
  if (pathname.startsWith("/api/")) return false;
  if ((IN_APP_PATH_EXACT as readonly string[]).includes(pathname)) return true;
  return IN_APP_PATH_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

/** Universal links / custom URL schemes — must stay inside the WebView. */
export function isNativeDeepLinkPath(pathname: string): boolean {
  return isInAppPath(pathname);
}

/**
 * Validates push notification deep links at send time. Throws so bad paths fail
 * tests and stand out in development logs.
 */
export function assertInAppPushPath(pathname: string, context = "push notification"): void {
  const path = pathname.trim();
  if (!path.startsWith("/")) {
    throw new Error(`${context} url must be an in-app path starting with /, got: ${pathname}`);
  }
  if (!isInAppPath(path)) {
    throw new Error(
      `${context} url "${path}" is not registered as an in-app path. Add its prefix to IN_APP_PATH_PREFIXES in src/lib/platform/parity.ts.`,
    );
  }
}

/** Checklist referenced by AGENTS.md and docs/web-and-native-parity.md */
export const PLATFORM_CHANGE_CHECKLIST = [
  "Portal/nav change: update src/lib/portals/* section registry and render-portal-section.tsx",
  "Nav order: registries (pro.ts, admin.ts, resident-sections.ts) are canonical — native bottom bar shows a curated NATIVE_BOTTOM_NAV_*_PRIMARY set from portal-bottom-nav.ts, everything else lives in the swipe-up More sheet",
  "Free-tier gating: update RESIDENT_FREE_TIER_SECTION_IDS or manager-access tier sets",
  "New in-app route: add prefix to IN_APP_PATH_PREFIXES if outside existing portals",
  "Push notification: use assertInAppPushPath and add path to REGISTERED_PUSH_DEEP_LINKS",
  "File upload / camera: use useNativeCamera() (web falls back to file input)",
  "Native-only layout: use html[data-native] / portal-layout-classes.ts safe-area tokens",
  "In-app purchase (iOS): manager subscription buys via StoreKit/RevenueCat in the native plan surface (manager-plan-native.tsx); web keeps Stripe checkout. Never present a web purchase link on native (App Store 3.1.1). RevenueCat webhook (/api/revenuecat/webhook) writes billing='apple' grants — see docs/agents/apple-iap.md",
  "Deploy: Vercel deploy updates web + app UI; run npm run test:unit (platform-parity)",
  "Native shell change only (plugins, icons, permissions incl. @revenuecat/purchases-capacitor): npx cap sync + app store build",
] as const;
