/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";

const MANAGER_ID = "mgr-lease-billing-snapshot";

function seedListing(propertyId: string, submission: ManagerListingSubmissionV1): void {
  const property: MockProperty = {
    id: propertyId,
    title: "Proration House",
    managerUserId: MANAGER_ID,
    listingSubmission: submission,
  };
  cachePublicExtraListings([property]);
}

function applicantRow(propertyId: string, email: string): DemoApplicantRow {
  const roomId = "room-1";
  const roomChoice = `Room 1${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  return {
    id: `app-${email}`,
    name: "Sohan Naik",
    email,
    property: "Proration House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Approved",
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: roomChoice,
      leaseStart: "2026-09-22",
      leaseEnd: "2026-12-01",
      leaseTerm: "Custom",
      rentalType: "standard",
      fullLegalName: "Sohan Naik",
      managerRentOverride: "$800",
      managerUtilitiesOverride: "$200",
    },
  } as unknown as DemoApplicantRow;
}

describe("buildLeaseBillingSnapshot", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("prorates the first month with daily rates from the room listing", () => {
    const propertyId = "prop-proration-daily";
    const email = "daily-prorate@example.com";
    removeResidentHouseholdPaymentData(email);

    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        monthlyRent: 800,
        utilitiesEstimate: "200",
        prorateMethod: "daily_rate",
        dailyRentRate: 30,
        dailyUtilitiesRate: 7,
      },
    ];
    sub.securityDeposit = "400";
    sub.moveInFee = "150";
    sub = normalizeManagerListingSubmissionV1(sub);
    seedListing(propertyId, sub);

    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);

    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.proratedRent).toBe(270);
    expect(billing.proratedUtilities).toBe(63);

    const rentCharge = readHouseholdCharges().find(
      (c) => c.residentEmail === email && c.kind === "prorated_rent",
    );
    expect(rentCharge?.amountLabel).toBe("$270.00");
  });

  it("uses auto proration when the room is on divide/auto", () => {
    const propertyId = "prop-proration-auto";
    const email = "auto-prorate@example.com";
    removeResidentHouseholdPaymentData(email);

    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        monthlyRent: 800,
        utilitiesEstimate: "200",
        prorateMethod: "auto",
      },
    ];
    sub = normalizeManagerListingSubmissionV1(sub);
    seedListing(propertyId, sub);

    const row = applicantRow(propertyId, email);
    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.proratedRent).toBe(240);
    expect(billing.proratedUtilities).toBe(60);
  });

  it("does not treat last-month proration as the first-month figure", () => {
    const propertyId = "prop-proration-last-month";
    const email = "last-month@example.com";
    removeResidentHouseholdPaymentData(email);

    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...emptyRoom(0),
        id: "room-1",
        name: "Room 1",
        monthlyRent: 800,
        utilitiesEstimate: "200",
        prorateMethod: "auto",
      },
    ];
    sub = normalizeManagerListingSubmissionV1(sub);
    seedListing(propertyId, sub);

    const row = applicantRow(propertyId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);

    const billing = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(billing.proratedRent).toBe(240);
    expect(billing.proratedUtilities).toBe(60);
    expect(readHouseholdCharges().some((c) => c.residentEmail === email && c.kind === "prorated_last_month_rent")).toBe(
      true,
    );
  });
});
