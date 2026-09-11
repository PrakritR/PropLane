import { describe, expect, it } from "vitest";
import { buildListingQuote } from "@/lib/listing-quote";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

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

  it("never lists the application fee as due at signing", () => {
    const quote = buildListingQuote(listing(), { roomId: "room-a", leaseTerm: LONG_TERM_LEASE_TERM });
    expect(quote.signingLines.some((l) => l.label === "Application fee")).toBe(false);
    expect(quote.applicationFees.map((f) => f.label)).toContain("Application fee");
  });
});
