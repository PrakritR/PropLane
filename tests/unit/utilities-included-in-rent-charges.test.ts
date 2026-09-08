/**
 * @vitest-environment jsdom
 *
 * Round 23 — "Included in rent" utilities state, money path. A room whose utilities are
 * included in rent must generate NO separate utilities charge (not a $0 line — none), and
 * must not double-bill by adding a utilities charge on top of rent that already covers it.
 * A partial first month prorates the rent only. Contrast with a manager-billed room, which
 * still bills utilities as before.
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
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-included-in-rent";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return {
    ...base,
    id: "room-1",
    name: "Room 1",
    monthlyRent: 1200,
    utilitiesEstimate: "150",
    ...over,
  } as ManagerRoomSubmission;
}

function seedListing(propertyId: string, r: ManagerRoomSubmission): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [r];
  sub.securityDeposit = "";
  const property: MockProperty = {
    id: propertyId,
    title: "Utilities Test House",
    tagline: "Rooms",
    address: "1500 Pike St, Seattle, WA",
    zip: "98101",
    neighborhood: "Belltown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Utilities Test House",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function applicantRow(propertyId: string, email: string, leaseStart = "2026-03-01"): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Utilities Test House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
      leaseStart,
      leaseEnd: "2027-02-28",
      fullLegalName: "Dana Tenant",
    },
  } as unknown as DemoApplicantRow;
}

function utilitiesCharges(email: string) {
  return readHouseholdCharges().filter(
    (c) =>
      c.residentEmail.toLowerCase() === email.toLowerCase() &&
      (c.kind === "utilities" || c.kind === "first_month_utilities"),
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("utilities included in rent — no separate utilities charge", () => {
  it("generates NO utilities charge even though the room carries an estimate", () => {
    const email = "included@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-utilities-included";
    seedListing(propertyId, room({ utilitiesPaymentModel: "included_in_rent", utilitiesEstimate: "150" }));

    recordApprovedApplicationCharges(applicantRow(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });

    // Not created at all — and rent still bills, so no double-billing.
    expect(utilitiesCharges(email)).toHaveLength(0);
    const rent = readHouseholdCharges().filter(
      (c) => c.residentEmail.toLowerCase() === email.toLowerCase() && c.kind === "first_month_rent",
    );
    expect(rent.length).toBeGreaterThan(0);
  });

  it("prorates rent only for a partial first month — no utilities proration line", () => {
    const email = "included-partial@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-utilities-included-partial";
    seedListing(propertyId, room({ utilitiesPaymentModel: "included_in_rent", utilitiesEstimate: "150" }));

    // Mid-month start → prorated rent, but still no utilities line.
    recordApprovedApplicationCharges(applicantRow(propertyId, email, "2026-03-15"), MANAGER_ID, true, { leaseExecuted: true });

    expect(utilitiesCharges(email)).toHaveLength(0);
  });

  it("a manager-billed room still bills utilities (the included_in_rent suppression is model-scoped)", () => {
    const email = "manager-billed@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-utilities-billed";
    seedListing(propertyId, room({ utilitiesPaymentModel: "manager_billed", utilitiesEstimate: "150" }));

    recordApprovedApplicationCharges(applicantRow(propertyId, email), MANAGER_ID, true, { leaseExecuted: true });

    expect(utilitiesCharges(email).length).toBeGreaterThan(0);
  });
});
