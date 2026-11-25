/**
 * @vitest-environment jsdom
 *
 * Apply price summary: a lease that starts OR ends off the calendar month carries the custom-dates surcharge
 * ($100/month unless the manager priced it) and the partial first / last months are prorated by the same
 * day-count module the ledger reads. The summary is the one quote, never a number computed in the UI.
 *
 * The charge side is driven through the real writer (`recordApprovedApplicationCharges`), so the wiring between the
 * quote and the ledger is what these tests check - not a fee set this file resolved for itself.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildListingQuote } from "@/lib/listing-quote";
import { readHouseholdCharges, recordApprovedApplicationCharges, removeResidentHouseholdPaymentData } from "@/lib/household-charges";
import { resolveApplicationRoomTermFees } from "@/lib/room-term-fees";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { CUSTOM_LEASE_SURCHARGE_FEE_ID } from "@/lib/custom-lease-billing";
import { CUSTOM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

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

beforeEach(() => {
  window.sessionStorage.clear();
});

const quote = (sub: ManagerListingSubmissionV1, leaseStart: string, leaseEnd: string, leaseTerm = "Long-term") =>
  buildListingQuote(sub, { roomId: "room-1", leaseTerm, leaseStart, leaseEnd });

const firstMonthLine = (q: ReturnType<typeof quote>) => q.signingLines.find((l) => l.key.includes("room_rent") || l.key === "first_month_rent");

const MANAGER_ID = "mgr-custom-dates";
const LEASE_START = "2027-01-15";
const LEASE_END = "2028-01-31";

/** Tacoma, not Seattle: a monthly fee bills as its own charge everywhere else (Seattle folds it into rent). */
function publish(propertyId: string, sub: ManagerListingSubmissionV1): void {
  const property: MockProperty = {
    id: propertyId,
    title: "Custom Dates House",
    tagline: "",
    address: "1200 Pacific Ave, Tacoma, WA",
    zip: "98402",
    neighborhood: "Downtown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,000/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Custom Dates House",
    unitLabel: "Room A",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: sub,
  };
  cachePublicExtraListings([property], { silent: true });
}

function applicant(propertyId: string, email: string): DemoApplicantRow {
  const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`;
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Custom Dates House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: choice,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: choice,
      rentalType: "standard",
      leaseTerm: "Long-term",
      leaseStart: LEASE_START,
      leaseEnd: LEASE_END,
      fullLegalName: "Dana Tenant",
    },
  } as unknown as DemoApplicantRow;
}

/** Every surcharge line the ledger holds for this resident, full months and prorated partial months alike. */
function surchargeCharges(email: string) {
  return readHouseholdCharges().filter(
    (charge) =>
      charge.residentEmail.toLowerCase() === email.toLowerCase() &&
      charge.customFeeId === CUSTOM_LEASE_SURCHARGE_FEE_ID,
  );
}

/**
 * What the ledger bills for the surcharge on the first (partial) month, through the writer the manager's own
 * approval runs. A Jan 15 start is 17 of 31 days, so the monthly amount lands prorated on the same day count the
 * quote prints.
 */
function billedFirstMonthSurcharge(sub: ManagerListingSubmissionV1, email: string): number | undefined {
  const propertyId = `prop-${email.split("@")[0]}`;
  removeResidentHouseholdPaymentData(email);
  publish(propertyId, sub);
  recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });
  const line = surchargeCharges(email).find((charge) => charge.kind === "prorated_fee");
  return line ? Number(line.amountLabel.replace(/[^0-9.]/g, "")) : undefined;
}

const PRORATED = (monthly: number) => monthly * (17 / 31);

// The amount the manager typed is the amount, on the quote, on the lease rider AND on the monthly charge. Oracle:
// the figure they entered in that room's Pricing popup ($250) - nothing derived. Plausible wrong behaviour this
// rejects: quoting and printing $250 while the recurring charge bills the $100 default, which is $150/mo of signed
// rent never invoiced.
describe("the room's own custom-dates surcharge", () => {
  const perRoom = (removed = false) => {
    const sub = listing();
    const room = sub.rooms[0]!;
    return normalizeManagerListingSubmissionV1({
      ...sub,
      ...(removed ? { removedStandardListingFeeRows: ["customLeaseSurcharge"] } : {}),
      rooms: [{ ...room, occupancyPrices: [{ count: 1, customStartSurcharge: "250" }] }],
    });
  };

  it("is what the quote, the lease rider and the monthly charge all say", () => {
    const sub = perRoom();
    expect(quote(sub, LEASE_START, LEASE_END).customLeaseSurcharge).toBe(250);

    const rider = resolveApplicationRoomTermFees(sub, { listingRoomId: "room-1" }, { leaseTerm: "Long-term" });
    expect(rider?.customStartSurcharge).toBe(250);

    expect(billedFirstMonthSurcharge(sub, "per-room@example.com")).toBeCloseTo(PRORATED(250), 2);
  });

  it("falls back to the listing's own row", () => {
    const listingLevel = listing("75");
    expect(quote(listingLevel, LEASE_START, LEASE_END).customLeaseSurcharge).toBe(75);
    expect(billedFirstMonthSurcharge(listingLevel, "listing-row@example.com")).toBeCloseTo(PRORATED(75), 2);
  });

  // A row the manager REMOVED is their decision, and the $100 default must never outrank it - on the quote or in
  // the ledger. An amount they typed on the room is a setting of their own, so it still stands.
  it("a removed row bills and prints nothing", () => {
    const removed = normalizeManagerListingSubmissionV1({
      ...listing(),
      removedStandardListingFeeRows: ["customLeaseSurcharge"],
    });
    expect(quote(removed, LEASE_START, LEASE_END).customLeaseSurcharge).toBeUndefined();
    expect(billedFirstMonthSurcharge(removed, "removed-row@example.com")).toBeUndefined();
    expect(surchargeCharges("removed-row@example.com")).toEqual([]);

    const removedButTyped = perRoom(true);
    expect(quote(removedButTyped, LEASE_START, LEASE_END).customLeaseSurcharge).toBe(250);
    expect(billedFirstMonthSurcharge(removedButTyped, "removed-typed@example.com")).toBeCloseTo(PRORATED(250), 2);
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
