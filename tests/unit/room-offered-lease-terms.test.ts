import { describe, expect, it, vi } from "vitest";

/**
 * A room may limit the lease types it is offered on (`offeredLeaseTerms`).
 * Absent = every lease type the listing offers (today's behaviour). The
 * normalizer, the pure helpers, and the applicant surfaces (room list + step-3
 * validation) all read the same field.
 */

vi.mock("@/lib/demo-property-pipeline", () => ({
  buildMockPropertyFromDraft: () => undefined,
  isPropertyActiveForLeads: () => true,
  readAllExtraListings: () => [],
  readAllPendingManagerProperties: () => [],
  readExtraListings: () => [],
}));

vi.mock("@/data/mock-properties", () => ({
  get mockProperties() {
    const base = createDefaultListingSubmission();
    const template = base.rooms[0]!;
    return [
      {
        id: "prop-1",
        title: "Ballard House",
        unitLabel: "Room A",
        listingSubmission: {
          ...base,
          listingPlaceCategoryId: "shared_home",
          allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"],
          shortTermRentalsAllowed: true,
          rooms: [
            { ...template, id: "r1", name: "Room A", monthlyRent: 700, availability: "Now", occupancyCapacity: 1 },
            // Only month-to-month and short stays.
            { ...template, id: "r2", name: "Room B", monthlyRent: 700, availability: "Now", occupancyCapacity: 1, offeredLeaseTerms: ["Month-to-Month", "Short-Term Stay"] },
          ],
        },
      },
    ];
  },
}));

import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  normalizeRoomOfferedLeaseTerms,
  roomOfferedLeaseTerms,
  roomOfferedLeaseTermsFromPick,
  roomOffersLeaseTerm,
} from "@/lib/manager-listing-submission";
import { firstChoiceRoomOptions, getRoomOptionsForProperty } from "@/lib/rental-application/data";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { validateStandardWizardStep } from "@/lib/rental-application/validate";

describe("offeredLeaseTerms normalizer", () => {
  it("absent stays absent", () => {
    expect(normalizeRoomOfferedLeaseTerms(undefined)).toBeUndefined();
    const base = createDefaultListingSubmission();
    const sub = normalizeManagerListingSubmissionV1({ ...base, rooms: [{ ...base.rooms[0]!, id: "r1", name: "A" }] });
    expect(sub.rooms[0]!.offeredLeaseTerms).toBeUndefined();
  });

  it("drops unknown labels and repeats, keeps the given order", () => {
    expect(normalizeRoomOfferedLeaseTerms(["Short-Term Stay", "Bogus", "Long-term", "Short-Term Stay", 4])).toEqual([
      "Short-Term Stay",
      "Long-term",
    ]);
  });

  it("an empty or all-unknown list reads as absent (never 'offered nowhere')", () => {
    expect(normalizeRoomOfferedLeaseTerms([])).toBeUndefined();
    expect(normalizeRoomOfferedLeaseTerms(["nope"])).toBeUndefined();
    expect(normalizeRoomOfferedLeaseTerms("Long-term")).toBeUndefined();
  });

  it("survives a full submission normalize", () => {
    const base = createDefaultListingSubmission();
    const sub = normalizeManagerListingSubmissionV1({
      ...base,
      rooms: [{ ...base.rooms[0]!, id: "r1", name: "A", offeredLeaseTerms: ["Custom", "x"] }],
    });
    expect(sub.rooms[0]!.offeredLeaseTerms).toEqual(["Custom"]);
  });
});

describe("room lease-type helpers", () => {
  const listing = ["Long-term", "Short-Term Stay", "Custom"];
  it("a room that does not restrict follows the listing", () => {
    expect(roomOfferedLeaseTerms({}, listing)).toEqual(listing);
    expect(roomOffersLeaseTerm({}, "Custom")).toBe(true);
  });
  it("narrows to what the listing offers", () => {
    expect(roomOfferedLeaseTerms({ offeredLeaseTerms: ["Month-to-Month", "Custom"] }, listing)).toEqual(["Custom"]);
  });
  it("a retired fixed length reads as Long-term", () => {
    expect(roomOffersLeaseTerm({ offeredLeaseTerms: ["Long-term"] }, "12-Month")).toBe(true);
    expect(roomOffersLeaseTerm({ offeredLeaseTerms: ["Custom"] }, "12-Month")).toBe(false);
  });
  it("all or none ticked clears the restriction; a partial pick keeps canonical order", () => {
    expect(roomOfferedLeaseTermsFromPick(listing, listing)).toBeUndefined();
    expect(roomOfferedLeaseTermsFromPick([], listing)).toBeUndefined();
    expect(roomOfferedLeaseTermsFromPick(["Custom", "Long-term"], listing)).toEqual(["Long-term", "Custom"]);
  });
});

describe("applicant lease-term filtering for a restricted room", () => {
  it("lists every room when no term is chosen", () => {
    expect(getRoomOptionsForProperty("prop-1").map((o) => o.label.split(" · ")[0])).toEqual(["Room A", "Room B"]);
  });
  it("a room offering none of the chosen term can't be picked for it", () => {
    const names = (term: string) =>
      getRoomOptionsForProperty("prop-1", { leaseTerm: term }).map((o) => o.label.split(" · ")[0]);
    expect(names("Long-term")).toEqual(["Room A"]);
    expect(names("Month-to-Month")).toEqual(["Room A", "Room B"]);
    expect(names("Short-Term Stay")).toEqual(["Room A", "Room B"]);
    expect(firstChoiceRoomOptions("prop-1", { leaseTerm: "Long-term" }).map((o) => o.label.split(" · ")[0])).toEqual(["Room A"]);
  });
  it("an already-picked room stays selectable in the first-choice list", () => {
    const keep = "prop-1::r2";
    const values = firstChoiceRoomOptions("prop-1", { leaseTerm: "Long-term", keepValue: keep }).map((o) => o.value);
    expect(values).toContain(keep);
  });
  it("validation names the restricted room", () => {
    const f = {
      ...createInitialRentalWizardState(),
      propertyId: "prop-1",
      roomChoice1: "prop-1::r2",
      leaseTerm: "Long-term",
    };
    const errors = validateStandardWizardStep(3, f);
    expect(errors.roomChoice1).toMatch(/isn't offered on this lease type/);
    const ok = validateStandardWizardStep(3, { ...f, leaseTerm: "Month-to-Month" });
    expect(ok.roomChoice1 ?? "").not.toMatch(/isn't offered/);
  });
});
