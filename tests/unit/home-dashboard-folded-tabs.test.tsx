// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeDashboardPanel from "@/components/marketing/home-dashboard-panel";
import { DEMO_TABS } from "@/components/marketing/site/product-mock/demo-nav";
import { navSectionTabsFor } from "@/lib/portals/nav-groups";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/marketing/site/product-mock/demo-panels", () => ({ DemoPanel: ({ tab, onNavigate }: { tab: string; onNavigate: (tab: string) => void }) => <div data-testid="fixture-page">{tab}<button onClick={() => onNavigate("financials")}>Open finances shortcut</button></div> }));
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Fixture navigation must never fetch"); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("homepage folded portal sections", () => {
  it.each([
    { portal: "manager" as const, row: "Leasing", section: "leases", label: "Leases" },
    { portal: "vendor" as const, row: "Money", section: "financials", label: "Finances" },
    { portal: "resident" as const, row: "My home", section: "lease", label: "Lease" },
  ])("opens $portal $section through the canonical $row tabs", async ({ portal, row, section, label }) => {
    const { container } = render(<HomeDashboardPanel portal={portal} />);
    await screen.findByTestId("fixture-page");
    const sidebar = within(container.querySelector(".rlp-nav") as HTMLElement);
    fireEvent.click(sidebar.getByRole("button", { name: row, exact: true }));
    const strip = container.querySelector("[data-portal-section-tabs]") as HTMLElement;
    const group = navSectionTabsFor(portal, section, DEMO_TABS[portal].flatMap((tab) => tab.members))!;
    expect([...strip.querySelectorAll("button[data-attr]")].map((button) => button.getAttribute("data-attr"))).toEqual(group.sections.map((id) => `section-tab-${id}`));
    fireEvent.click(strip.querySelector(`[data-attr="section-tab-${group.sections[0]}"]`)!);
    expect(screen.getByTestId("fixture-page")).toHaveTextContent(group.sections[0]!);
    fireEvent.click(within(strip).getByRole("button", { name: label, exact: true }));
    await waitFor(() => expect(screen.getByTestId("fixture-page")).toHaveTextContent(section));
    expect(within(strip).getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    expect(sidebar.getByRole("button", { name: row, exact: true })).toHaveAttribute("aria-current", "page");
    expect(strip.querySelector("a")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a dashboard shortcut changes both the strip and the active folded sidebar row", async () => {
    const { container } = render(<HomeDashboardPanel portal="manager" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open finances shortcut" }));
    expect(container.querySelector('[data-fold-section="financials"]')).not.toBeNull();
    expect(within(container.querySelector(".rlp-nav") as HTMLElement).getByRole("button", { name: "Money", exact: true })).toHaveAttribute("aria-current", "page");
    expect(fetch).not.toHaveBeenCalled();
  });
});
