// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-is-native-app", () => ({
  useIsNativeApp: () => ({ isNative: false }),
}));

import { ManagerPlanAddonsPanel } from "@/components/portal/manager-plan-addons-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE_PAYLOAD = {
  tier: "business" as const,
  canHoldAddons: true,
  monthlyTotalCents: 3000,
  addons: [
    {
      id: "extra_workspace",
      label: "Extra workspace",
      unit: "workspace",
      description: "A second team.",
      monthlyCents: 3000,
      maxQuantity: 7,
      quantity: 1,
      purchasable: true,
    },
    {
      id: "extra_resident",
      label: "Extra residents",
      unit: "resident",
      description: "One more resident slot.",
      monthlyCents: 200,
      maxQuantity: null,
      quantity: 0,
      purchasable: true,
    },
  ],
};

function quantityFor(container: HTMLElement, addonId: string): string | null {
  return container.querySelector(`[data-attr="plan-addon-${addonId}-quantity"]`)?.textContent ?? null;
}

function stubbedFetch(addonsFetchMock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/api/manager/rent-reporting-addon")) {
      return Response.json({ tier: "business", canHoldAddon: true, enabled: false, reporting: 0, total: 0 });
    }
    return addonsFetchMock(input, init);
  });
}

describe("ManagerPlanAddonsPanel", () => {
  it("moving a stepper never calls the server — only local draft state changes", async () => {
    const addonsFetchMock = vi.fn(async () => Response.json(BASE_PAYLOAD));
    vi.stubGlobal("fetch", stubbedFetch(addonsFetchMock));

    const { container } = render(<ManagerPlanAddonsPanel />);

    const add = await screen.findByRole("button", { name: "Add one resident" });
    fireEvent.click(add);
    fireEvent.click(add);

    expect(quantityFor(container, "extra_resident")).toBe("2");
    expect(addonsFetchMock).toHaveBeenCalledTimes(1);
    expect(addonsFetchMock).toHaveBeenCalledWith("/api/manager/plan-addons", expect.objectContaining({ cache: "no-store" }));
  });

  it("shows Update monthly costs after a change, confirms cost increases, then sends ONE batch PATCH", async () => {
    const patchedBody = {
      ...BASE_PAYLOAD,
      monthlyTotalCents: 6400,
      stripeSynced: true,
      addons: [
        { ...BASE_PAYLOAD.addons[0], quantity: 2 },
        { ...BASE_PAYLOAD.addons[1], quantity: 2 },
      ],
    };
    const addonsFetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(BASE_PAYLOAD))
      .mockResolvedValueOnce(Response.json(patchedBody));
    vi.stubGlobal("fetch", stubbedFetch(addonsFetchMock));

    render(<ManagerPlanAddonsPanel />);

    await screen.findByRole("button", { name: "Add one workspace" });
    expect(screen.queryByRole("button", { name: "Update monthly costs" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add one workspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Add one resident" }));
    fireEvent.click(screen.getByRole("button", { name: "Add one resident" }));

    // +1 workspace * $30 + +2 residents * $2 = +$34/mo.
    expect(await screen.findByText("+$34/mo on your next billing cycle")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Update monthly costs" }));
    expect(await screen.findByRole("heading", { name: "Confirm payment" })).toBeInTheDocument();
    expect(addonsFetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(addonsFetchMock).toHaveBeenCalledTimes(2));
    expect(addonsFetchMock).toHaveBeenLastCalledWith(
      "/api/manager/plan-addons",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          changes: [
            { addonId: "extra_workspace", quantity: 2 },
            { addonId: "extra_resident", quantity: 2 },
          ],
        }),
      }),
    );

    await waitFor(() => expect(screen.queryByRole("button", { name: "Update monthly costs" })).not.toBeInTheDocument());
  });

  it("never disables a row for a missing Stripe price — only a real plan cap disables Add", async () => {
    const fetchMock = stubbedFetch(
      vi.fn(async () =>
        Response.json({
          ...BASE_PAYLOAD,
          addons: [{ ...BASE_PAYLOAD.addons[0], quantity: 7, maxQuantity: 7, purchasable: true }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ManagerPlanAddonsPanel />);

    const add = await screen.findByRole("button", { name: "Add one workspace" });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", "Your plan can hold up to 7 workspaces");

    const remove = screen.getByRole("button", { name: "Remove one workspace" });
    expect(remove).not.toBeDisabled();
  });

  it("reverts to the server's answer and reports the error when the batch fails", async () => {
    const addonsFetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(BASE_PAYLOAD))
      .mockResolvedValueOnce(Response.json({ error: "We couldn't update your add-ons. Nothing changed." }, { status: 402 }));
    vi.stubGlobal("fetch", stubbedFetch(addonsFetchMock));

    render(<ManagerPlanAddonsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Add one resident" }));
    fireEvent.click(screen.getByRole("button", { name: "Update monthly costs" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("We couldn't update your add-ons. Nothing changed.")).toBeInTheDocument();
  });

  it("does not list retired communication credits on the storefront", async () => {
    const addonsFetchMock = vi.fn(async () =>
      Response.json({
        ...BASE_PAYLOAD,
        addons: [
          ...BASE_PAYLOAD.addons,
          {
            id: "extra_comms_credit",
            label: "Communication credits",
            unit: "credit pack",
            description: "Retired.",
            monthlyCents: 1000,
            maxQuantity: 0,
            quantity: 0,
            purchasable: false,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", stubbedFetch(addonsFetchMock));

    render(<ManagerPlanAddonsPanel />);
    await screen.findByRole("button", { name: "Add one workspace" });
    expect(screen.queryByText("Communication credits")).not.toBeInTheDocument();
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
