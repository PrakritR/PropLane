import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PORTAL_METRICS_SOURCE = readFileSync(
  join(process.cwd(), "src/components/portal/portal-metrics.tsx"),
  "utf8",
);

const GLOBALS_CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const PORTAL_TOP_BAR_SOURCE = readFileSync(
  join(process.cwd(), "src/components/portal/portal-top-bar.tsx"),
  "utf8",
);

describe("portal mobile shell conventions", () => {
  it("keeps ManagerPortalPageShell header compact on narrow screens", () => {
    expect(PORTAL_METRICS_SOURCE).toContain("PageHeader");
    expect(PORTAL_METRICS_SOURCE).toContain("hideTitleOnNative = false");
    expect(PORTAL_METRICS_SOURCE).toContain("hideTitleOnMobileNav = false");
  });

  it("wraps status pills on mobile instead of scrolling horizontally by default", () => {
    expect(PORTAL_METRICS_SOURCE).toContain("inline-flex max-w-full flex-wrap items-center gap-1 rounded-2xl");
    expect(PORTAL_METRICS_SOURCE).toContain('compact = false');
  });

  it("allows horizontal scroll only for compact status pill strips", () => {
    expect(PORTAL_METRICS_SOURCE).toContain("flex-nowrap");
    expect(PORTAL_METRICS_SOURCE).toContain("overflow-x-auto");
  });

  it("scopes nested scroll panels to desktop only", () => {
    expect(GLOBALS_CSS).toContain(".portal-desktop-scroll-panel");
    expect(GLOBALS_CSS).toContain("@media (min-width: 1024px)");
  });

  it("uses measured bottom nav inset on native main content", () => {
    expect(GLOBALS_CSS).toContain("--portal-mobile-scroll-bottom-inset");
    expect(GLOBALS_CSS).toContain("padding-bottom: var(--portal-mobile-scroll-bottom-inset)");
    expect(GLOBALS_CSS).toContain("scroll-padding-bottom: var(--portal-mobile-scroll-bottom-inset)");
  });

  it("documents native dashboard preview list spacing", () => {
    expect(GLOBALS_CSS).toContain("html[data-native] .portal-preview-list");
    expect(PORTAL_METRICS_SOURCE).toContain("PORTAL_DASHBOARD_STACK");
    expect(PORTAL_METRICS_SOURCE).toContain("PortalDashboardPreviewList");
  });

  it("uses native safe-area top padding on portal main content", () => {
    expect(GLOBALS_CSS).toContain("html[data-native] #portal-main-content");
    expect(GLOBALS_CSS).toContain("padding-top: max(0.25rem, var(--native-safe-top))");
    expect(GLOBALS_CSS).toContain("scroll-padding-top: max(0.25rem, var(--native-safe-top))");
    expect(GLOBALS_CSS).toContain("html[data-native] #portal-main-content:has(.portal-mobile-nav-bar)");
    expect(GLOBALS_CSS).toContain("html[data-native] .portal-mobile-nav-bar");
    expect(GLOBALS_CSS).toContain("min-height: calc(var(--native-safe-top) + 1.5rem)");
  });

  it("pins native bottom nav flush to screen bottom", () => {
    expect(GLOBALS_CSS).toContain("html[data-native] .portal-native-bottom-nav");
    expect(GLOBALS_CSS).toContain("bottom: 0");
    expect(GLOBALS_CSS).toContain("padding-right: max(0.5rem, var(--native-safe-right))");
  });

  it("evenly distributes Instagram-style bottom tabs instead of scrolling", () => {
    expect(GLOBALS_CSS).toContain("html[data-native] .portal-native-bottom-nav-scroll");
    // Grid row — tabs share width evenly without horizontal scroll.
    expect(GLOBALS_CSS).toContain("display: grid");
    expect(GLOBALS_CSS).toContain("html[data-native] .portal-native-bottom-nav-scroll > a");
    expect(GLOBALS_CSS).toContain("html[data-native] .portal-native-bottom-nav-scroll > button");
    expect(GLOBALS_CSS).toContain("min-width: 0");
  });

  it("sizes native bottom tab icons consistently", () => {
    expect(GLOBALS_CSS).toContain("html[data-native] .portal-native-bottom-nav-scroll a svg");
    expect(GLOBALS_CSS).toContain("height: 1.375rem");
    expect(GLOBALS_CSS).toContain("width: 1.375rem");
  });

  it("keeps assistant entry in the floating FAB (plus desktop Ask PropLane), not the bottom nav", () => {
    const AXIS_ASSISTANT_SOURCE = readFileSync(
      join(process.cwd(), "src/components/portal/axis-assistant.tsx"),
      "utf8",
    );
    expect(AXIS_ASSISTANT_SOURCE).not.toContain("AxisAssistantNavButton");
    expect(AXIS_ASSISTANT_SOURCE).toContain("[html[data-native]_&]:bottom-[calc(var(--portal-native-bottom-nav-inset)+0.75rem)]");
    expect(GLOBALS_CSS).toContain(".axis-assistant-fab");
    expect(GLOBALS_CSS).toContain("calc(var(--portal-native-bottom-nav-inset, 0px) + 0.75rem)");
    expect(PORTAL_TOP_BAR_SOURCE).toContain("Ask PropLane");
    expect(PORTAL_TOP_BAR_SOURCE).toContain("hidden");
    expect(PORTAL_TOP_BAR_SOURCE).toContain("lg:flex");
    expect(GLOBALS_CSS).not.toContain(".axis-assistant-nav-btn");
    expect(GLOBALS_CSS).not.toContain(".portal-native-bottom-nav-assistant");
  });

  it("does not sr-only the mobile nav title when the inline band defers to it", () => {
    expect(GLOBALS_CSS).toContain('[data-slot="portal-page-title-band"]:not([data-hide-title-on-mobile-nav])');
    expect(GLOBALS_CSS).toContain("data-hide-title-on-mobile-nav");
  });

  it("hides Next.js dev issue badge on native", () => {
    expect(GLOBALS_CSS).toContain('html[data-native] nextjs-portal');
    expect(GLOBALS_CSS).toContain("display: none !important");
  });

  it("leaves fixed-chrome page shells free to flex on phones", () => {
    // `.portal-main-inner > * { flex: 0 0 auto }` is unlayered, so it beats the
    // Tailwind `flex-1` utility on the page shell. Unscoped, it pinned the shell
    // to its full content height inside the `overflow: hidden`
    // #portal-main-content of every sticky-chrome / Communication surface, so
    // .portal-list-page-scroll never got a bounded height and phone pages taller
    // than the viewport could not scroll below the fold.
    const PAGE_SCROLLS_SCOPE =
      "html:not([data-portal-sticky-chrome]):not([data-communication-surface])";
    expect(GLOBALS_CSS).toContain(`${PAGE_SCROLLS_SCOPE} .portal-main-inner > *`);

    const cssWithoutComments = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const childRules = [
      ...cssWithoutComments.matchAll(/([^{}]*\.portal-main-inner\s*>\s*\*[^{}]*)\{([^{}]*)\}/g),
    ].map((match) => ({ selector: match[1].trim(), declarations: match[2] }));
    const pinnedRules = childRules.filter((rule) =>
      /(^|;)\s*flex\s*:\s*0\s+0\s+auto\s*(;|$)/.test(rule.declarations),
    );

    // Whitespace- and order-insensitive: only the page-scrolls-scoped rule may
    // pin `.portal-main-inner > *` to `flex: 0 0 auto`.
    expect(pinnedRules.length).toBeGreaterThan(0);
    for (const rule of pinnedRules) {
      expect(rule.selector).toContain(PAGE_SCROLLS_SCOPE);
    }
  });

  it("reserves only fixed chrome on clipped surfaces", () => {
    // `#portal-main-content` is `overflow: hidden` on sticky-chrome surfaces, so
    // its padding-bottom can never become trailing scroll room the way it does on
    // a page-scrolls surface — it only shrinks the scroll viewport. The nav bar
    // and an active bulk-action bar are the only fixed elements to reserve.
    const cssWithoutComments = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const declarationsFor = (selector: string) =>
      [...cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((match) =>
          match[1]
            .split(",")
            .some((part) => part.trim().replace(/\s+/g, " ") === selector),
        )
        .map((match) => match[2]);

    // The nav-inset-only rule must exclude the bulk-action-bar case. It is the
    // same specificity as `html[data-bulk-action-bar] #portal-main-content` and
    // sits later in the file, so an unscoped version wins on source order and
    // strips the fixed selection bar's 3.75rem of clearance, stranding the last
    // ledger row underneath it on phone-width Payments / Residents.
    const mainContent = declarationsFor(
      "html[data-portal-sticky-chrome]:not([data-bulk-action-bar]) #portal-main-content",
    );
    const padded = mainContent.filter((d) => /(^|;)\s*padding-bottom\s*:/.test(d));
    expect(padded.length).toBeGreaterThan(0);
    for (const declarations of padded) {
      // Only the bottom nav — never the combined inset that also covers the FAB.
      expect(declarations).toMatch(
        /padding-bottom:\s*var\(--portal-native-bottom-nav-inset[^)]*\)/,
      );
      expect(declarations).not.toContain("--portal-mobile-scroll-bottom-inset");
    }

    // No unscoped sticky-chrome rule may reserve bottom padding — that is the
    // shape that would shadow the bulk bar again.
    expect(
      declarationsFor("html[data-portal-sticky-chrome] #portal-main-content").filter((d) =>
        /(^|;)\s*padding-bottom\s*:/.test(d),
      ),
    ).toHaveLength(0);

    // Bulk bar open: bulk clearance is still reserved.
    const withBulkBar = declarationsFor(
      "html[data-portal-sticky-chrome][data-bulk-action-bar] #portal-main-content",
    ).filter((d) => /(^|;)\s*padding-bottom\s*:/.test(d));
    expect(withBulkBar.length).toBeGreaterThan(0);
    for (const declarations of withBulkBar) {
      expect(declarations).toMatch(
        /padding-bottom:\s*calc\(\s*var\(--portal-native-bottom-nav-inset[^)]*\)\s*\+\s*3\.75rem\s*\)/,
      );
      expect(declarations).not.toContain("--portal-mobile-scroll-bottom-inset");
    }

    const scroller = declarationsFor("html[data-portal-sticky-chrome] .portal-list-page-scroll");
    const scrollerPadded = scroller.filter((d) => /(^|;)\s*padding-bottom\s*:/.test(d));
    expect(scrollerPadded).toHaveLength(0);
  });

  it("drops the duplicate Settings page title behind the mobile app bar", () => {
    const PROFILE_SOURCE = readFileSync(
      join(process.cwd(), "src/components/portal/portal-profile-client.tsx"),
      "utf8",
    );

    const shellTag = PROFILE_SOURCE.match(/<ManagerPortalPageShell\b[\s\S]*?>/);
    expect(shellTag).not.toBeNull();
    expect(shellTag?.[0]).toContain('title="Settings"');
    expect(shellTag?.[0]).toContain("hideTitleOnMobileNav");
  });

  it("hides the admin Settings heading block below the mobile app bar breakpoint", () => {
    const PROFILE_SOURCE = readFileSync(
      join(process.cwd(), "src/components/portal/portal-profile-client.tsx"),
      "utf8",
    );

    const headingWrapper = PROFILE_SOURCE.match(
      /<div className="([^"]*)">\s*<h1 className=\{PORTAL_PAGE_TITLE\}>Settings<\/h1>/,
    );
    expect(headingWrapper).not.toBeNull();
    // The wrapper itself carries `mb-8`, so hiding only its children would leave
    // dead whitespace under the app bar.
    expect(headingWrapper?.[1].split(/\s+/)).toContain("max-md:hidden");
  });

  it("compacts list-footer add rows on mobile and clears bottom nav inset", () => {
    expect(GLOBALS_CSS).toContain(".portal-list-page-body .portal-list-add-row");
    expect(GLOBALS_CSS).toContain(
      "--portal-mobile-scroll-bottom-inset: calc(var(--portal-native-bottom-nav-inset) + 0.75rem)",
    );

    const MODAL_SOURCE = readFileSync(join(process.cwd(), "src/components/ui/modal.tsx"), "utf8");
    expect(MODAL_SOURCE).toContain("env(safe-area-inset-bottom");
  });
});
