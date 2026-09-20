/**
 * @vitest-environment jsdom
 *
 * A shared room priced per resident (PLAN-0920-0631): two roommates in the SAME room,
 * each with their own negotiated rent, utilities and fee scope, against the same
 * `recordApprovedApplicationCharges` path the manager portal runs on approval.
 *
 * The approval pick itself (writing `managerRentOverride` / `managerUtilitiesOverride` /
 * `residentSlot` onto the application) is a different slice — these tests construct
 * already-approved applications carrying those fields, exactly as that slice would leave
 * them, and prove the LEDGER bills each resident at their own figures: rent and deposit
 * already ride the existing negotiated-rent path (`managerRentOverride`), utilities already
 * prefer `managerUtilitiesOverride` over the room's estimate, and a fee scoped to one
 * resident slot (`ListingFeeRow.residentSlots`) never bills the other resident of the same
 * room. A room that does NOT price per resident bills exactly as before — proven against the
 * same fixture and numbers as `tests/unit/custom-fee-monthly-charges.test.ts`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerCustomFeeRow,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-per-resident-charges";

// Tacoma, not Seattle: fees bill as their own separate recurring charge instead of folding
// into rent (see tests/unit/seattle-rent-fold-in.test.ts for the folded case).
const ADDRESS = { address: "1200 Pacific Ave, Tacoma, WA", zip: "98402" };

function twoResidentRoom(): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return {
    ...base,
    id: "room-1",
    name: "Room 1",
    monthlyRent: 1000,
    utilitiesEstimate: "0",
    occupancyCapacity: 2,
    residentPricing: "per_resident",
    residentPrices: [
      { monthlyRent: 900, utilitiesEstimate: "75" },
      { monthlyRent: 800, utilitiesEstimate: "75" },
    ],
  } as ManagerRoomSubmission;
}

function oneResidentRoom(): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Room 1", monthlyRent: 1200, utilitiesEstimate: "" } as ManagerRoomSubmission;
}

function seed(propertyId: string, room: ManagerRoomSubmission, customFees: ManagerCustomFeeRow[]): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [room];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.customFees = customFees;
  const property: MockProperty = {
    id: propertyId,
    title: "Roommate House",
    tagline: "",
    ...ADDRESS,
    neighborhood: "Downtown",
    beds: 1,
    baths: 1,
    rentLabel: "$900/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Roommate House",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

// Lease Mar 10 → Jun 12 2026: recurring full months are 2026-04 and 2026-05 (move-in month
// 2026-03 and move-out month 2026-06 bill as partial/prorated lines instead).
function applicant(
  propertyId: string,
  email: string,
  override: { managerRentOverride: string; managerUtilitiesOverride: string; residentSlot?: number },
): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Roommate House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
      rentalType: "standard",
      leaseStart: "2026-03-10",
      leaseEnd: "2026-06-12",
      fullLegalName: "Dana Tenant",
      managerRentOverride: override.managerRentOverride,
      managerUtilitiesOverride: override.managerUtilitiesOverride,
      residentSlot: override.residentSlot,
    },
  } as unknown as DemoApplicantRow;
}

function chargesFor(email: string) {
  return readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase());
}

function rentAndUtilCharges(email: string) {
  return chargesFor(email)
    .filter((c) => c.kind.includes("rent") || c.kind.includes("util"))
    .map((c) => ({ month: c.rentMonth ?? c.title, kind: c.kind, amount: c.amountLabel }))
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
}

function parkingCharges(email: string) {
  return chargesFor(email)
    .filter((c) => c.customFeeId === "cf-parking")
    .sort((a, b) => (a.rentMonth ?? "").localeCompare(b.rentMonth ?? ""));
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("a shared room priced per resident", () => {
  const propertyId = "prop-roommates";
  // Label deliberately avoids the built-in "Parking" preset's default label — an exact
  // (case-insensitive) match there gets the row silently re-tagged onto the parking_monthly
  // preset by normalizeListingFeeRow's legacy-recovery step, and loses this custom row's
  // amount and residentSlots to the untouched (blank) legacy preset instead.
  const parkingFee: ManagerCustomFeeRow = {
    id: "cf-parking",
    label: "Assigned parking spot",
    amount: "50",
    frequency: "monthly",
    residentSlots: [1],
  } as ManagerCustomFeeRow;

  it("bills Resident 1 ($900 rent, $75 utilities, Parking) at their own figures", () => {
    const email = "resident1@example.com";
    removeResidentHouseholdPaymentData(email);
    seed(propertyId, twoResidentRoom(), [parkingFee]);

    recordApprovedApplicationCharges(
      applicant(propertyId, email, { managerRentOverride: "900", managerUtilitiesOverride: "75", residentSlot: 1 }),
      MANAGER_ID,
      true,
      { leaseExecuted: true },
    );

    const rows = rentAndUtilCharges(email);
    // First (partial) month: 22/31 billable days.
    expect(rows.find((r) => r.kind === "prorated_rent")?.amount).toBe("$638.71");
    expect(rows.find((r) => r.kind === "prorated_utilities")?.amount).toBe("$53.23");
    // Full recurring months bill the flat negotiated figures.
    const april = readHouseholdCharges().find(
      (c) => c.residentEmail.toLowerCase() === email && c.kind === "rent" && c.rentMonth === "2026-04",
    );
    expect(april?.amountLabel).toBe("$900.00");
    const aprilUtil = readHouseholdCharges().find(
      (c) => c.residentEmail.toLowerCase() === email && c.kind === "utilities" && c.rentMonth === "2026-04",
    );
    expect(aprilUtil?.amountLabel).toBe("$75.00");
    // Last (partial) month: 12/30 billable days.
    expect(rows.find((r) => r.kind === "prorated_last_month_rent")?.amount).toBe("$360.00");
    expect(rows.find((r) => r.kind === "prorated_last_month_utilities")?.amount).toBe("$30.00");

    // Parking is scoped to Resident 1 and bills: prorated first month, full recurring
    // months, and a prorated last month.
    const parking = parkingCharges(email);
    expect(parking.find((c) => c.kind === "prorated_fee")?.amountLabel).toBe("$35.48");
    expect(parking.find((c) => c.kind === "prorated_last_month_fee")?.amountLabel).toBe("$20.00");
    const parkingRecurring = parking.filter((c) => c.kind === "other_cost" && c.rentMonth);
    expect(parkingRecurring.map((c) => c.rentMonth)).toEqual(["2026-04", "2026-05"]);
    expect(parkingRecurring.every((c) => c.amountLabel === "$50.00")).toBe(true);
  });

  it("never bills Resident 2 ($800 rent, $75 utilities, no Parking) for the Parking fee", () => {
    const email = "resident2@example.com";
    removeResidentHouseholdPaymentData(email);
    seed(propertyId, twoResidentRoom(), [parkingFee]);

    recordApprovedApplicationCharges(
      applicant(propertyId, email, { managerRentOverride: "800", managerUtilitiesOverride: "75", residentSlot: 2 }),
      MANAGER_ID,
      true,
      { leaseExecuted: true },
    );

    const rows = rentAndUtilCharges(email);
    expect(rows.find((r) => r.kind === "prorated_rent")?.amount).toBe("$567.74");
    expect(rows.find((r) => r.kind === "prorated_utilities")?.amount).toBe("$53.23");
    const april = readHouseholdCharges().find(
      (c) => c.residentEmail.toLowerCase() === email && c.kind === "rent" && c.rentMonth === "2026-04",
    );
    expect(april?.amountLabel).toBe("$800.00");
    expect(rows.find((r) => r.kind === "prorated_last_month_rent")?.amount).toBe("$320.00");

    // Resident 2 holds no slot the Parking fee names, so no Parking charge of any kind
    // — first-month, recurring, or last-month — is ever created for them.
    expect(parkingCharges(email)).toHaveLength(0);
  });
});

describe("a room that does not price per resident bills exactly as before", () => {
  it("matches the pre-existing monthly custom fee fixture and figures unchanged", () => {
    const email = "monthly-recur-parity@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-monthly-recur-parity";
    seed(propertyId, oneResidentRoom(), [{ id: "cf-bike", label: "Bike storage", amount: "100", frequency: "monthly" }]);

    recordApprovedApplicationCharges(
      applicant(propertyId, email, { managerRentOverride: "", managerUtilitiesOverride: "" }),
      MANAGER_ID,
      true,
      { leaseExecuted: true },
    );

    const bikeRows = chargesFor(email)
      .filter((c) => c.customFeeId === "cf-bike" && c.kind === "other_cost")
      .sort((a, b) => (a.rentMonth ?? "").localeCompare(b.rentMonth ?? ""));
    const months = bikeRows.map((r) => r.rentMonth);
    expect(months).toEqual(["2026-04", "2026-05"]);
    expect(bikeRows.every((r) => r.amountLabel === "$100.00")).toBe(true);
    const first = chargesFor(email).find((c) => c.customFeeId === "cf-bike" && c.kind === "prorated_fee");
    const last = chargesFor(email).find((c) => c.customFeeId === "cf-bike" && c.kind === "prorated_last_month_fee");
    expect(first?.amountLabel).toBe("$70.97");
    expect(last?.amountLabel).toBe("$40.00");

    // No override, no slot: rent bills the room's own flat monthly figure, unchanged.
    const april = chargesFor(email).find((c) => c.kind === "rent" && c.rentMonth === "2026-04");
    expect(april?.amountLabel).toBe("$1,200.00");
  });
});
