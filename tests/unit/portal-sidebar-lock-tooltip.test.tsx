// @vitest-environment jsdom
//
// An inert locked row has no destination and no visible reason text, so without
// a `title` a SIGHTED resident taps a dead row and learns nothing — the lock
// reason ("Available after your application is approved", "Available after your
// lease is signed") reached assistive tech only. Every resident lock reason must be
// hoverable, not just the new one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/hooks/use-is-native-app", () => ({
  useNativeChrome: () => false,
  useIsSmallPortalViewport: () => false,
}));
vi.mock("@/hooks/use-portal-nav-counts", () => ({ usePortalNavCounts: () => ({}) }));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ email: "resident@example.com", userId: "user-1" }),
}));
vi.mock("@/hooks/use-co-manager-nav-sections", () => ({
  // Mirror the hook's real return shape — the sidebar destructures
  // `{ sections, restrictedSections }`, so handing back a bare array leaves
  // `visibleSections` undefined and the render dies inside a useMemo.
  useCoManagerNavSections: (definition: { sections: unknown[] }) => ({
    sections: definition.sections,
    restrictedSections: new Set<string>(),
  }),
}));
vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => vi.fn(),
  portalNavClick: () => () => {},
  isCrossPortalNavigation: () => false,
  prefetchPortalHref: vi.fn(),
}));
vi.mock("@/lib/portal-nav-prefetch", () => ({
  portalBackgroundPrefetchEnabled: () => false,
  portalMobileLinkPrefetchEnabled: () => false,
}));
vi.mock("@/lib/portal-panel-prefetch", () => ({ prefetchPortalPanelChunks: vi.fn() }));

// jsdom does not implement scrollIntoView; the sidebar calls it to keep the
// mobile strip's active chip centred.
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

const { PortalSidebar } = await import("@/components/portal/portal-sidebar");

const RESIDENT_DEFINITION = {
  kind: "resident",
  basePath: "/resident",
  sections: [
    { section: "dashboard", label: "Dashboard", tabs: [] },
    { section: "applications", label: "Application", tabs: [] },
    { section: "lease", label: "Lease", tabs: [] },
  ],
} as never;

/** The sidebar also renders a mobile strip, so scope every query to the aside. */
function desktopNav() {
  const aside = document.querySelector("aside");
  if (!aside) throw new Error("desktop sidebar did not render");
  return within(aside as HTMLElement);
}

afterEach(cleanup);

describe("inert locked nav rows expose their reason on hover", () => {
  it("puts the lock reason in the tooltip, not only in aria-label", () => {
    render(<PortalSidebar definition={RESIDENT_DEFINITION} residentNavStage="pre_approval" />);

    const reason = "Lease: Available after your application is approved";
    const row = desktopNav().getByRole("link", { name: reason });
    expect(row.tagName.toLowerCase()).toBe("span");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    // Without `title` a sighted resident taps a dead row and learns nothing.
    expect(row.getAttribute("title")).toBe(reason);
  });

  it("carries whatever reason the stage produces, not one hard-coded string", () => {
    render(<PortalSidebar definition={RESIDENT_DEFINITION} residentNavStage="application_submitted" />);

    const row = desktopNav().getByRole("link", { name: /^Lease: / });
    expect(row.getAttribute("title")).toBe(row.getAttribute("aria-label"));
    expect(row.getAttribute("title")).toMatch(/Available after/);
  });

  it("leaves unlocked rows as ordinary links with no lock tooltip", () => {
    render(<PortalSidebar definition={RESIDENT_DEFINITION} residentNavStage="pre_approval" />);

    const row = desktopNav().getByRole("link", { name: "Dashboard" });
    expect(row.tagName.toLowerCase()).toBe("a");
    expect(row.getAttribute("aria-disabled")).toBeNull();
  });
});
