/**
 * @vitest-environment jsdom
 *
 * Monthly fees join both partial months (PLAN-0920-0423). A monthly fee billed separately
 * (parking, storage…) that is above $0 gets one prorated line for the partial first month
 * and one for the partial last month, on the same day count as rent. A $0 fee never
 * appears, a Seattle-folded fee is already inside the rent line, and the lease document
 * prints the same rows the ledger bills.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { proratedFeeLines, leaseStartProration } from "@/lib/lease-first-period-proration";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { CALIFORNIA_LEASE_CONFIG, WASHINGTON_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerCustomFeeRow,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import type { ListingFeeRow } from "@/lib/listing-fees";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";
import type { LeaseGenerationContext } from "@/lib/generated-lease";

const MANAGER_ID = "mgr-prorated-fees";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-2", name: "Room 2", monthlyRent: 1455, utilitiesEstimate: "", ...over } as ManagerRoomSubmission;
}

function submission(customFees: ManagerCustomFeeRow[], roomOver: Partial<ManagerRoomSubmission> = {}): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.rooms = [room(roomOver)];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.customFees = customFees;
  return normalizeManagerListingSubmissionV1(sub);
}

function seed(propertyId: string, customFees: ManagerCustomFeeRow[], roomOver: Partial<ManagerRoomSubmission> = {}, address = "1200 Pacific Ave, Tacoma, WA"): MockProperty {
  const property: MockProperty = {
    id: propertyId,
    title: "8th Ave House",
    tagline: "",
    address,
    zip: address.includes("Seattle") ? "98105" : "98402",
    neighborhood: "Downtown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,455/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "8th Ave House",
    unitLabel: "Room 2",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: submission(customFees, roomOver),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

// Sep 21, 2026 → Sep 20, 2027: 10/30 days in, 20/30 days out.
function applicant(propertyId: string, email: string): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Sohan Vivek Naik",
    email,
    property: "8th Ave House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-2`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-2`,
      rentalType: "standard",
      leaseStart: "2026-09-21",
      leaseEnd: "2027-09-20",
      fullLegalName: "Sohan Vivek Naik",
    },
  } as unknown as DemoApplicantRow;
}

// "Parking" alone is a preset label the normalizer would recover into the parking preset; this row stays a custom fee.
const PARKING: ManagerCustomFeeRow = { id: "cf-parking", label: "Bike parking", amount: "60", frequency: "monthly" };

function rowsFor(email: string) {
  return readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === email);
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("proratedFeeLines", () => {
  const sep21 = leaseStartProration("2026-09-21");
  it("splits a monthly fee on the calendar fraction and skips $0", () => {
    const lines = proratedFeeLines(
      [
        { id: "a", label: "Parking", amount: 60 },
        { id: "b", label: "Storage", amount: 0 },
      ],
      sep21,
    );
    expect(lines).toEqual([{ id: "a", label: "Parking", monthlyAmount: 60, amount: 20, useDailyRate: false, dailyRate: 0 }]);
  });
  it("uses the fee's own per-day rate when the room is set per day, else the fraction", () => {
    const lines = proratedFeeLines(
      [
        { id: "a", label: "Parking", amount: 60, dailyRate: 3 },
        { id: "b", label: "Storage", amount: 30 },
      ],
      sep21,
      "daily_rate",
    );
    expect(lines.map((l) => [l.id, l.amount, l.useDailyRate])).toEqual([
      ["a", 30, true],
      ["b", 10, false],
    ]);
  });
  it("yields nothing for a full month", () => {
    expect(proratedFeeLines([{ id: "a", label: "Parking", amount: 60 }], leaseStartProration("2026-10-01"))).toEqual([]);
  });
});

describe("the ledger bills a monthly fee into both partial months", () => {
  it("adds a prorated parking line for the first and last month, no utilities line at $0", () => {
    const email = "fees-both@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-fees-both";
    seed(propertyId, [PARKING]);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });

    const rows = rowsFor(email);
    const byKind = (kind: string) => rows.filter((c) => c.kind === kind);
    expect(byKind("prorated_rent")[0]?.amountLabel).toBe("$485.00");
    expect(byKind("prorated_utilities")).toHaveLength(0);
    const first = byKind("prorated_fee")[0];
    expect(first?.customFeeId).toBe("cf-parking");
    expect(first?.title).toBe("Prorated bike parking (10/30 days from lease start)");
    expect(first?.amountLabel).toBe("$20.00");
    const last = byKind("prorated_last_month_fee")[0];
    expect(last?.title).toBe("Prorated last month's bike parking");
    expect(last?.amountLabel).toBe("$40.00");
    expect(last?.dueDateLabel).toBe("By Sep 13, 2027");
    // The recurring parking row starts the first FULL month and never repeats the partial one.
    const recurring = rows.filter((c) => c.customFeeId === "cf-parking" && c.rentMonth);
    expect(recurring.map((c) => c.rentMonth)).not.toContain("2026-09");
  });

  it("emits exactly one line per fee per month across repeated regeneration", () => {
    const email = "fees-once@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-fees-once";
    seed(propertyId, [PARKING]);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });
    const rows = rowsFor(email);
    expect(rows.filter((c) => c.kind === "prorated_fee")).toHaveLength(1);
    expect(rows.filter((c) => c.kind === "prorated_last_month_fee")).toHaveLength(1);
  });

  it("skips a $0 fee and bills nothing extra on a Seattle listing (the fee is inside rent)", () => {
    const zeroEmail = "fees-zero@example.com";
    removeResidentHouseholdPaymentData(zeroEmail);
    seed("prop-fees-zero", [{ id: "cf-storage", label: "Storage", amount: "0", frequency: "monthly" }]);
    recordApprovedApplicationCharges(applicant("prop-fees-zero", zeroEmail), MANAGER_ID, true, { leaseExecuted: true });
    expect(rowsFor(zeroEmail).filter((c) => c.kind === "prorated_fee" || c.kind === "prorated_last_month_fee")).toHaveLength(0);

    const seattleEmail = "fees-seattle@example.com";
    removeResidentHouseholdPaymentData(seattleEmail);
    seed("prop-fees-seattle", [PARKING], {}, "4709A 8th Ave NE, Seattle, WA 98105");
    recordApprovedApplicationCharges(applicant("prop-fees-seattle", seattleEmail), MANAGER_ID, true, { leaseExecuted: true });
    const seattleRows = rowsFor(seattleEmail);
    expect(seattleRows.filter((c) => c.kind === "prorated_fee" || c.kind === "prorated_last_month_fee")).toHaveLength(0);
    // Parking folded into rent: 10/30 of ($1,455 + $60).
    expect(seattleRows.find((c) => c.kind === "prorated_rent")?.amountLabel).toBe("$505.00");
  });

  it("bills the fee by its own per-day rate when the room is set per day", () => {
    const email = "fees-daily@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-fees-daily";
    seed(propertyId, [{ ...PARKING, dailyRate: 2 } as ListingFeeRow], { prorateMethod: "daily_rate", dailyRentRate: 40 });
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });
    const rows = rowsFor(email);
    expect(rows.find((c) => c.kind === "prorated_rent")?.title).toBe("Prorated first month's rent (10 days × $40/day)");
    const fee = rows.find((c) => c.kind === "prorated_fee");
    expect(fee?.title).toBe("Prorated bike parking (10 days × $2/day)");
    expect(fee?.amountLabel).toBe("$20.00");
    expect(rows.find((c) => c.kind === "prorated_last_month_fee")?.amountLabel).toBe("$40.00");
  });
});

describe("the lease document prints the same fee rows", () => {
  function context(): LeaseGenerationContext {
    const sub = submission([PARKING]);
    return {
      application: {
        fullLegalName: "Sohan Vivek Naik",
        email: "sohan@example.com",
        leaseTerm: "12-Month",
        leaseStart: "2026-09-21",
        leaseEnd: "2027-09-20",
        roomChoice1: "property-1::room-2",
      },
      leasedRoom: undefined,
      listingProperty: {
        id: "property-1",
        title: "8th Ave House",
        address: "1200 Pacific Ave, Tacoma, WA 98402",
        buildingName: "8th Ave House",
        unitLabel: "Room 2",
      } as LeaseGenerationContext["listingProperty"],
      submission: sub,
      generatedAtIso: "2026-09-01T00:00:00.000Z",
    };
  }

  it("prints the fee in the compact Washington lease's summary and schedule", () => {
    const html = buildLeaseHtml(context(), WASHINGTON_LEASE_CONFIG);
    expect(html).toContain("Prorated Bike parking for September 2026:</strong> $20.00");
    expect(html).toContain("Prorated Bike parking: <strong>$20.00</strong>");
    expect(html).toContain("Last Month&apos;s Bike parking for September 2027:</strong> $40.00");
    // Rent $970.00 + bike parking $40.00 for the final partial month.
    expect(html).toContain("rent, utilities and recurring charges total $1,010.00");
  });

  it("adds a row to the long form's Prorated First Month and Prorated Final Month tables", () => {
    const html = buildLeaseHtml(context(), CALIFORNIA_LEASE_CONFIG);
    expect(html).toContain("Prorated First Month");
    expect(html).toContain("<tr><td>Bike parking</td><td>$60.00</td><td>10 / 30</td><td>$20.00</td></tr>");
    // Rent $485.00 + bike parking $20.00.
    expect(html).toContain("<strong>Prorated total due first month</strong></td><td><strong>$505.00</strong>");
    expect(html).toContain("Prorated Final Month");
    expect(html).toContain("<tr><td>Last month&apos;s Bike parking</td><td>$60.00/mo</td><td>20 / 30</td><td>$40.00</td></tr>");
    // Rent $970.00 + bike parking $40.00.
    expect(html).toContain("<strong>Total due for the final month</strong></td><td><strong>$1,010.00</strong>");
  });
});
