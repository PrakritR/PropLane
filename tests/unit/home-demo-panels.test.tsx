// @vitest-environment jsdom
//
// The home demo draws one fixture-fed panel for every portal tab. This renders
// each DEMO_TABS entry for each portal and asserts it mounts, says something,
// never says "work order" (user-facing copy is "service"), and never fetches.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DEMO_TABS, DemoPanel, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

afterEach(cleanup);

let fetchSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // The list band logs (never throws) when a panel breaks its icon / primary-label contract.
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  fetchSpy = vi.spyOn(global, "fetch" as never).mockImplementation(() => {
    throw new Error("a demo panel must never fetch");
  });
});

const PORTALS = Object.keys(DEMO_TABS) as DemoPortal[];

describe("DEMO_TABS contract", () => {
  it("lists the planned tabs per portal", () => {
    expect(DEMO_TABS.manager.map((t) => t.id)).toEqual([
      "dashboard",
      "properties",
      "tours",
      "applications",
      "leases",
      "residents",
      "payments",
      "services",
      "calendar",
      "communication",
      "vendors",
    ]);
    expect(DEMO_TABS.resident.map((t) => t.id)).toEqual([
      "home",
      "applications",
      "lease",
      "payments",
      "services",
      "forms",
      "communication",
    ]);
    expect(DEMO_TABS.vendor.map((t) => t.id)).toEqual(["services", "calendar", "payments", "reviews", "communication"]);
  });
});

describe.each(PORTALS)("DemoPanel - %s portal", (portal) => {
  it.each(DEMO_TABS[portal].map((t) => [t.id, t.label]))("renders the %s tab (%s)", (tab) => {
    const { container } = render(<DemoPanel portal={portal} tab={tab} />);
    const text = container.textContent ?? "";
    expect(text.trim().length).toBeGreaterThan(20);
    expect(text).not.toMatch(/work[\s-]?order/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("vendor Reviews", () => {
  it("draws the stats card above the All / Needs reply / Replied tabs", () => {
    render(<DemoPanel portal="vendor" tab="reviews" />);
    const stats = screen.getByTestId("vendor-reviews-stats");
    const tab = screen.getByRole("button", { name: /needs reply/i });
    expect(stats.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(tab);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
