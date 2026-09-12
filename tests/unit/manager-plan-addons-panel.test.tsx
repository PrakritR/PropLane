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
    const fetchMock = vi.fn(async () =>
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
    vi.stubGlobal("fetch", fetchMock);

    render(<ManagerPlanAddonsPanel />);

    const remove = await screen.findByRole("button", { name: "Remove one workspace" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", "Not available for purchase yet");

    fireEvent.click(remove);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
