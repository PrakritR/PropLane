/**
 * @vitest-environment jsdom
 *
 * Round 20 #4 — the dedicated per-rent-row SHORT-TERM set (rent / move-in / deposit, and
 * explicitly NO utilities). Proves the money path: a short-term booking on a room bills that
 * room's short-term set ONLY — never a long-term utilities line and never the long-term
 * move-in — and falls back to the listing-level short-term fields when the room has none.
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

const MANAGER_ID = "mgr-per-room-short-term";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return {
    ...base,
    id: "room-1",
    name: "Guest room",
    monthlyRent: 1200,
    // Long-term money that must NEVER leak into a short-term booking.
    securityDeposit: "1000",
    moveInFee: "500",
    utilitiesEstimate: "200",
    utilitiesPaymentModel: "manager_billed",
    ...over,
  } as ManagerRoomSubmission;
}

function seedListing(propertyId: string, roomOver: Partial<ManagerRoomSubmission>): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  // Listing-level short-term FALLBACK — different from the room set on purpose.
  sub.shortTermDailyCost = "85";
  sub.shortTermDeposit = "100";
  sub.shortTermMoveInFee = "40";
  sub.applicationFee = "";
  sub.rooms = [room(roomOver)];
  sub.allowedLeaseTerms = ["12-Month"];
  const property: MockProperty = {
    id: propertyId,
    title: "Oak Street Guest Room",
    tagline: "Nightly stays welcome",
    address: "100 Oak St, Seattle, WA",
    zip: "98101",
    neighborhood: "Capitol Hill",
    beds: 1,
    baths: 1,
    rentLabel: "$120/night",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Oak Street Guest Room",
    unitLabel: "Guest room",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function shortTermApplicant(propertyId: string, email: string): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Guest Tenant",
    email,
    property: "Oak Street Guest Room",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
      rentalType: "short_term",
      leaseStart: "2026-03-10",
      leaseEnd: "2026-03-16",
      fullLegalName: "Guest Tenant",
    },
  } as unknown as DemoApplicantRow;
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("per-room short-term set drives the booking", () => {
  it("bills the ROOM's short-term rent, deposit and move-in — never the listing fallback, never utilities", () => {
    const email = "per-room-guest@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-per-room-short-term";
    seedListing(propertyId, {
      shortTermRent: "120",
      shortTermDeposit: "300",
      shortTermMoveInFee: "150",
    });

    recordApprovedApplicationCharges(shortTermApplicant(propertyId, email), MANAGER_ID, true);

    const charges = readHouseholdCharges().filter(
      (c) => c.residentEmail.toLowerCase() === email.toLowerCase(),
    );
    // Stay total uses the ROOM's $120/night (7 nights), not the listing's $85 fallback.
    const stay = charges.find((c) => c.kind === "stay_total");
    expect(stay?.amountLabel).toBe("$720.00");
    expect(stay?.title).toBe("Stay total (6 nights × $120)");
    // Deposit / move-in come from the room's short-term set, not the listing fallback.
    expect(charges.find((c) => c.kind === "security_deposit")?.amountLabel).toBe("$300.00");
    expect(charges.find((c) => c.kind === "move_in_fee")?.amountLabel).toBe("$150.00");
    // All-in: NO separate utilities line, and no long-term rent lines.
    expect(charges.some((c) => c.kind === "utilities")).toBe(false);
    expect(charges.some((c) => c.kind === "first_month_utilities")).toBe(false);
    expect(charges.some((c) => c.kind === "first_month_rent" || c.kind === "prorated_rent")).toBe(false);
    expect(charges.some((c) => c.kind === "rent" && c.recurringRentProfileId)).toBe(false);
  });

  it("falls back to the listing-level short-term set when the room has none", () => {
    const email = "fallback-guest@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-short-term-fallback";
    seedListing(propertyId, {}); // room carries no short-term fields

    recordApprovedApplicationCharges(shortTermApplicant(propertyId, email), MANAGER_ID, true);

    const charges = readHouseholdCharges().filter(
      (c) => c.residentEmail.toLowerCase() === email.toLowerCase(),
    );
    const stay = charges.find((c) => c.kind === "stay_total");
    expect(stay?.amountLabel).toBe("$510.00"); // 6 × $85 listing fallback
    // The NIGHTLY RATE falls back to the listing; the deposit and move-in fee do
    // not. `resolvedShortTermPlacementDeposit` gates the listing-level figure on
    // `isEntireHomeListing`, so on a per-ROOM listing only the room's own figure
    // applies (2b82d7aa, "align short-term deposit billing with public listing
    // display"). A listing-level deposit is ambiguous across rooms, and billing
    // one the public page never showed is exactly the mismatch that change closed.
    expect(charges.some((c) => c.kind === "security_deposit")).toBe(false);
    // The move-in fee is NOT gated the same way and still falls back.
    expect(charges.find((c) => c.kind === "move_in_fee")?.amountLabel).toBe("$40.00");
    expect(charges.some((c) => c.kind === "utilities")).toBe(false);
  });

  it("a LONG-TERM lease on the same room bills the long-term set, nothing short-term", () => {
    const email = "long-term-same-room@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-long-term-same-room";
    seedListing(propertyId, {
      shortTermRent: "120",
      shortTermDeposit: "300",
      shortTermMoveInFee: "150",
    });

    const row = shortTermApplicant(propertyId, email);
    row.application = { ...row.application!, rentalType: "standard", leaseEnd: "2026-06-12" };

    recordApprovedApplicationCharges(row, MANAGER_ID, true);

    const charges = readHouseholdCharges().filter(
      (c) => c.residentEmail.toLowerCase() === email.toLowerCase(),
    );
    expect(charges.some((c) => c.kind === "stay_total")).toBe(false);
    expect(charges.some((c) => c.kind === "first_month_rent" || c.kind === "prorated_rent")).toBe(true);
  });
});
