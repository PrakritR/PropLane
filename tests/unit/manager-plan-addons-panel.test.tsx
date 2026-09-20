// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-is-native-app", () => ({
  useIsNativeApp: () => ({ isNative: false }),
}));

import { ManagerPlanAddonsPanel } from "@/components/portal/manager-plan-addons-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ManagerPlanAddonsPanel purchase closure", () => {
  it("disables removal of an existing quantity when the catalog is not purchasable", async () => {
    // The panel also renders the separate Rent reporting row (its own endpoint,
    // its own fetch) beside the PLAN_ADDONS catalogue this test exercises.
    const addonsFetchMock = vi.fn(async () =>
      Response.json({
        tier: "business",
        canHoldAddons: true,
        monthlyTotalCents: 800,
        addons: [
          {
            id: "extra_workspace",
            label: "Extra workspace",
            unit: "workspace",
            description: "One more workspace.",
            monthlyCents: 800,
            maxQuantity: 7,
            quantity: 1,
            purchasable: false,
          },
        ],
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/manager/rent-reporting-addon")) {
          return Response.json({ tier: "business", canHoldAddon: true, enabled: false, reporting: 0, total: 0 });
        }
        return addonsFetchMock();
      }),
    );

    render(<ManagerPlanAddonsPanel />);

    const remove = await screen.findByRole("button", { name: "Remove one workspace" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", "Not available for purchase yet");

    fireEvent.click(remove);
    expect(addonsFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Rent reporting row", () => {
  function stubFetch(rentReporting: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes("/api/manager/rent-reporting-addon")) return Response.json(rentReporting);
        return Response.json({ tier: "business", canHoldAddons: true, monthlyTotalCents: 0, addons: [] });
      }),
    );
  }

  it("reads Coming soon as a disabled control while no furnisher partner is live, even on Business", async () => {
    stubFetch({ tier: "business", canHoldAddon: true, partnerLive: false, enabled: false, reporting: 0, total: 0 });
    render(<ManagerPlanAddonsPanel />);

    const control = await screen.findByRole("button", { name: "Rent reporting" });
    expect(control).toBeDisabled();
    expect(control).toHaveTextContent("Coming soon");
    expect(document.querySelector('[data-attr="rent-reporting-addon-toggle"]')).toBeNull();
  });

  it("offers the On/Off control once a partner is live", async () => {
    stubFetch({ tier: "business", canHoldAddon: true, partnerLive: true, enabled: false, reporting: 0, total: 0 });
    render(<ManagerPlanAddonsPanel />);

    const control = await screen.findByRole("button", { name: "Rent reporting" });
    expect(control).not.toBeDisabled();
    expect(control).toHaveTextContent("Off");
  });
});
