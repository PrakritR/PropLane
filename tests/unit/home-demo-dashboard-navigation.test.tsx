// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoPanel } from "@/components/marketing/site/product-mock/demo-panels";
import { DEMO_TABS } from "@/components/marketing/site/product-mock/demo-nav";
import { residentStory } from "@/components/marketing/site/product-mock/world";
import { ResidentPlacementBody } from "@/components/marketing/site/product-mock/demo-popups-resident";
import { InertDemoLinks } from "@/components/marketing/site/product-mock/shared";
// Warm the dynamic graph before measuring interaction.
import "@/components/marketing/site/product-mock/dashboards";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
beforeEach(() => { vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Preview must not fetch"); }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("dashboard navigation stays inside the fixture frame", () => {
  it.each(["manager", "resident", "vendor"] as const)("%s links use local fragments and navigate once to real sidebar sections", async (portal) => {
    const onNavigate = vi.fn();
    const { container } = render(<DemoPanel portal={portal} tab="dashboard" story={residentStory("pay")} onNavigate={onNavigate} />);
    await waitFor(() => expect(container.querySelectorAll("a").length).toBeGreaterThan(2), { timeout: 15000 });
    const allowed = DEMO_TABS[portal].flatMap((tab) => tab.members);
    for (const anchor of container.querySelectorAll("a")) {
      expect(anchor.getAttribute("href")).toMatch(/^#/);
      onNavigate.mockClear();
      fireEvent.click(anchor);
      expect(onNavigate).toHaveBeenCalledTimes(1);
      expect(allowed).toContain(onNavigate.mock.calls[0]![0]);
    }
    const actionSelector = portal === "manager" ? '[data-attr="dashboard-create"]' : portal === "vendor" ? '[data-attr="vendor-dashboard-add"], [data-attr="vendor-dashboard-job-card"]' : null;
    if (actionSelector) expect(container.querySelectorAll(actionSelector).length).toBeGreaterThan(portal === "vendor" ? 1 : 0);
    if (actionSelector) for (const button of container.querySelectorAll(actionSelector)) {
      onNavigate.mockClear();
      fireEvent.click(button);
      expect(onNavigate).toHaveBeenCalledWith(portal === "manager" ? "properties" : "work-orders");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps links harmless when the older caller supplies no navigation callback", async () => {
    const { container } = render(<DemoPanel portal="vendor" tab="dashboard" />);
    await waitFor(() => expect(container.querySelector("a")).not.toBeNull(), { timeout: 15000 });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    container.querySelector("a")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes resident placement checklist links locally without exposing live portal URLs", () => {
    const onNavigate = vi.fn();
    const { container } = render(<InertDemoLinks onNavigate={onNavigate}><ResidentPlacementBody checklist={[
      { label: "Lease signed", done: true },
      { label: "Move-in charges paid", done: true },
      { label: "Move-in inspection photographed", done: false },
    ]} /></InertDemoLinks>);
    for (const anchor of container.querySelectorAll("a")) {
      expect(anchor.getAttribute("href")).toMatch(/^#demo\//);
      fireEvent.click(anchor);
    }
    expect(onNavigate.mock.calls.map(([section]) => section)).toEqual(["lease", "payments", "move-in"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
