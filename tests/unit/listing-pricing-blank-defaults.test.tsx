// @vitest-environment jsdom
//
// Property pricing workspace for a new listing must not show example numbers.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import {
  createDefaultListingSubmission,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { renderListingPricing } from "./helpers/listing-pricing-workspace-harness";

afterEach(() => cleanup());

function blankInitial(): ManagerListingSubmissionV1 {
  return {
    ...createDefaultListingSubmission(),
    listingPlaceCategoryId: "shared_home",
    allowedLeaseTerms: ["Long-term"],
  };
}

function openPricing() {
  renderListingPricing({ initial: blankInitial });
}

describe("a new listing's Pricing step starts blank", () => {
  it("shows no example amount on a new room card, and draws no Default room card", () => {
    openPricing();
    expect(document.querySelector('[data-attr="listing-v2-price-defaults-card"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Open .* prices$/ }));
    const rent = screen.getByLabelText(/rent on /i) as HTMLInputElement;
    const util = screen.getByLabelText(/utilities on /i) as HTMLInputElement;
    const deposit = screen.getByLabelText(/deposit on /i) as HTMLInputElement;

    expect(rent.value).toBe("");
    expect(rent.placeholder).toBe("");
    expect(util.value).toBe("");
    expect(util.placeholder).toBe("");
    expect(deposit.value).toBe("");
    expect(deposit.placeholder).toBe("");

    for (const example of ["1,100", "150", "1,000"]) {
      expect(document.body.textContent).not.toContain(example);
    }
  });

  it("offers no application fee on the listing — it is set once in Application system settings", () => {
    openPricing();
    expect(document.querySelector('[data-attr="listing-v2-application-fee-on"]')).toBeNull();
    expect(screen.queryByLabelText("Application fee")).toBeNull();
  });

  it("typing Room 1 rent does not fill another room", () => {
    let latest: ManagerListingSubmissionV1 | null = null;
    const base = createDefaultListingSubmission();
    renderListingPricing({
      initial: () => ({
        ...base,
        listingPlaceCategoryId: "shared_home",
        allowedLeaseTerms: ["Long-term"],
        rooms: [
          { ...base.rooms[0]!, id: "r1", name: "Room 1", monthlyRent: 0 },
          { ...base.rooms[0]!, id: "r2", name: "Room 2", monthlyRent: 0 },
        ],
      }),
      onChange: (s) => (latest = s),
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Room 1 prices" }));
    fireEvent.change(screen.getByLabelText(/Room 1 rent on/i), { target: { value: "900" } });
    expect(latest?.rooms[0]?.monthlyRent).toBe(900);
    expect(latest?.rooms[1]?.monthlyRent ?? 0).toBe(0);
  });
});
