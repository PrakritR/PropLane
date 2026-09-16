// @vitest-environment jsdom
/**
 * "We found this home" (`found-online-card.tsx`): the card and its lookup
 * run only on a blank listing, the card lists the entries the click writes,
 * and the filled strip undoes back to the list. PLAN-0915-1947.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { FoundOnlineCard } from "@/components/portal/listing-wizard-v2/found-online-card";
import type { ListingPrefillResult } from "@/lib/listing-prefill/types";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const FOUND: ListingPrefillResult = {
  status: "found",
  facts: { propertyType: "townhouse", bedrooms: 8, bathrooms: 3, squareFeet: 1561, yearBuilt: 2022, lotSquareFeet: null, floors: 2, lastSaleYear: null, amenities: ["Heating"] },
  rent: { rentUsd: 5610, lowUsd: 5100, highUsd: 6100, comparables: 9 },
  cached: false,
  lookupsLeft: 2,
  source: "fixture",
};
const LOOKUP = { address: "5257 Brooklyn Avenue Northeast", city: "Seattle", state: "WA", zip: "98105" };

const fetchSpy = vi.fn();

function Harness({ initial }: { initial: ManagerListingSubmissionV1 }) {
  const [sub, setSub] = useState(initial);
  return (
    <>
      <FoundOnlineCard sub={sub} patch={(next) => setSub((s) => ({ ...s, ...next }))} lookup={LOOKUP} />
      <output data-testid="rooms">{sub.rooms.length}</output>
      <output data-testid="baths">{sub.bathrooms.length}</output>
      <output data-testid="spaces">{sub.sharedSpaces.map((s) => s.name).join("|")}</output>
      <output data-testid="rent">{sub.houseDefaults?.monthlyRent ?? ""}</output>
    </>
  );
}

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ ok: true, json: async () => FOUND });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(cleanup);

describe("FoundOnlineCard", () => {
  it("shows nothing and calls nothing on a listing that already has its details", async () => {
    const filled = { ...normalizeManagerListingSubmissionV1(createDefaultListingSubmission()), listingPropertyTypeId: "townhouse", listingBedroomSlots: 8 };
    const { container } = render(<Harness initial={filled} />);
    await act(async () => {});
    expect(container.querySelector('[data-attr="listing-v2-prefill-card"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lists every entry the click will write, fills them, and undoes back to the list", async () => {
    render(<Harness initial={normalizeManagerListingSubmissionV1(createDefaultListingSubmission())} />);
    await screen.findByText("We found this home");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    for (const label of ["Home type", "Bedrooms", "Rent per room", "Bathrooms", "Shared spaces", "Size", "Year built", "Floors", "Amenities", "Rent estimate"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Townhouse")).toBeTruthy();
    expect(screen.getByText("→ Room 1–8")).toBeTruthy();
    expect(screen.getByText("→ Bathroom 1–3")).toBeTruthy();
    expect(screen.getByText("≈ $700")).toBeTruthy();
    expect(screen.queryByText("Lot")).toBeNull();
    expect(screen.queryByText(/Apartments\.com|Paste/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use these details" }));
    await screen.findByText(/Filled in \d+ details/);
    expect(screen.getByTestId("rooms").textContent).toBe("8");
    expect(screen.getByTestId("baths").textContent).toBe("3");
    expect(screen.getByTestId("spaces").textContent).toBe("Kitchen & dining|Living / lounge");
    expect(screen.getByTestId("rent").textContent).toBe("700");

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByTestId("rooms").textContent).toBe("1"));
    expect(screen.getByTestId("baths").textContent).toBe("0");
    expect(screen.getByTestId("spaces").textContent).toBe("");
    expect(screen.getByTestId("rent").textContent).toBe("");
    // The list is back, from the same answer — no second lookup.
    await screen.findByText("We found this home");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
