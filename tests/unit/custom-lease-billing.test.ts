/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL,
  CUSTOM_LEASE_SURCHARGE_FEE_ID,
  recurringMonthlyFeesForLease,
  shouldBillCustomLeaseSurcharge,
} from "@/lib/custom-lease-billing";
import {
  readHouseholdCharges,
  readRecurringRentProfilesForManager,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-custom-lease-billing";

function seedListing(propertyId: string, submission: ManagerListingSubmissionV1): MockProperty {
  const property: MockProperty = {
    id: propertyId,
    title: "Calendar Lease House",
    managerUserId: MANAGER_ID,
    listingSubmission: submission,
  };
  cachePublicExtraListings([property]);
  return property;
}

function applicantRow(
  propertyId: string,
  email: string,
  leaseStart: string,
  leaseEnd: string,
): DemoApplicantRow {
  const roomId = "room-1";
  const roomChoice = `Room A${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  return {
    id: `app-${email}`,
    name: "Alex Resident",
    email,
    property: "Calendar Lease House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Approved",
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: roomChoice,
      leaseStart,
      leaseEnd,
      leaseTerm: "12-Month",
      rentalType: "standard",
      fullLegalName: "Alex Resident",
    },
  } as unknown as DemoApplicantRow;
}

function listingWithCustomLeaseSurcharge(amount: string): ManagerListingSubmissionV1 {
  let sub = createDefaultListingSubmission();
  sub.rooms = [{ ...sub.rooms[0]!, id: "room-1", name: "Room A", monthlyRent: 1200 }];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub = applyListingFeesToSubmission(sub, [
    {
      id: "fee-custom-lease",
      presetId: "custom_lease_surcharge",
      label: "Custom lease",
      amount,
      frequency: "monthly",
    },
  ]);
  return normalizeManagerListingSubmissionV1(sub);
}

describe("custom lease surcharge billing", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("bills the surcharge only for non-calendar lease dates", () => {
    expect(
      shouldBillCustomLeaseSurcharge({
        leaseStart: "2026-06-01",
        leaseEnd: "2027-05-31",
        leaseTerm: "12-Month",
        rentalType: "standard",
      }),
    ).toBe(false);
    expect(
      shouldBillCustomLeaseSurcharge({
        leaseStart: "2026-06-15",
        leaseEnd: "2027-06-14",
        leaseTerm: "12-Month",
        rentalType: "standard",
      }),
    ).toBe(true);
    expect(
      shouldBillCustomLeaseSurcharge({
        leaseStart: "2026-06-01",
        leaseEnd: "2027-05-31",
        leaseTerm: "Month-to-Month",
        rentalType: "standard",
      }),
    ).toBe(false);
  });

  it("adds a recurring Custom lease fee on approval when dates are custom", () => {
    const email = "custom-calendar@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-custom-calendar";
    seedListing(propertyId, listingWithCustomLeaseSurcharge("75"));

    recordApprovedApplicationCharges(
      applicantRow(propertyId, email, "2026-06-15", "2027-06-14"),
      MANAGER_ID,
      true,
    );

    const profile = readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail === email);
    expect(profile?.monthlyFees?.some((fee) => fee.id === CUSTOM_LEASE_SURCHARGE_FEE_ID)).toBe(true);

    const recurringCustomLease = readHouseholdCharges().filter(
      (c) =>
        c.residentEmail === email &&
        c.customFeeId === CUSTOM_LEASE_SURCHARGE_FEE_ID &&
        c.title.startsWith(`${CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL} —`),
    );
    expect(recurringCustomLease.length).toBeGreaterThan(0);
    expect(recurringCustomLease.every((c) => c.amountLabel === "$75.00")).toBe(true);
  });

  it("skips the surcharge for a standard calendar lease", () => {
    const email = "standard-calendar@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-standard-calendar";
    seedListing(propertyId, listingWithCustomLeaseSurcharge("75"));

    recordApprovedApplicationCharges(
      applicantRow(propertyId, email, "2026-06-01", "2027-05-31"),
      MANAGER_ID,
      true,
    );

    const profile = readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail === email);
    expect(profile?.monthlyFees?.some((fee) => fee.id === CUSTOM_LEASE_SURCHARGE_FEE_ID)).toBe(false);
    expect(
      readHouseholdCharges().some(
        (c) => c.residentEmail === email && c.customFeeId === CUSTOM_LEASE_SURCHARGE_FEE_ID,
      ),
    ).toBe(false);
  });

  it("recurringMonthlyFeesForLease drops the surcharge when dates become standard", () => {
    const sub = listingWithCustomLeaseSurcharge("50");
    const custom = recurringMonthlyFeesForLease(sub, [], {
      leaseStart: "2026-06-15",
      leaseEnd: "2027-06-14",
      leaseTerm: "12-Month",
      rentalType: "standard",
    });
    expect(custom).toEqual([
      { id: CUSTOM_LEASE_SURCHARGE_FEE_ID, label: CUSTOM_LEASE_SURCHARGE_CHARGE_LABEL, amount: 50 },
    ]);

    const standard = recurringMonthlyFeesForLease(sub, custom, {
      leaseStart: "2026-06-01",
      leaseEnd: "2027-05-31",
      leaseTerm: "12-Month",
      rentalType: "standard",
    });
    expect(standard).toEqual([]);
  });
});
