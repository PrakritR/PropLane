import { describe, expect, it } from "vitest";
import { buildListingQuote } from "@/lib/listing-quote";
import { listingOffersMonthToMonthSurcharge } from "@/lib/listing-fees";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const MONTH_TO_MONTH = "Month-to-Month";

/**
 * A two-room listing priced long-term, with one one-time fee and one monthly fee.
 *
 * Deliberately NOT in Seattle: the Seattle rule folds every monthly fee into rent,
 * which is its own case below.
 */
function listing(overrides: Partial<ManagerListingSubmissionV1> = {}): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  /*
   * Normalization REBUILDS `customFees` from the standard preset slots, so a
   * manager's own fee has to be appended after it — which is exactly what the
   * editor does. Writing them into the input instead silently drops them, and
   * the receipt then quotes a listing with no fees at all.
   */
  const normalized = normalizeManagerListingSubmissionV1({
    ...base,
    address: "10 Test St",
    city: "Portland",
    state: "OR",
    zip: "97201",
    securityDeposit: "1000",
    applicationFee: "50",
    allowedLeaseTerms: [LONG_TERM_LEASE_TERM, MONTH_TO_MONTH],
    rooms: [
      { ...base.rooms[0]!, id: "room-a", name: "Room A", monthlyRent: 1200, utilitiesEstimate: "150" },
      { ...base.rooms[0]!, id: "room-b", name: "Room B", monthlyRent: 1000, utilitiesEstimate: "150" },
    ],
  } as ManagerListingSubmissionV1);

  const withFees: ManagerListingSubmissionV1 = {
    ...normalized,
    customFees: [
      ...(normalized.customFees ?? []),
      { id: "fee-clean", label: "Move-in cleaning", amount: "250", frequency: "one-time", presetId: "custom" },
      { id: "fee-parking", label: "Parking", amount: "75", frequency: "monthly", presetId: "custom" },
    ] as ManagerListingSubmissionV1["customFees"],
    // Everything up front, so the signing total is the whole move-in cost.
    paymentAtSigningByLeaseType: {
      [LONG_TERM_LEASE_TERM]: [
        "room_rent:room-a",
        "room_rent:room-b",
        "first_month_utilities",
        "security_deposit",
        "fee:fee-clean",
      ],
    },
  };

  return { ...withFees, ...overrides };
}

/** Replace just the manager-added fees, keeping the standard slots intact. */
function withCustomFees(
  sub: ManagerListingSubmissionV1,
  rows: NonNullable<ManagerListingSubmissionV1["customFees"]>,
): ManagerListingSubmissionV1 {
  const standard = (sub.customFees ?? []).filter(
    (f) => (f as { presetId?: string }).presetId && (f as { presetId?: string }).presetId !== "custom",
  );
  return { ...sub, customFees: [...standard, ...rows] };
}

describe("buildListingQuote", () => {
  it("adds up what a resident hands over on day one", () => {
    const quote = buildListingQuote(listing(), { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    // 1200 rent + 75 parking + 150 utilities + 1000 deposit + 250 cleaning
    expect(quote.signingTotal).toBe(2675);
    expect(quote.monthlyTotal).toBe(1425);
    expect(quote.monthlyFees.map((f) => f.label)).toEqual(["Parking"]);
    expect(quote.nonRefundableAtSigning).toBe(250);
  });

  it("leaves an unticked line out of the total without hiding it", () => {
    const sub = listing({
      paymentAtSigningByLeaseType: {
        [LONG_TERM_LEASE_TERM]: ["room_rent:room-a", "first_month_utilities", "security_deposit"],
      },
    });
    const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    const cleaning = quote.signingLines.find((l) => l.label === "Move-in cleaning");
    expect(cleaning?.dueAtSigning).toBe(false);
    expect(cleaning?.amount).toBe(250);
    // 1200 + 75 + 150 + 1000, with the cleaning collected later.
    expect(quote.signingTotal).toBe(2425);
  });

  it("quotes each room its own rent", () => {
    const sub = listing();
    const a = buildListingQuote(sub, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    const b = buildListingQuote(sub, { roomId: "room-b", leaseTerm: LONG_TERM_LEASE_TERM });
    expect(a.monthlyRent - b.monthlyRent).toBe(200);
  });

  it("charges a room's long-term rent on another lease type until that type is given its own", () => {
    const sub = listing();
    const inherited = buildListingQuote(sub, { roomId: "room-a", leaseTerm: MONTH_TO_MONTH });
    expect(inherited.monthlyRent).toBe(1200); // its long-term rent, unchanged

    const withOverride = listing({
      rooms: (listing().rooms ?? []).map((room) =>
        room.id === "room-a" ? { ...room, termPricing: { [MONTH_TO_MONTH]: { monthlyRent: 1350 } } } : room,
      ),
    });
    const own = buildListingQuote(withOverride, { roomId: "room-a", leaseTerm: MONTH_TO_MONTH });
    expect(own.monthlyRent).toBe(1350);
    // The long-term price is untouched by the override.
    expect(buildListingQuote(withOverride, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM }).monthlyRent).toBe(
      1200,
    );
  });

  it("collects long-term signing ticks on month-to-month while same-as-long-term holds", () => {
    const inherited = buildListingQuote(listing(), { roomId: "room-a", leaseTerm: MONTH_TO_MONTH });
    expect(inherited.signingTotal).toBe(2675);
  });

  it("quotes Every room from house defaults, not the first room", () => {
    const base = listing();
    const sub = listing({
      houseDefaults: { monthlyRent: 1050, securityDeposit: "250", utilitiesEstimate: "50" },
      rooms: (base.rooms ?? []).map((room) => ({ ...room })),
    } as ManagerListingSubmissionV1);
    const quote = buildListingQuote(sub, { roomId: null, leaseTerm: LONG_TERM_LEASE_TERM });
    expect(quote.monthlyRent).toBe(1050);
    expect(quote.monthlyUtilities).toBe(50);
    expect(quote.securityDeposit).toBe(250);
  });

  it("lets one room keep its own signing ticks after Reset is available", () => {
    const sub = listing({
      rooms: (listing().rooms ?? []).map((room) =>
        room.id === "room-a"
          ? { ...room, paymentAtSigningByLeaseType: { [LONG_TERM_LEASE_TERM]: ["security_deposit"] } }
          : room,
      ),
    });
    const own = buildListingQuote(sub, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    const house = buildListingQuote(sub, { roomId: null, leaseTerm: LONG_TERM_LEASE_TERM });
    expect(own.signingLines.find((l) => l.key === "security_deposit")?.dueAtSigning).toBe(true);
    expect(own.signingLines.find((l) => l.label === "First month's rent")?.dueAtSigning).toBe(false);
    expect(house.signingLines.find((l) => l.label === "First month's rent")?.dueAtSigning).toBe(true);
  });

  it("keeps a fee scoped to one room off every other room's receipt", () => {
    const sub = withCustomFees(listing(), [
      { id: "fee-parking", label: "Parking", amount: "75", frequency: "monthly", presetId: "custom", roomIds: ["room-a"] },
    ] as NonNullable<ManagerListingSubmissionV1["customFees"]>);
    expect(buildListingQuote(sub, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM }).monthlyFees).toHaveLength(1);
    expect(buildListingQuote(sub, { roomId: "room-b", leaseTerm: LONG_TERM_LEASE_TERM }).monthlyFees).toHaveLength(0);
  });

  it("keeps a fee scoped to one lease type off the others", () => {
    const sub = withCustomFees(listing(), [
      { id: "fee-parking", label: "Parking", amount: "75", frequency: "monthly", presetId: "custom", leaseTypes: [MONTH_TO_MONTH] },
    ] as NonNullable<ManagerListingSubmissionV1["customFees"]>);
    expect(buildListingQuote(sub, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM }).monthlyFees).toHaveLength(0);
    expect(buildListingQuote(sub, { roomId: "room-a", leaseTerm: MONTH_TO_MONTH }).monthlyFees).toHaveLength(1);
  });

  it("folds a monthly fee into rent on a Seattle listing rather than billing it beside rent", () => {
    const seattle = listing({ city: "Seattle", state: "WA", zip: "98177" });
    const quote = buildListingQuote(seattle, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    expect(quote.monthlyFees).toHaveLength(0);
    expect(quote.foldedIntoRent.map((f) => f.label)).toEqual(["Parking"]);
    expect(quote.monthlyRent).toBe(1275);
    // Same money either way — the resident is quoted one number instead of two.
    expect(quote.monthlyTotal).toBe(1425);
  });

  it("reads Seattle off the stored property record when the submission never recorded a city", () => {
    const noCity = listing({ city: "", state: "", zip: "", address: "" });
    const seattleProperty = { address: "5 Pine St", city: "Seattle", state: "WA", zip: "98101" };
    // The submission alone cannot say Seattle, so the parking fee stays its own line...
    const plain = buildListingQuote(noCity, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    expect(plain.monthlyFees).toHaveLength(1);
    // ...but handed the stored property record, the quote folds it into rent as every Seattle reader does.
    const quote = buildListingQuote(noCity, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM, listingProperty: seattleProperty });
    expect(quote.monthlyFees).toHaveLength(0);
    expect(quote.foldedIntoRent.map((f) => f.label)).toEqual(["Parking"]);
    expect(quote.monthlyRent).toBe(1275);
  });

  it("never offers the month-to-month surcharge on a Seattle property, judged on the stored record too", () => {
    const noCity = listing({ city: "", state: "", zip: "", address: "" });
    expect(listingOffersMonthToMonthSurcharge(noCity)).toBe(true);
    expect(listingOffersMonthToMonthSurcharge(noCity, { city: "Seattle", state: "WA" })).toBe(false);
    expect(listingOffersMonthToMonthSurcharge(listing({ city: "Seattle", state: "WA", zip: "98177" }))).toBe(false);
    expect(listingOffersMonthToMonthSurcharge(listing())).toBe(true);
  });

  it("never lists the application fee as due at signing", () => {
    const quote = buildListingQuote(listing(), { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    expect(quote.signingLines.some((l) => l.label === "Application fee")).toBe(false);
    expect(quote.applicationFees.map((f) => f.label)).toContain("Application fee");
  });

  it("quotes inherited rent from house defaults when a room row is still blank", () => {
    const sub = listing({
      rooms: [
        { ...listing().rooms![0]!, id: "room-a", name: "Room A", monthlyRent: 1200, utilitiesEstimate: "150" },
        { ...listing().rooms![0]!, id: "room-b", name: "Room B", monthlyRent: 0, utilitiesEstimate: "" },
      ],
      houseDefaults: { monthlyRent: 1200, utilitiesEstimate: "150" },
    } as ManagerListingSubmissionV1);
    const quote = buildListingQuote(sub, { roomId: "room-b", leaseTerm: LONG_TERM_LEASE_TERM });
    expect(quote.monthlyRent).toBe(1200);
    expect(quote.monthlyUtilities).toBe(150);
  });

  it("uses a term move-in fee instead of the house move-in fee (no duplicate lines)", () => {
    const base = listing();
    const sub = withCustomFees(
      {
        ...base,
        moveInFee: "25",
        rooms: (base.rooms ?? []).map((room) =>
          room.id === "room-a"
            ? {
                ...room,
                occupancyPrices: [{ count: 1, moveInFee: "2" }],
                termPricing: { [SHORT_TERM_LEASE_TERM]: { moveInFee: "2" } },
              }
            : room,
        ),
        allowedLeaseTerms: [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM],
      } as ManagerListingSubmissionV1,
      [],
    );
    // Drop manager cleaning fee for a clear move-in-only receipt.
    const standardOnly = (sub.customFees ?? []).filter((f) => (f as { presetId?: string }).presetId !== "custom");
    const lean = { ...sub, customFees: standardOnly };
    const quote = buildListingQuote(lean, { roomId: "room-a", leaseTerm: SHORT_TERM_LEASE_TERM });
    const moveInLines = quote.signingLines.filter((l) => l.label === "Move-in fee");
    expect(moveInLines).toHaveLength(1);
    expect(moveInLines[0]?.amount).toBe(2);
    const signingSum = quote.signingLines.filter((l) => l.dueAtSigning).reduce((s, l) => s + l.amount, 0);
    expect(quote.signingTotal).toBe(signingSum);
  });

  it("inherits the house move-in fee when the term leaves move-in blank", () => {
    const base = listing();
    const sub = {
      ...base,
      moveInFee: "25",
      rooms: (base.rooms ?? []).map((room) =>
        room.id === "room-a" ? { ...room, occupancyPrices: [{ count: 1 }] } : room,
      ),
    } as ManagerListingSubmissionV1;
    const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    const moveIn = quote.signingLines.find((l) => l.label === "Move-in fee" || l.key === "move_in_fee");
    expect(moveIn?.amount).toBe(25);
  });

  it("quotes per-term application fee from term pricing", () => {
    const sub = listing({
      applicationFee: "50",
      rooms: (listing().rooms ?? []).map((room) =>
        room.id === "room-a"
          ? {
              ...room,
              termPricing: { [MONTH_TO_MONTH]: { applicationFee: "12" } },
            }
          : room,
      ),
      allowedLeaseTerms: [LONG_TERM_LEASE_TERM, MONTH_TO_MONTH],
    } as ManagerListingSubmissionV1);
    const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: MONTH_TO_MONTH });
    expect(quote.applicationFees).toEqual([{ id: "application_fee", label: "Application fee", amount: 12 }]);
    const longTerm = buildListingQuote(sub, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    expect(longTerm.applicationFees[0]?.amount).toBe(50);
  });

  it("includes term lease fee once on the signing receipt", () => {
    const sub = listing({
      rooms: (listing().rooms ?? []).map((room) =>
        room.id === "room-a"
          ? {
              ...room,
              occupancyPrices: [{ count: 1, leaseFee: "3241" }],
              termPricing: { [SHORT_TERM_LEASE_TERM]: { leaseFee: "3241" } },
            }
          : room,
      ),
      allowedLeaseTerms: [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM],
    } as ManagerListingSubmissionV1);
    const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: SHORT_TERM_LEASE_TERM });
    const leaseLines = quote.signingLines.filter((l) => l.label === "Lease fee");
    expect(leaseLines).toHaveLength(1);
    expect(leaseLines[0]?.amount).toBe(3241);
  });

  it("quotes the short-term application fee on a stay lease", () => {
    const sub = listing({
      applicationFee: "50",
      shortTermApplicationFee: "35",
      allowedLeaseTerms: [SHORT_TERM_LEASE_TERM],
    } as ManagerListingSubmissionV1);
    const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: SHORT_TERM_LEASE_TERM });
    expect(quote.applicationFees).toEqual([{ id: "application_fee", label: "Application fee", amount: 35 }]);
  });

  it("quotes inherited deposit from house defaults, not stale long-term termPricing", () => {
    const sub = listing({
      securityDeposit: "500",
      houseDefaults: { securityDeposit: "250", monthlyRent: 1200, utilitiesEstimate: "150" },
      rooms: [
        {
          ...listing().rooms![0]!,
          id: "room-a",
          name: "Room A",
          monthlyRent: 1200,
          utilitiesEstimate: "150",
          securityDeposit: "250",
          termPricing: { [LONG_TERM_LEASE_TERM]: { securityDeposit: "500" } },
        },
      ],
    } as ManagerListingSubmissionV1);
    const quote = buildListingQuote(sub, { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    expect(quote.securityDeposit).toBe(250);
    const depositLine = quote.signingLines.find((l) => l.key === "security_deposit");
    expect(depositLine?.amount).toBe(250);
  });

  it("quotes the chosen resident slot, not the room headline", () => {
    const sub = listing({
      rooms: (listing().rooms ?? []).map((room) =>
        room.id === "room-a"
          ? {
              ...room,
              occupancyCapacity: 2,
              residentPricing: "per_resident" as const,
              residentPrices: [
                { monthlyRent: 1050, securityDeposit: "250" },
                { monthlyRent: 1200, securityDeposit: "250" },
              ],
            }
          : room,
      ),
    });
    const first = buildListingQuote(sub, {
      roomId: "room-a",
      leaseTerm: LONG_TERM_LEASE_TERM,
      residentSlot: 1,
    });
    const second = buildListingQuote(sub, {
      roomId: "room-a",
      leaseTerm: LONG_TERM_LEASE_TERM,
      residentSlot: 2,
    });
    expect(first.monthlyRent).toBe(1050);
    expect(second.monthlyRent).toBe(1200);
    expect(first.securityDeposit).toBe(250);
    expect(first.roomName).toContain("Resident 1");
    expect(second.roomName).toContain("Resident 2");
    expect(first.signingTotal).not.toBe(second.signingTotal);
  });
});
