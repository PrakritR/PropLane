import { describe, expect, it } from "vitest";
import { buildListingQuote } from "@/lib/listing-quote";
import { monthlyFeesBilledSeparately } from "@/lib/rent-fold-in";
import { roomFeeRow } from "@/lib/room-term-fees";
import { resolveApplicationRoomTermFees } from "@/lib/room-term-fees";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { CUSTOM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

/**
 * Apply price summary: a lease that starts OR ends off the calendar month carries the custom-dates surcharge
 * ($100/month unless the manager priced it) and the partial first / last months are prorated by the same
 * day-count module the ledger reads. The summary is the one quote, never a number computed in the UI.
 */
function listing(surcharge?: string): ManagerListingSubmissionV1 {
  let sub = createDefaultListingSubmission();
  sub.rooms = [{ ...sub.rooms[0]!, id: "room-1", name: "Room A", monthlyRent: 1000, utilitiesEstimate: "" }];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.allowedLeaseTerms = ["Long-term", CUSTOM_LEASE_TERM];
  if (surcharge !== undefined) {
    sub = applyListingFeesToSubmission(sub, [
      { id: "fee-custom-lease", presetId: "custom_lease_surcharge", label: "Custom lease", amount: surcharge, frequency: "monthly" },
    ]);
  }
  return normalizeManagerListingSubmissionV1(sub);
}

const quote = (sub: ManagerListingSubmissionV1, leaseStart: string, leaseEnd: string, leaseTerm = "Long-term") =>
  buildListingQuote(sub, { roomId: "room-1", leaseTerm, leaseStart, leaseEnd });

const firstMonthLine = (q: ReturnType<typeof quote>) => q.signingLines.find((l) => l.key.includes("room_rent") || l.key === "first_month_rent");

// The amount the manager typed is the amount, on the quote, on the lease rider AND on the monthly charge. Oracle:
// the figure they entered in that room's Pricing popup ($250) - nothing derived. Plausible wrong behaviour this
// rejects: quoting and printing $250 while the recurring charge bills the $100 default, which is $150/mo of signed
// rent never invoiced.
describe("the room's own custom-dates surcharge", () => {
  const perRoom = () => {
    const sub = listing();
    const room = sub.rooms[0]!;
    return normalizeManagerListingSubmissionV1({
      ...sub,
      rooms: [{ ...room, occupancyPrices: [{ count: 1, customStartSurcharge: "250" }] }],
    });
  };

  it("is what the quote, the lease rider and the monthly charge all say", () => {
    const sub = perRoom();
    expect(quote(sub, "2027-01-15", "2028-01-31").customLeaseSurcharge).toBe(250);

    const rider = resolveApplicationRoomTermFees(sub, { listingRoomId: "room-1" }, { leaseTerm: "Long-term" });
    expect(rider?.customStartSurcharge).toBe(250);

    const billed = monthlyFeesBilledSeparately(
      sub,
      null,
      { leaseStart: "2027-01-15", leaseEnd: "2028-01-31", leaseTerm: "Long-term" },
      roomFeeRow(sub, sub.rooms[0]),
    );
    expect(billed.find((fee) => fee.label === "Custom lease")?.amount).toBe(250);
  });

  it("falls back to the listing's own row, and a removed row bills and prints nothing", () => {
    const listingLevel = listing("75");
    expect(quote(listingLevel, "2027-01-15", "2028-01-31").customLeaseSurcharge).toBe(75);
    expect(
      monthlyFeesBilledSeparately(
        listingLevel,
        null,
        { leaseStart: "2027-01-15", leaseEnd: "2028-01-31", leaseTerm: "Long-term" },
        roomFeeRow(listingLevel, listingLevel.rooms[0]),
      ).find((fee) => fee.label === "Custom lease")?.amount,
    ).toBe(75);
  });
});

describe("custom-dates surcharge on the applicant quote", () => {
  it("adds the $100/month default when the lease starts off the 1st", () => {
    const q = quote(listing(), "2027-01-15", "2028-01-31");
    expect(q.customLeaseSurcharge).toBe(100);
    expect(q.monthlyFees.map((f) => f.label)).toContain("Custom lease surcharge");
    expect(q.monthlyTotal).toBe(1100);
  });

  it("adds it when only the END is off the month", () => {
    const q = quote(listing(), "2027-01-01", "2027-12-14");
    expect(q.customLeaseSurcharge).toBe(100);
    expect(q.monthlyTotal).toBe(1100);
  });

  it("is billed once when both ends are off-cycle", () => {
    const q = quote(listing(), "2027-01-15", "2028-01-14");
    expect(q.customLeaseSurcharge).toBe(100);
    expect(q.monthlyTotal).toBe(1100);
  });

  it("carries nothing on a lease that starts on the 1st and ends on a month end", () => {
    const q = quote(listing(), "2027-01-01", "2027-12-31");
    expect(q.customLeaseSurcharge).toBeUndefined();
    expect(q.monthlyTotal).toBe(1000);
    expect(q.proration).toBeUndefined();
  });

  it("uses the manager's own amount instead of the default", () => {
    const q = quote(listing("75"), "2027-01-15", "2028-01-31");
    expect(q.customLeaseSurcharge).toBe(75);
    expect(q.monthlyTotal).toBe(1075);
  });

  it("never bills it on a month-to-month lease (start only, no end)", () => {
    const q = quote(listing(), "2027-01-15", "", "Month-to-Month");
    expect(q.customLeaseSurcharge).toBeUndefined();
  });

  // `recurringMonthlyFeesForLease` never bills this surcharge on a month-to-month lease, so no month-to-month
  // receipt may show it either - a quoted line nothing charges is $100/mo the applicant is never billed.
  it("shows no surcharge line on a month-to-month start, even with the row priced", () => {
    const m2m = buildListingQuote(listing("100"), {
      roomId: "room-1",
      leaseTerm: "Month-to-Month",
      leaseStart: "2027-01-15",
      startKind: "m2m",
    });
    expect(m2m.customLeaseSurcharge).toBeUndefined();
    expect(m2m.monthlyFees.map((f) => f.label)).not.toContain("Custom lease surcharge");
    expect(m2m.monthlyTotal).toBe(1000);
  });
});

describe("partial months on the applicant quote", () => {
  it("prorates the first month by days from the start, surcharge included", () => {
    // Jan 15 -> 17 of 31 days. Rent 1000 + surcharge 100.
    const q = quote(listing(), "2027-01-15", "2028-01-31");
    expect(q.proration?.firstMonth).toMatchObject({ billableDays: 17, daysInMonth: 31 });
    const expected = Number(((1000 / 31) * 17).toFixed(2)) + Number((100 * (17 / 31)).toFixed(2));
    expect(q.proration?.firstMonth?.amount).toBeCloseTo(expected, 2);
    expect(firstMonthLine(q)?.amount).toBeCloseTo(expected, 2);
    expect(firstMonthLine(q)?.label).toContain("17 of 31 days");
    expect(q.proration?.lastMonth).toBeNull();
  });

  it("prorates the last month by days through the end", () => {
    // Ends Dec 14 -> 14 of 31 days, billed after signing.
    const q = quote(listing(), "2027-01-01", "2027-12-14");
    expect(q.proration?.firstMonth).toBeNull();
    expect(q.proration?.lastMonth).toMatchObject({ billableDays: 14, daysInMonth: 31 });
    const last = q.signingLines.find((l) => l.key === "last_month_rent_prorated");
    expect(last?.dueAtSigning).toBe(false);
    expect(last?.amount).toBeCloseTo(Number((1100 * (14 / 31)).toFixed(2)), 1);
  });

  it("leaves a full first month alone", () => {
    const q = quote(listing(), "2027-01-01", "2027-12-31");
    expect(firstMonthLine(q)?.amount).toBe(1000);
    expect(firstMonthLine(q)?.label).toBe("First month's rent");
  });
});
