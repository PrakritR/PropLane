// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeDashboardPanel from "@/components/marketing/home-dashboard-panel";
import { DEMO_TABS } from "@/components/marketing/site/product-mock/demo-nav";
import { HOME_DASHBOARD_PORTALS } from "@/components/marketing/home-dashboard-data";
// Transform the real dashboard graph before measuring rendering behavior.
import "@/components/marketing/site/product-mock/dashboards";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Marketing panels must never fetch"); });
});
afterEach(async () => {
  cleanup();
  // Sidebar navigation starts real lazy page imports, which outlive unmounting.
  // Finish that graph while jsdom and the no-network guard are still available.
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
}, 30_000);

describe("the guided dashboard uses real fixture panels", () => {
  it.each(HOME_DASHBOARD_PORTALS)("mounts $id without fetching and exposes interactive controls", async ({ id }) => {
    const { container } = render(<HomeDashboardPanel portal={id} />);
    await waitFor(() => {
      expect(container.querySelector(".home-dashboard-panel-loading")).toBeNull();
      expect(container.querySelector(".home-dashboard-window")?.textContent?.length).toBeGreaterThan(40);
    }, { timeout: 15000 });
    expect(container.querySelector(".home-dashboard-window")).not.toHaveAttribute("inert");
    expect(container.textContent).not.toMatch(/work order/i);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["manager", "resident", "vendor"] as const)("switches %s sidebar pages without navigation or fetch", async (portal) => {
    const { container } = render(<HomeDashboardPanel portal={portal} />);
    await waitFor(() => expect(container.querySelector(".home-dashboard-panel-loading")).toBeNull(), { timeout: 15000 });
    const navigation = within(container.querySelector(".rlp-nav") as HTMLElement);
    fireEvent.click(navigation.getByRole("button", { name: "Communication", exact: true }));
    expect(navigation.getByRole("button", { name: "Communication", exact: true })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(container.querySelector(".rlp-panel-frame")?.textContent).toMatch(/Active/), { timeout: 15000 });
    const homeLabel = (DEMO_TABS[portal].find((row) => row.id === "dashboard") ?? DEMO_TABS[portal].find((row) => row.id !== "communication"))!.label;
    fireEvent.click(navigation.getByRole("button", { name: homeLabel, exact: true }));
    expect(navigation.getByRole("button", { name: homeLabel, exact: true })).toHaveAttribute("aria-current", "page");
    expect(fetch).not.toHaveBeenCalled();
  });

});
