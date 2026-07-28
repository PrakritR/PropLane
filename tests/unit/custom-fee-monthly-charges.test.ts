/**
 * @vitest-environment jsdom
 *
 * Monthly recurring custom-fee billing ([key=custom-fee-monthly]). A monthly custom fee
 * bills its FULL amount each recurring month (flat monthly service, not prorated), starting
 * the first full month after move-in — the partial move-in month is not charged. Design
 * choices proven here: exactly one row per month across repeated syncs (no double-emission),
 * removing a fee keeps already-emitted (owed) months but stops new emission, and an amount
 * change leaves already-emitted months untouched.
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

const MANAGER_ID = "mgr-custom-monthly";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Room 1", monthlyRent: 1200, utilitiesEstimate: "", ...over } as ManagerRoomSubmission;
}

function seed(propertyId: string, customFees: ManagerCustomFeeRow[]): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [room({})];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.customFees = customFees;
  const property: MockProperty = {
    id: propertyId,
    title: "Monthly Fee House",
    tagline: "",
    address: "1500 Pike St, Seattle, WA",
    zip: "98101",
    neighborhood: "Belltown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Monthly Fee House",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

// Lease Mar 10 → Jun 12 2026: recurring months are 2026-04, 2026-05, 2026-06 (move-in month
// 2026-03 is covered by the first-month charge, not the recurring loop).
function applicant(propertyId: string, email: string): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Monthly Fee House",
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
    },
  } as unknown as DemoApplicantRow;
}

function parkingRows(email: string) {
  return readHouseholdCharges()
    .filter(
      (c) =>
        c.residentEmail.toLowerCase() === email.toLowerCase() &&
        c.kind === "other_cost" &&
        c.customFeeId === "cf-parking",
    )
    .sort((a, b) => (a.rentMonth ?? "").localeCompare(b.rentMonth ?? ""));
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("monthly recurring custom fee", () => {
  it("bills the full amount each recurring month, not the partial move-in month", () => {
    const email = "monthly-recur@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-monthly-recur";
    seed(propertyId, [{ id: "cf-parking", label: "Parking", amount: "100", frequency: "monthly" }]);

    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    const rows = parkingRows(email);
    const months = rows.map((r) => r.rentMonth);
    expect(months).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(rows.every((r) => r.amountLabel === "$100.00")).toBe(true);
    expect(rows.every((r) => Boolean(r.recurringRentProfileId))).toBe(true);
    // Move-in month is not charged the monthly fee.
    expect(months).not.toContain("2026-03");
  });

  it("does not double-emit when charge generation runs repeatedly", () => {
    const email = "monthly-nodup@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-monthly-nodup";
    seed(propertyId, [{ id: "cf-parking", label: "Parking", amount: "100", frequency: "monthly" }]);

    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    // Still exactly one row per month.
    expect(parkingRows(email).map((r) => r.rentMonth)).toEqual(["2026-04", "2026-05", "2026-06"]);
  });

  it("removing the fee keeps already-emitted (owed) months and emits no new ones", () => {
    const email = "monthly-remove@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-monthly-remove";
    seed(propertyId, [{ id: "cf-parking", label: "Parking", amount: "100", frequency: "monthly" }]);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);
    expect(parkingRows(email)).toHaveLength(3);

    // Manager removes the fee from the listing, then charge-gen runs again.
    seed(propertyId, []);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    // The already-emitted months are NOT silently deleted (the resident may owe them),
    // and no new ones appear.
    expect(parkingRows(email)).toHaveLength(3);
  });

  it("an amount change does not alter already-emitted months", () => {
    const email = "monthly-amount@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-monthly-amount";
    seed(propertyId, [{ id: "cf-parking", label: "Parking", amount: "100", frequency: "monthly" }]);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    seed(propertyId, [{ id: "cf-parking", label: "Parking", amount: "150", frequency: "monthly" }]);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    // Every already-emitted month keeps its original $100 — future months (none here) would
    // use $150.
    expect(parkingRows(email).every((r) => r.amountLabel === "$100.00")).toBe(true);
  });
});
