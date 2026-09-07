/**
 * @vitest-environment jsdom
 *
 * Custom-fee billing ([key=custom-fee-billing]). Custom fees were display-only; now:
 *  - a ONE-TIME custom fee bills once at move-in on a long-term lease (never recurring),
 *  - a SHORT-TERM custom fee bills once before check-in on a short-term stay, on top of the
 *    all-in stay total,
 *  - a fee set on only one side never leaks to the other,
 *  - a MONTHLY custom fee bills as a recurring charge (full contract in custom-fee-monthly-charges),
 *  - removing a custom fee stops it billing.
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

const MANAGER_ID = "mgr-custom-fee";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Guest room", monthlyRent: 1200, ...over } as ManagerRoomSubmission;
}

function seedListing(propertyId: string, customFees: ManagerCustomFeeRow[], opts?: { shortTerm?: boolean }): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [room({})];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.customFees = customFees;
  if (opts?.shortTerm) {
    sub.shortTermRentalsAllowed = true;
    sub.shortTermDailyCost = "85";
  }
  const property: MockProperty = {
    id: propertyId,
    title: "Custom Fee House",
    tagline: "",
    // Tacoma, not Seattle: these pin the everywhere-else contract (a monthly fee bills as its
    // own recurring charge). In Seattle every monthly fee folds into rent instead — see
    // tests/unit/seattle-rent-fold-in.test.ts.
    address: "1200 Pacific Ave, Tacoma, WA",
    zip: "98402",
    neighborhood: "Downtown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Custom Fee House",
    unitLabel: "Guest room",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function applicant(propertyId: string, email: string, shortTerm: boolean): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Custom Fee House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
      rentalType: shortTerm ? "short_term" : "standard",
      leaseStart: shortTerm ? "2026-03-10" : "2026-03-01",
      leaseEnd: shortTerm ? "2026-03-16" : "2027-02-28",
      fullLegalName: "Dana Tenant",
    },
  } as unknown as DemoApplicantRow;
}

function otherCosts(email: string) {
  return readHouseholdCharges().filter(
    (c) => c.residentEmail.toLowerCase() === email.toLowerCase() && c.kind === "other_cost",
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("custom-fee billing", () => {
  it("a one-time custom fee bills once at move-in on a long-term lease — never recurring", () => {
    const email = "one-time@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-custom-one-time";
    seedListing(propertyId, [{ id: "cf1", label: "Cleaning fee", amount: "75", frequency: "one-time" }]);

    recordApprovedApplicationCharges(applicant(propertyId, email, false), MANAGER_ID, true);

    const cleaning = otherCosts(email).filter((c) => c.title === "Cleaning fee");
    expect(cleaning).toHaveLength(1);
    expect(cleaning[0]?.amountLabel).toBe("$75.00");
    expect(cleaning[0]?.recurringRentProfileId).toBeUndefined();
  });

  it("a monthly custom fee bills as a recurring charge (see custom-fee-monthly-charges for the full contract)", () => {
    const email = "monthly@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-custom-monthly";
    // "Bike storage" (not "Parking", which would re-tag as the parking_monthly preset).
    seedListing(propertyId, [{ id: "cf-bike", label: "Bike storage", amount: "100", frequency: "monthly" }]);

    recordApprovedApplicationCharges(applicant(propertyId, email, false), MANAGER_ID, true);

    const recurring = otherCosts(email).filter((c) => c.customFeeId === "cf-bike" && Boolean(c.recurringRentProfileId));
    expect(recurring.length).toBeGreaterThan(0);
    expect(recurring.every((c) => c.amountLabel === "$100.00")).toBe(true);
  });

  it("a short-term custom fee bills once before check-in; a long-term-only fee does not leak in", () => {
    const email = "st-custom@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-custom-st";
    seedListing(
      propertyId,
      [
        { id: "cf1", label: "Resort fee", amount: "", frequency: "one-time", shortTermAmount: "40" },
        { id: "cf2", label: "Cleaning fee", amount: "75", frequency: "one-time" }, // long-term only
      ],
      { shortTerm: true },
    );

    recordApprovedApplicationCharges(applicant(propertyId, email, true), MANAGER_ID, true);

    const resort = otherCosts(email).filter((c) => c.title === "Resort fee");
    expect(resort).toHaveLength(1);
    expect(resort[0]?.amountLabel).toBe("$40.00");
    expect(resort[0]?.dueDateLabel).toBe("Before check-in");
    // The long-term-only custom fee (no shortTermAmount) never bills on a short-term stay.
    expect(otherCosts(email).some((c) => c.title === "Cleaning fee")).toBe(false);
  });

  it("a short-term-only custom fee does not bill on a long-term lease", () => {
    const email = "st-only-longterm@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-custom-st-only";
    seedListing(propertyId, [{ id: "cf1", label: "Resort fee", amount: "", frequency: "one-time", shortTermAmount: "40" }]);

    recordApprovedApplicationCharges(applicant(propertyId, email, false), MANAGER_ID, true);

    expect(otherCosts(email).some((c) => c.title === "Resort fee")).toBe(false);
  });

  it("removing the custom fee stops it billing", () => {
    const email = "removed@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-custom-removed";
    seedListing(propertyId, []); // no custom fees

    recordApprovedApplicationCharges(applicant(propertyId, email, false), MANAGER_ID, true);

    expect(otherCosts(email)).toHaveLength(0);
  });
});
