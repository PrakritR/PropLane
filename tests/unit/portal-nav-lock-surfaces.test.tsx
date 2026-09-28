// @vitest-environment jsdom
//
// The lock split has to survive at the RENDER layer, not just in
// `portalNavLockKind`. An inert lock must be a dead affordance; an upsell lock
// must still be a live link to the PortalTierPaywall upgrade page.
//
// This drives the native More sheet, the surface where the regression was
// worst: it rendered a live <Link> for locked rows in the mobile top strip
// (navigate, then get server-redirected home — a tab that looks broken) while
// the desktop sidebar rendered a dead <span> for manager upsell rows.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/hooks/use-is-native-app", () => ({ useNativeChrome: () => false }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/dashboard",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/portal-nav-prefetch", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/portal-nav-prefetch")>(),
  portalMobileLinkPrefetchEnabled: () => false,
}));
vi.mock("@/lib/portal-nav-client", () => ({
  isCrossPortalNavigation: () => false,
  portalNavClick: () => () => {},
}));

const { PortalNativeMoreSheet } = await import("@/components/portal/portal-native-more-sheet");

function renderSheet(items: Parameters<typeof PortalNativeMoreSheet>[0]["items"]) {
  return render(
    <PortalNativeMoreSheet
      open
      onOpenChange={() => {}}
      items={items}
      kind="manager"
      activeSection="dashboard"
      showNavIcons={false}
    />,
  );
}

afterEach(cleanup);

describe("More sheet honours the lock split", () => {
  it("an upsell lock stays a live link to its section (the upgrade page)", () => {
    renderSheet([
      { section: "leases", label: "Leases", href: "/portal/leases", locked: true, lockedNavigable: true },
    ]);
    const row = screen.getByRole("link", { name: /Leases \(locked\)/ });
    expect(row.getAttribute("href")).toBe("/portal/leases");
    expect(row.getAttribute("aria-disabled")).toBeNull();
  });

  it("an inert lock goes nowhere and is marked disabled", () => {
    renderSheet([
      { section: "lease", label: "Lease", href: "/resident/lease", locked: true },
    ]);
    const row = screen.getByRole("link", { name: /Lease \(locked\)/ });
    expect(row.getAttribute("href")).toBe("#");
    expect(row.getAttribute("aria-disabled")).toBe("true");
  });

  it("an unlocked row is an ordinary live link", () => {
    renderSheet([{ section: "dashboard", label: "Dashboard", href: "/portal/dashboard" }]);
    const row = screen.getByRole("link", { name: "Dashboard" });
    expect(row.getAttribute("href")).toBe("/portal/dashboard");
    expect(row.getAttribute("aria-disabled")).toBeNull();
  });
});
