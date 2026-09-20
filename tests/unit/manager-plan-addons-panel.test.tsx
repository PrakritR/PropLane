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
  monthlyTotalCents: 0,
  addons: [
    {
      id: "extra_listing",
      label: "Extra property listing",
      unit: "listing",
      description: "One more live listing.",
      monthlyCents: 600,
      maxQuantity: null,
      quantity: 0,
      purchasable: true,
    },
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
  ],
};

function quantityFor(container: HTMLElement, addonId: string): string | null {
  return container.querySelector(`[data-attr="plan-addon-${addonId}-quantity"]`)?.textContent ?? null;
}

// PLAN-0920: add-ons are always purchasable and commit as one batch, so this
// suite replaces the retired per-click purchase-closure assertions — nothing
// here should ever find a row disabled for a missing price.

describe("ManagerPlanAddonsPanel", () => {
  it("moving a stepper never calls the server — only local draft state changes", async () => {
    const fetchMock = vi.fn(async () => Response.json(BASE_PAYLOAD));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<ManagerPlanAddonsPanel />);

    const add = await screen.findByRole("button", { name: "Add one listing" });
    fireEvent.click(add);
    fireEvent.click(add);

    expect(quantityFor(container, "extra_listing")).toBe("2");
    // Only the initial GET happened; no write was sent for either click.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/manager/plan-addons", expect.objectContaining({ cache: "no-store" }));
  });

  it("shows a Buy banner with the combined delta only after something moved, and sends ONE batch PATCH", async () => {
    const patchedBody = {
      ...BASE_PAYLOAD,
      monthlyTotalCents: 4200,
      stripeSynced: true,
      addons: [
        { ...BASE_PAYLOAD.addons[0], quantity: 2 },
        { ...BASE_PAYLOAD.addons[1], quantity: 2 },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(BASE_PAYLOAD))
      .mockResolvedValueOnce(Response.json(patchedBody));
    vi.stubGlobal("fetch", fetchMock);

    render(<ManagerPlanAddonsPanel />);

    // Nothing moved yet — no banner, no Buy.
    await screen.findByRole("button", { name: "Add one listing" });
    expect(screen.queryByText(/\/mo from today, prorated/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Buy" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add one listing" }));
    fireEvent.click(screen.getByRole("button", { name: "Add one listing" }));
    fireEvent.click(screen.getByRole("button", { name: "Add one workspace" }));

    // +2 listings * $6 + +1 workspace * $30 = +$42/mo.
    expect(await screen.findByText("+$42/mo from today, prorated")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Buy" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/manager/plan-addons",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          changes: [
            { addonId: "extra_listing", quantity: 2 },
            { addonId: "extra_workspace", quantity: 2 },
          ],
        }),
      }),
    );

    // Quantities and the banner both come from the server response, not the click.
    await waitFor(() => expect(screen.queryByText(/\/mo from today, prorated/)).not.toBeInTheDocument());
  });

  it("never disables a row for a missing Stripe price — only a real plan cap disables Add", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        ...BASE_PAYLOAD,
        addons: [{ ...BASE_PAYLOAD.addons[1], quantity: 7, maxQuantity: 7, purchasable: true }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ManagerPlanAddonsPanel />);

    const add = await screen.findByRole("button", { name: "Add one workspace" });
    // At its cap: disabled by the CAP, never by `purchasable` (which is always true now).
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("title", "Your plan can hold up to 7 of these");

    const remove = screen.getByRole("button", { name: "Remove one workspace" });
    expect(remove).not.toBeDisabled();
  });

  it("reverts to the server's answer and reports the error when the batch fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(BASE_PAYLOAD))
      .mockResolvedValueOnce(Response.json({ error: "We couldn't update your add-ons. Nothing changed." }, { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ManagerPlanAddonsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Add one listing" }));
    fireEvent.click(screen.getByRole("button", { name: "Buy" }));

    expect(await screen.findByText("We couldn't update your add-ons. Nothing changed.")).toBeInTheDocument();
  });
});
