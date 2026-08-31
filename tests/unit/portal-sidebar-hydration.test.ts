import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORTAL_SIDEBAR_SOURCE = readFileSync(
  join(process.cwd(), "src/components/portal/portal-sidebar.tsx"),
  "utf8",
);

const PORTAL_NAV_CLIENT_SOURCE = readFileSync(
  join(process.cwd(), "src/lib/portal-nav-client.ts"),
  "utf8",
);

describe("portal sidebar native hydration", () => {
  it("uses useNativeChrome instead of sync Capacitor detect during render", () => {
    expect(PORTAL_SIDEBAR_SOURCE).toContain("useNativeChrome");
    expect(PORTAL_SIDEBAR_SOURCE).not.toContain("detectNativePlatformSync");
  });

  it("keeps mobile chrome in the SSR tree (hidden via html[data-native] CSS)", () => {
    expect(PORTAL_SIDEBAR_SOURCE).toContain("PORTAL_MOBILE_CHROME_CLASS");
    expect(PORTAL_SIDEBAR_SOURCE).not.toContain("!showNativeChrome ?");
  });

  it("only forces full navigation on native bottom tab taps that leave the portal", () => {
    expect(PORTAL_SIDEBAR_SOURCE).toContain("isCrossPortalNavigation(pathname, href)");
    expect(PORTAL_NAV_CLIENT_SOURCE).toContain("preferFullNavigation");
    expect(PORTAL_NAV_CLIENT_SOURCE).toContain("isCrossPortalNavigation");
  });

  it("nests Payments incoming/outgoing links under a Payments parent row", () => {
    expect(PORTAL_SIDEBAR_SOURCE).toContain("subItems:");
    expect(PORTAL_SIDEBAR_SOURCE).toContain("renderPaymentsNavGroup");
    expect(PORTAL_SIDEBAR_SOURCE).toContain("isPaymentSubNavActive");
    expect(PORTAL_SIDEBAR_SOURCE).toContain("paymentsNavExpanded");
    expect(PORTAL_SIDEBAR_SOURCE).toContain('aria-expanded={paymentsNavExpanded}');
  });

  it("the More sheet lists every section, not just overflow (e.g. Documents alongside Finances)", () => {
    expect(PORTAL_SIDEBAR_SOURCE).toContain("orderNativeBottomNavItems(navItems, definition.kind)");
    expect(PORTAL_SIDEBAR_SOURCE).not.toContain("nativeBottomNavSplit.overflow].map");
  });

  it("no longer hosts the assistant as an inline bottom-bar slot", () => {
    expect(PORTAL_SIDEBAR_SOURCE).not.toContain("AxisAssistantNavButton");
    expect(PORTAL_SIDEBAR_SOURCE).not.toContain("useHasAxisAssistant");
  });

  it("pages between primary tabs on a native swipe gesture", () => {
    expect(PORTAL_SIDEBAR_SOURCE).toContain("resolveSwipePageDirection");
    expect(PORTAL_SIDEBAR_SOURCE).toContain("adjacentPrimarySection");
    expect(PORTAL_SIDEBAR_SOURCE).toContain("playSwipeExit");
    expect(PORTAL_SIDEBAR_SOURCE).toContain("playSwipeEnter");
  });

});
