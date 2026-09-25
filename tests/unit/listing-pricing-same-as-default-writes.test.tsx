// @vitest-environment jsdom
//
// Copying a room's price must write the source room's numbers onto the record.
// The old "Same as default room" tick could draw $1,050 while the record held
// $0; Review, the applicant's room list and the signed lease read the record.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  submitManagerPendingPropertyToServer: vi.fn(),
  updateExtraListingFromSubmissionOnServer: vi.fn(),
}));
vi.mock("@/lib/native/app-review", () => ({ recordDelightMoment: vi.fn() }));
vi.mock("@/lib/manager-subscription-client", () => ({ loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false) }));

import { listingReadiness } from "@/components/portal/listing-wizard-v2/listing-editor";
import { ListingWizardV2 } from "@/components/portal/listing-wizard-v2";
import {
  copyRoomPricingFrom,
  emptyListingHouseDefaults,
  fillRoomsFollowingDefaults,
  resetRoomFieldToDefault,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import {
  createDefaultListingSubmission,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

afterEach(() => cleanup());

const DEFAULTS: ListingHouseDefaults = { ...emptyListingHouseDefaults(), monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250" };

function seeded(rooms: Partial<ManagerRoomSubmission>[]): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    address: "5257 Brooklyn Avenue Northeast",
    houseOverview: "A house.",
    securityDeposit: "250",
    allowedLeaseTerms: ["Long-term"],
    houseDefaults: DEFAULTS,
    rooms: rooms.map((r, i) => ({ id: `r${i + 1}`, name: `Room ${i + 1}`, monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250", ...r })),
  } as ManagerListingSubmissionV1;
}

// Pricing no longer shows a Same-as picker (PLAN-0922-1904); Duplicate copies
// a room's price card with copyRoomPricingFrom. The guarantees are the same:
// real numbers, never a blank, and no live link back to the source.
describe("copying another room's price card writes that room's numbers once", () => {
  const room = (over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission =>
    ({ ...createDefaultListingSubmission().rooms[0]!, ...over }) as ManagerRoomSubmission;

  it("writes $1,050 / $0 / $250 from Room 2 into Room 1, never a blank, and keeps Room 1's identity", () => {
    const source = room({ id: "r2", name: "Room 2", monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250" });
    const target = room({ id: "r1", name: "Room 1", monthlyRent: 1200, utilitiesEstimate: "", securityDeposit: "" });
    const copied = copyRoomPricingFrom(source, target);
    expect(copied).toMatchObject({ id: "r1", name: "Room 1", monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250" });
  });

  it("editing the copy afterwards leaves the source alone", () => {
    const source = room({
      id: "r2",
      monthlyRent: 1050,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250", pricingMode: "fixed" }],
    });
    const copied = copyRoomPricingFrom(source, room({ id: "r1" }));
    copied.residentPrices![0]!.monthlyRent = 1300;
    expect(source.residentPrices![0]!.monthlyRent).toBe(1050);
  });
});

describe("the helpers", () => {
  const room = (over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission =>
    ({ ...createDefaultListingSubmission().rooms[0]!, id: "r", ...over }) as ManagerRoomSubmission;

  it("resetRoomFieldToDefault writes the card's value, blank included", () => {
    expect(resetRoomFieldToDefault(room({ monthlyRent: 1200 }), "monthlyRent", DEFAULTS).monthlyRent).toBe(1050);
    expect(resetRoomFieldToDefault(room({ securityDeposit: "900" }), "securityDeposit", { ...DEFAULTS, securityDeposit: "" }).securityDeposit).toBe("");
  });

  it("fillRoomsFollowingDefaults fills only blank followers and returns the same array when nothing changes", () => {
    const rooms = [room({ id: "a", monthlyRent: 0, utilitiesEstimate: "", securityDeposit: undefined }), room({ id: "b", monthlyRent: 1200 })];
    const out = fillRoomsFollowingDefaults(rooms, DEFAULTS);
    expect(out[0]).toMatchObject({ monthlyRent: 1050, utilitiesEstimate: "0", securityDeposit: "250" });
    expect(out[1]!.monthlyRent).toBe(1200);
    expect(fillRoomsFollowingDefaults(out, DEFAULTS)).toBe(out);
    // A card with no rent has nothing to fill.
    expect(fillRoomsFollowingDefaults(rooms, emptyListingHouseDefaults())).toBe(rooms);
  });
});

describe("a listing saved while the tick blanked a room heals on open", () => {
  it("Review says all priced without touching Pricing", () => {
    const broken = seeded([{ monthlyRent: 0, utilitiesEstimate: "", securityDeposit: undefined }, {}, {}]);
    expect(listingReadiness(broken).find((c) => c.id === "rooms")!.label).toBe("1 of 3 rooms have no rent");

    render(<ListingWizardV2 initialSubmission={broken} editListingId="listing-1" userId="u1" skuTier="pro" onClose={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Listing sections" });
    fireEvent.click(Array.from(nav.querySelectorAll("button")).find((b) => /review/i.test(b.textContent ?? ""))!);
    expect(screen.getByText("3 rooms, all priced")).toBeTruthy();
    expect(screen.queryByText(/rooms have no rent/)).toBeNull();
  });
});
