/**
 * @vitest-environment jsdom
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
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";
import { mergeApplicationLeaseDatesIntoResidentRow } from "@/lib/resident-lease-billing-sync";

const MANAGER_ID = "mgr-billing-sync";
const PROPERTY_ID = "mgr-brooklyn-5257";
const ROOM_ID = "room-7";
const EMAIL = "dashaa@example.com";

function seedListing(submission: ManagerListingSubmissionV1): void {
  cachePublicExtraListings([
    {
      id: PROPERTY_ID,
      title: "5257 Brooklyn Ave NE",
      managerUserId: MANAGER_ID,
      listingSubmission: submission,
    } satisfies MockProperty,
  ]);
}

function residentRow(leaseStart: string): DemoApplicantRow {
  const roomChoice = `${PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}${ROOM_ID}`;
  return {
    id: "PROPLANE-TEST",
    name: "Dashnyam Puntsagnorov",
    email: EMAIL,
    property: "5257 Brooklyn Ave NE",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Active",
    managerUserId: MANAGER_ID,
    manuallyAdded: true,
    signedMonthlyRent: 825,
    manualResidentDetails: {
      moveInDate: leaseStart,
      moveOutDate: "2027-03-31",
      roomNumber: "Room 7",
      monthlyUtilities: 200,
      moveInFee: 150,
      securityDeposit: 400,
    },
    application: {
      propertyId: PROPERTY_ID,
      roomChoice1: roomChoice,
      leaseStart,
      leaseEnd: "2027-03-31",
      leaseTerm: "Custom",
      rentalType: "long_term",
      fullLegalName: "Dashnyam Puntsagnorov",
      email: EMAIL,
    },
  };
}

describe("resident lease billing sync", () => {
  beforeEach(() => {
    removeResidentHouseholdPaymentData(EMAIL);
    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...sub.rooms[0]!,
        id: ROOM_ID,
        name: "Room 7",
        monthlyRent: 825,
        utilitiesEstimate: "200",
        utilitiesPaymentModel: "manager_billed",
        prorateMethod: "daily_rate",
        dailyRentRate: 30,
        dailyUtilitiesRate: 7,
      },
    ];
    sub = normalizeManagerListingSubmissionV1(sub);
    seedListing(sub);
  });

  it("mirrors application lease dates onto manual resident details", () => {
    const row = residentRow("2026-08-30");
    const merged = mergeApplicationLeaseDatesIntoResidentRow(row, {
      ...row.application!,
      leaseStart: "2026-09-01",
      leaseEnd: "2027-03-31",
    });
    expect(merged.manualResidentDetails?.moveInDate).toBe("2026-09-01");
    expect(merged.application?.leaseStart).toBe("2026-09-01");
  });

  it("regenerates prorated rent when move-in date changes", () => {
    recordApprovedApplicationCharges(residentRow("2026-08-30"), MANAGER_ID, true);
    let charges = readHouseholdCharges();
    expect(charges.some((c) => c.kind === "prorated_rent" && c.title.includes("2 days"))).toBe(true);

    recordApprovedApplicationCharges(residentRow("2026-09-01"), MANAGER_ID, true);
    charges = readHouseholdCharges();
    expect(charges.some((c) => c.kind === "prorated_rent")).toBe(false);
    expect(charges.some((c) => c.kind === "first_month_rent" && c.title === "First month's rent")).toBe(true);
  });

  it("rebuilds stale prorated rows on reconcile when move-in moves to the 1st", () => {
    recordApprovedApplicationCharges(residentRow("2026-08-30"), MANAGER_ID, true);
    expect(readHouseholdCharges().some((c) => c.kind === "prorated_rent")).toBe(true);

    recordApprovedApplicationCharges(residentRow("2026-09-01"), MANAGER_ID, false);
    const charges = readHouseholdCharges();
    expect(charges.some((c) => c.kind === "prorated_rent")).toBe(false);
    expect(charges.some((c) => c.kind === "first_month_rent")).toBe(true);
  });
});
