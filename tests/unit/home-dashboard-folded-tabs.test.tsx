// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeDashboardPanel from "@/components/marketing/home-dashboard-panel";
import { DEMO_TABS } from "@/components/marketing/site/product-mock/demo-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/marketing/site/product-mock/demo-panels", () => ({ DemoPanel: ({ tab, onNavigate }: { tab: string; onNavigate: (tab: string) => void }) => <div data-testid="fixture-page">{tab}<button onClick={() => onNavigate("financials")}>Open finances shortcut</button></div> }));
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Fixture navigation must never fetch"); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// The homepage demo draws the REAL portal sidebar (one row per section, the original nav), not folded rows.
describe("homepage demo follows the original portal sidebar", () => {
  it.each([
    { portal: "manager" as const, section: "leases", label: "Leases" },
    { portal: "vendor" as const, section: "financials", label: "Finances" },
    { portal: "resident" as const, section: "lease", label: "Lease" },
  ])("opens $portal $section from its own sidebar row, with no section tab strip", async ({ portal, section, label }) => {
    const { container } = render(<HomeDashboardPanel portal={portal} />);
    await screen.findByTestId("fixture-page");
    expect(DEMO_TABS[portal].some((tab) => tab.id === section)).toBe(true);
    const sidebar = within(container.querySelector(".rlp-nav") as HTMLElement);
    fireEvent.click(sidebar.getByRole("button", { name: label, exact: true }));
    await waitFor(() => expect(screen.getByTestId("fixture-page")).toHaveTextContent(section));
    expect(sidebar.getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    expect(container.querySelector("[data-portal-section-tabs]")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a dashboard shortcut moves the active sidebar row", async () => {
    const { container } = render(<HomeDashboardPanel portal="manager" />);
    fireEvent.click(await screen.findByRole("button", { name: "Open finances shortcut" }));
    expect(within(container.querySelector(".rlp-nav") as HTMLElement).getByRole("button", { name: "Finances", exact: true })).toHaveAttribute("aria-current", "page");
    expect(fetch).not.toHaveBeenCalled();
  });
});
