/**
 * @vitest-environment jsdom
 *
 * PLAN-0922-1904: lease charges read the resident slot, not room.monthlyRent.
 * These applications carry NO managerRentOverride — the ledger must still
 * bill Resident 2 $800 and skip Resident 1's parking.
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

const MANAGER_ID = "mgr-slot-charges";
const PROPERTY_ID = "prop-room-3-slots";

function room3(): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return {
    ...base,
    id: "room-3",
    name: "Room 3",
    monthlyRent: 900,
    utilitiesEstimate: "50",
    occupancyCapacity: 2,
    residentPricing: "per_resident",
    residentPrices: [
      { monthlyRent: 900, utilitiesEstimate: "50" },
      { monthlyRent: 800, utilitiesEstimate: "50" },
    ],
  } as ManagerRoomSubmission;
}

function seed(parking: ManagerCustomFeeRow) {
  const sub = createDefaultListingSubmission();
  sub.rooms = [room3()];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.customFees = [parking];
  const property: MockProperty = {
    id: PROPERTY_ID,
    title: "4709A 8th Ave NE",
    tagline: "",
    address: "1200 Pacific Ave, Tacoma, WA",
    zip: "98402",
    neighborhood: "Downtown",
    beds: 3,
    baths: 2,
    rentLabel: "$800/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "4709A 8th Ave NE",
    unitLabel: "Room 3",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

function applicant(email: string, residentSlot: number): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: residentSlot === 1 ? "Resident 1" : "Resident 2",
    email,
    property: "4709A 8th Ave NE",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    assignedRoomChoice: `${PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-3`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId: PROPERTY_ID,
      roomChoice1: `${PROPERTY_ID}${LISTING_ROOM_CHOICE_SEP}room-3`,
      rentalType: "standard",
      leaseStart: "2026-09-15",
      leaseEnd: "2026-09-30",
      fullLegalName: residentSlot === 1 ? "Resident 1" : "Resident 2",
      residentSlot,
    },
  } as unknown as DemoApplicantRow;
}

const parking: ManagerCustomFeeRow = {
  id: "cf-parking-r1",
  label: "Assigned parking spot",
  amount: "75",
  frequency: "monthly",
  residentSlots: [1],
} as ManagerCustomFeeRow;

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("household charges read the resident slot", () => {
  it("bills Resident 2 $800 rent and $50 utilities with no parking", () => {
    const email = "room3-r2@example.com";
    removeResidentHouseholdPaymentData(email);
    seed(parking);
    recordApprovedApplicationCharges(applicant(email, 2), MANAGER_ID, true, { leaseExecuted: true });

    const rows = readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === email);
    expect(rows.find((c) => c.kind === "prorated_rent")?.amountLabel || rows.find((c) => c.kind === "rent")?.amountLabel).toBeTruthy();
    const rent = rows.find((c) => c.kind === "prorated_rent" || c.kind === "rent");
    // Sep 15–30 is 16/30 of $800. Resident 1's $900 would be $480.00.
    expect(rent?.amountLabel).toBe("$426.67");
    expect(rows.some((c) => c.customFeeId === "cf-parking-r1")).toBe(false);
  });

  it("still bills Resident 1 $900 plus parking", () => {
    const email = "room3-r1@example.com";
    removeResidentHouseholdPaymentData(email);
    seed(parking);
    recordApprovedApplicationCharges(applicant(email, 1), MANAGER_ID, true, { leaseExecuted: true });

    const rows = readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === email);
    const rent = rows.find((c) => c.kind === "prorated_rent" || c.kind === "rent");
    expect(rent?.amountLabel).toBe("$480.00");
    expect(rows.some((c) => c.customFeeId === "cf-parking-r1")).toBe(true);
  });
});
