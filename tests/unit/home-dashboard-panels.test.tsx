// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomeDashboardPanel from "@/components/marketing/home-dashboard-panel";
import { HOME_DASHBOARD_PORTALS } from "@/components/marketing/home-dashboard-data";
// Transform the real dashboard graph before measuring rendering behavior.
import "@/components/marketing/site/product-mock/dashboards";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Marketing panels must never fetch"); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the guided dashboard uses real fixture panels", () => {
  it.each(HOME_DASHBOARD_PORTALS)("mounts $id without fetching or exposing hidden interactive controls", async ({ id }) => {
    const { container } = render(<HomeDashboardPanel portal={id} />);
    await waitFor(() => {
      expect(container.querySelector(".home-dashboard-panel-loading")).toBeNull();
      expect(container.querySelector(".home-dashboard-window")?.textContent?.length).toBeGreaterThan(40);
    }, { timeout: 15000 });
    expect(container.querySelector(".home-dashboard-window")).toHaveAttribute("inert");
    expect(container.textContent).not.toMatch(/work order/i);
    expect(fetch).not.toHaveBeenCalled();
  });
});
