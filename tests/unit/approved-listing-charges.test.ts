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
  applyEntireHomeListingPricing,
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";

const MANAGER_ID = "mgr-listing-charges";

function seedListing(propertyId: string, submission: ManagerListingSubmissionV1): MockProperty {
  const property: MockProperty = {
    id: propertyId,
    title: "5257 Brooklyn",
    managerUserId: MANAGER_ID,
    listingSubmission: submission,
  };
  cachePublicExtraListings([property]);
  return property;
}

function applicantRow(propertyId: string, roomId: string, email: string): DemoApplicantRow {
  const roomChoice = `Room A${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  return {
    id: `app-${email}`,
    name: "Junaid Mohammed",
    email,
    property: "5257 Brooklyn",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Approved",
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: roomChoice,
      leaseStart: "2026-08-01",
      leaseEnd: "2027-07-31",
      leaseTerm: "12 months",
      fullLegalName: "Junaid Mohammed",
    },
  };
}

describe("approved listing-sourced resident charges", () => {
  beforeEach(() => {
    removeResidentHouseholdPaymentData("junaid@example.com");
  });

  it("uses unified listing fee rows for deposit and move-in amounts", () => {
    const propertyId = "prop-fees-unified";
    const roomId = "room-a";
    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...sub.rooms[0]!,
        id: roomId,
        name: "Room A",
        monthlyRent: 825,
        utilitiesEstimate: "175",
        utilitiesPaymentModel: "manager_billed",
      },
    ];
    sub = applyListingFeesToSubmission(sub, [
      {
        id: "fee-sec",
        presetId: "security_deposit",
        label: "Security deposit",
        amount: "500",
        frequency: "one-time",
        dueAtSigning: true,
      },
      {
        id: "fee-move",
        presetId: "move_in_fee",
        label: "Move-in fee",
        amount: "150",
        frequency: "one-time",
        dueAtSigning: true,
      },
    ]);
    sub.securityDeposit = "";
    sub.moveInFee = "";
    seedListing(propertyId, normalizeManagerListingSubmissionV1(sub));

    const email = "junaid@example.com";
    recordApprovedApplicationCharges(applicantRow(propertyId, roomId, email), MANAGER_ID, true, { leaseExecuted: true });

    const charges = readHouseholdCharges().filter((c) => c.residentEmail === email);
    expect(charges.find((c) => c.kind === "first_month_rent")?.amountLabel).toBe("$825.00");
    expect(charges.find((c) => c.kind === "utilities")?.amountLabel).toBe("$175.00");
    expect(charges.find((c) => c.kind === "security_deposit")?.amountLabel).toBe("$500.00");
    expect(charges.find((c) => c.kind === "move_in_fee")?.amountLabel).toBe("$150.00");
  });

  it("bills entire-home rent from entireHomeMonthlyRent", () => {
    const propertyId = "prop-entire-home";
    let sub = createDefaultListingSubmission();
    sub = applyEntireHomeListingPricing(sub, {
      entireHomeMonthlyRent: 2400,
      entireHomeUtilitiesEstimate: "200",
      entireHomeUtilitiesPaymentModel: "manager_billed",
    });
    sub = applyListingFeesToSubmission(sub, [
      {
        id: "fee-sec",
        presetId: "security_deposit",
        label: "Security deposit",
        amount: "1200",
        frequency: "one-time",
        dueAtSigning: true,
      },
      {
        id: "fee-move",
        presetId: "move_in_fee",
        label: "Move-in fee",
        amount: "0",
        frequency: "one-time",
        dueAtSigning: true,
      },
    ]);
    const roomId = sub.rooms.find((room) => room.name.trim())?.id ?? "room-home";
    seedListing(propertyId, normalizeManagerListingSubmissionV1(sub));

    const email = "junaid@example.com";
    const row = applicantRow(propertyId, roomId, email);
    row.application = { ...row.application!, roomChoice1: "", leaseStart: "2026-08-01" };
    row.assignedRoomChoice = "";
    recordApprovedApplicationCharges(row, MANAGER_ID, true, { leaseExecuted: true });

    const charges = readHouseholdCharges().filter((c) => c.residentEmail === email);
    expect(charges.find((c) => c.kind === "first_month_rent")?.amountLabel).toBe("$2,400.00");
    expect(charges.find((c) => c.kind === "utilities")?.amountLabel).toBe("$200.00");
    expect(charges.find((c) => c.kind === "security_deposit")?.amountLabel).toBe("$1,200.00");
  });

  it("refreshes pending charge amounts when listing fees change", () => {
    const propertyId = "prop-fee-refresh";
    const roomId = "room-a";
    let sub = createDefaultListingSubmission();
    sub.rooms = [
      {
        ...sub.rooms[0]!,
        id: roomId,
        name: "Room A",
        monthlyRent: 825,
        utilitiesEstimate: "175",
        utilitiesPaymentModel: "manager_billed",
      },
    ];
    sub.securityDeposit = "400";
    sub.moveInFee = "100";
    seedListing(propertyId, normalizeManagerListingSubmissionV1(sub));

    const email = "junaid@example.com";
    const row = applicantRow(propertyId, roomId, email);
    recordApprovedApplicationCharges(row, MANAGER_ID, true, { leaseExecuted: true });

    sub = applyListingFeesToSubmission(normalizeManagerListingSubmissionV1(sub), [
      {
        id: "fee-sec",
        presetId: "security_deposit",
        label: "Security deposit",
        amount: "500",
        frequency: "one-time",
        dueAtSigning: true,
      },
      {
        id: "fee-move",
        presetId: "move_in_fee",
        label: "Move-in fee",
        amount: "150",
        frequency: "one-time",
        dueAtSigning: true,
      },
    ]);
    seedListing(propertyId, normalizeManagerListingSubmissionV1(sub));

    const refreshed = recordApprovedApplicationCharges(row, MANAGER_ID, false, { leaseExecuted: true });
    expect(refreshed).toBe(true);

    const charges = readHouseholdCharges().filter((c) => c.residentEmail === email);
    expect(charges.find((c) => c.kind === "security_deposit")?.amountLabel).toBe("$500.00");
    expect(charges.find((c) => c.kind === "move_in_fee")?.amountLabel).toBe("$150.00");
  });
});
