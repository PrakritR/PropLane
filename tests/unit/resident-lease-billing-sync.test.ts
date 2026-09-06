/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  seedDemoHouseholdCharges,
  type HouseholdCharge,
  reconcileApprovedResidentPaymentSchedules,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { writeManagerApplicationRows } from "@/lib/manager-applications-storage";
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

  it("drops stale proration when lease start moves mid-month (16-day then 9-day)", () => {
    recordApprovedApplicationCharges(residentRow("2026-09-15"), MANAGER_ID, true);
    let charges = readHouseholdCharges();
    expect(charges.filter((c) => c.kind === "prorated_rent")).toHaveLength(1);
    expect(charges.find((c) => c.kind === "prorated_rent")?.title).toContain("16 days");

    recordApprovedApplicationCharges(residentRow("2026-09-21"), MANAGER_ID, false);
    charges = readHouseholdCharges();
    const proratedRent = charges.filter((c) => c.kind === "prorated_rent");
    expect(proratedRent).toHaveLength(1);
    expect(proratedRent[0]?.title).toContain("10 days");
    expect(proratedRent[0]?.title).not.toContain("16 days");
  });

  it("keeps pending resident charges when payment schedules reconcile", () => {
    const pending = { ...residentRow("2026-09-01"), bucket: "pending" as const, stage: "Submitted" };
    writeManagerApplicationRows([pending]);
    removeResidentHouseholdPaymentData(EMAIL);
    recordApprovedApplicationCharges(pending, MANAGER_ID, true);
    expect(readHouseholdCharges().some((c) => c.kind === "security_deposit")).toBe(true);

    reconcileApprovedResidentPaymentSchedules(MANAGER_ID, true);

    const charges = readHouseholdCharges();
    expect(charges.some((c) => c.kind === "security_deposit")).toBe(true);
  });
  it("retains source charges through ordinary reconciliation and forced regeneration", () => {
    const row = residentRow("2026-09-01");
    writeManagerApplicationRows([row]);
    const charges: HouseholdCharge[] = ["bill-one", "bill-two", "history-one", "history-two"].map((id, i) => ({
      id, applicationId: row.id, managerUserId: MANAGER_ID, residentEmail: EMAIL, residentName: row.name,
      propertyId: PROPERTY_ID, propertyLabel: row.property, kind: i < 2 ? "utilities" : "rent",
      title: id, createdAt: "2026-09-01T00:00:00Z", amountLabel: "$50.00", balanceLabel: "$50.00", status: "pending", blocksLeaseUntilPaid: false,
      ...(i < 2 ? { utilityAllocationId: id, sourceUtilityBillId: id } : { migrationSourceId: id }),
    }));
    seedDemoHouseholdCharges(charges, []);
    recordApprovedApplicationCharges(row, MANAGER_ID, false);
    recordApprovedApplicationCharges(row, MANAGER_ID, true);
    reconcileApprovedResidentPaymentSchedules(MANAGER_ID, true);
    for (const source of charges) expect(readHouseholdCharges().find(c => c.id === source.id)).toMatchObject(source);
  });
  it("holds new imported tenancies out of automatic billing without deleting their history", () => {
    const row = { ...residentRow("2026-09-01"), migrationBillingHold: true };
    writeManagerApplicationRows([row]);
    const source: HouseholdCharge = { id: "imported-history", applicationId: row.id, managerUserId: MANAGER_ID, residentEmail: EMAIL, residentName: row.name, propertyId: PROPERTY_ID, propertyLabel: row.property, kind: "rent", title: "Opening balance", createdAt: "2026-09-01T00:00:00Z", amountLabel: "$50.00", balanceLabel: "$50.00", status: "pending", blocksLeaseUntilPaid: false, migrationSourceId: "source" };
    seedDemoHouseholdCharges([source], []);
    expect(recordApprovedApplicationCharges(row, MANAGER_ID, true)).toBe(false);
    reconcileApprovedResidentPaymentSchedules(MANAGER_ID, true);
    expect(readHouseholdCharges()).toEqual([source]);
  });

});
