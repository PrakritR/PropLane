/**
 * @vitest-environment jsdom
 *
 * The room's Lease fee is set per step in the property Pricing popup. The charge ledger and the
 * lease billing snapshot (the numbers the generated lease prints) must bill the SAME one - the one
 * for the lease's term - and bill nothing when the manager set nothing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-room-term-fees";

function seedListing(propertyId: string, roomOver: Partial<ManagerRoomSubmission>): void {
  const sub = createDefaultListingSubmission();
  const base = sub.rooms[0]!;
  sub.rooms = [{ ...base, id: "room-1", name: "Guest room", monthlyRent: 1200, ...roomOver } as ManagerRoomSubmission];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.shortTermRentalsAllowed = true;
  sub.shortTermDailyCost = "85";
  const property: MockProperty = {
    id: propertyId,
    title: "Term Fee House",
    tagline: "",
    address: "1200 Pacific Ave, Tacoma, WA",
    zip: "98402",
    neighborhood: "Downtown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Term Fee House",
    unitLabel: "Guest room",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

function applicant(propertyId: string, email: string, shortTerm: boolean): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Term Fee House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
      rentalType: shortTerm ? "short_term" : "standard",
      leaseTerm: shortTerm ? "Short-Term Stay" : "Long-term",
      leaseStart: shortTerm ? "2026-03-10" : "2026-03-01",
      leaseEnd: shortTerm ? "2026-03-16" : "2027-02-28",
      fullLegalName: "Dana Tenant",
    },
  } as unknown as DemoApplicantRow;
}

const leaseFees = (email: string) =>
  readHouseholdCharges().filter(
    (c) => c.residentEmail.toLowerCase() === email.toLowerCase() && c.kind === "other_cost" && c.title === "Lease fee",
  );

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("the room's Lease fee, per term, through the ledger and the lease snapshot", () => {
  const priced = {
    occupancyPrices: [{ count: 1, monthlyRent: 1200, leaseFee: "100", shortTermLeaseFee: "40" }],
  };

  it("bills the long-term Lease fee once at move-in on a long-term lease", () => {
    const email = "long-lease-fee@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing("prop-term-fee-long", priced);
    const row = applicant("prop-term-fee-long", email, false);
    recordApprovedApplicationCharges(row, MANAGER_ID, true, { leaseExecuted: true });

    const charges = leaseFees(email);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.amountLabel).toBe("$100.00");
    expect(charges[0]?.recurringRentProfileId).toBeUndefined();

    // The lease prints what the ledger bills: the snapshot owes the same one-time fee at signing.
    const snapshot = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(Object.values(snapshot.oneTimeCustomFeeBalances ?? {})).toContain(100);
  });

  it("bills the short-term Lease fee, not the long-term one, on a short stay", () => {
    const email = "short-lease-fee@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing("prop-term-fee-short", priced);
    recordApprovedApplicationCharges(applicant("prop-term-fee-short", email, true), MANAGER_ID, true, {
      leaseExecuted: true,
    });
    const charges = leaseFees(email);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.amountLabel).toBe("$40.00");
  });

  it("bills no Lease fee when the room sets none", () => {
    const email = "no-lease-fee@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing("prop-term-fee-none", { occupancyPrices: [{ count: 1, monthlyRent: 1200 }] });
    recordApprovedApplicationCharges(applicant("prop-term-fee-none", email, false), MANAGER_ID, true, {
      leaseExecuted: true,
    });
    expect(leaseFees(email)).toHaveLength(0);
  });
});

describe("the Lease fee billed is the fee of the lease actually signed (its room and its term)", () => {
  it("bills the ASSIGNED room's fee when the manager placed the applicant in another room", () => {
    const email = "assigned-room-fee@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-term-fee-assigned";
    const sub = createDefaultListingSubmission();
    const base = sub.rooms[0]!;
    sub.securityDeposit = "";
    sub.moveInFee = "";
    sub.applicationFee = "";
    sub.rooms = [
      { ...base, id: "room-1", name: "Room 1", monthlyRent: 1200, occupancyPrices: [{ count: 1, monthlyRent: 1200, leaseFee: "100" }] },
      { ...base, id: "room-2", name: "Room 2", monthlyRent: 1300, occupancyPrices: [{ count: 1, monthlyRent: 1300, leaseFee: "250" }] },
    ] as ManagerRoomSubmission[];
    cachePublicExtraListings(
      [
        {
          id: propertyId,
          title: "Two Room House",
          tagline: "",
          address: "5 Pacific Ave, Tacoma, WA",
          zip: "98402",
          neighborhood: "Downtown",
          beds: 2,
          baths: 1,
          rentLabel: "$1,200/mo",
          available: "Now",
          petFriendly: false,
          buildingId: "b2",
          buildingName: "Two Room House",
          unitLabel: "Room 1",
          adminPublishLive: true,
          managerUserId: MANAGER_ID,
          listingSubmission: normalizeManagerListingSubmissionV1(sub),
        } as MockProperty,
      ],
      { silent: true },
    );
    const row = applicant(propertyId, email, false);
    row.application = { ...row.application!, roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1` };
    row.assignedRoomChoice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-2`;
    recordApprovedApplicationCharges(row, MANAGER_ID, true, { leaseExecuted: true });

    const charges = leaseFees(email);
    expect(charges).toHaveLength(1);
    expect(charges[0]?.amountLabel).toBe("$250.00");
    const snapshot = buildLeaseBillingSnapshot(row, MANAGER_ID);
    expect(Object.values(snapshot.oneTimeCustomFeeBalances ?? {})).toContain(250);
  });

  it("a month-to-month lease bills the long-term Lease fee, never the short-term one", () => {
    const email = "m2m-lease-fee@example.com";
    removeResidentHouseholdPaymentData(email);
    seedListing("prop-term-fee-m2m", {
      occupancyPrices: [{ count: 1, monthlyRent: 1200, leaseFee: "100", shortTermLeaseFee: "40" }],
    });
    const row = applicant("prop-term-fee-m2m", email, false);
    row.application = { ...row.application!, leaseTerm: "Month-to-Month", leaseEnd: "" };
    recordApprovedApplicationCharges(row, MANAGER_ID, true, { leaseExecuted: true });
    expect(leaseFees(email).map((c) => c.amountLabel)).toEqual(["$100.00"]);
  });
});
