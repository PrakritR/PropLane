/**
 * @vitest-environment jsdom
 *
 * The daily rate is ALL-IN. Two guarantees, both money-path:
 *  1. Normalization FOLDS a stored separate `dailyUtilitiesRate` into `dailyRentRate`
 *     (rent += utilities) and clears the source — idempotently (folding twice must not
 *     add it again).
 *  2. Charge generation for a daily-rate-prorated month bills the all-in daily rent and
 *     does NOT add a prorated utilities line on top (no double-bill), even when the room
 *     carries a monthly utilities estimate. Auto proration still bills utilities.
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

const MANAGER_ID = "mgr-all-in-daily";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return {
    ...base,
    id: "room-1",
    name: "Room 1",
    availability: "Available now",
    moveInAvailableDate: "2026-01-01",
    monthlyRent: 1200,
    utilitiesEstimate: "",
    ...over,
  } as ManagerRoomSubmission;
}

function seed(propertyId: string, r: ManagerRoomSubmission): void {
  const sub = createDefaultListingSubmission();
  sub.rooms = [r];
  const property: MockProperty = {
    id: propertyId,
    title: "All-in Loft",
    tagline: "",
    address: "1 Pike St, Seattle, WA",
    zip: "98101",
    neighborhood: "Belltown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "All-in Loft",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

function applicantRow(propertyId: string, email: string, leaseStart: string, leaseEnd: string): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "All-in Loft",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
      leaseStart,
      leaseEnd,
      fullLegalName: "Dana Tenant",
    },
  } as unknown as DemoApplicantRow;
}

function chargesFor(email: string) {
  return readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase());
}

beforeEach(() => {
  window.sessionStorage.clear();
});

function prorated(email: string) {
  return chargesFor(email).find((c) => c.kind === "prorated_utilities");
}
function proratedRent(email: string) {
  return chargesFor(email).find((c) => c.kind === "rent" || c.kind === "prorated_rent");
}

describe("normalization keeps per-day rent and utilities SEPARATE (fold reversed)", () => {
  it("does not combine or clear the two", () => {
    const sub = createDefaultListingSubmission();
    sub.rooms = [room({ prorateMethod: "daily_rate", dailyRentRate: 40, dailyUtilitiesRate: 6 })];
    const once = normalizeManagerListingSubmissionV1(sub);
    expect(once.rooms[0]!.dailyRentRate).toBe(40);
    expect(once.rooms[0]!.dailyUtilitiesRate).toBe(6);
  });
});

describe("charge generation — separate per-day rent and utilities", () => {
  it("case 1/3 — a listing with both per-day rates bills rent and utilities separately, once each", () => {
    const email = "split@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-split";
    seed(propertyId, room({ prorateMethod: "daily_rate", dailyRentRate: 40, dailyUtilitiesRate: 6, utilitiesEstimate: "150" }));

    // Mar 10 → Mar 25 2026 = 16 billable days.
    recordApprovedApplicationCharges(applicantRow(propertyId, email, "2026-03-10", "2026-03-25"), MANAGER_ID, true, { leaseExecuted: true });

    expect(proratedRent(email)?.title).toContain("$40/day");
    // Exactly one utilities line, computed from the PER-DAY rate ($6/day) — not the monthly
    // estimate, and not doubled.
    const utils = chargesFor(email).filter((c) => c.kind === "prorated_utilities" || c.kind === "utilities");
    expect(utils).toHaveLength(1);
    expect(prorated(email)?.title).toContain("$6/day");
  });

  it("case 2 — a FOLDED listing (daily rent set, no per-day utilities) bills the same total: rent only, zero utilities", () => {
    const email = "folded@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-folded";
    // Folded shape: rent rate already includes utilities (46 = 40+6), no separate util rate,
    // and a monthly estimate still present. Must NOT bill the estimate on top.
    seed(propertyId, room({ prorateMethod: "daily_rate", dailyRentRate: 46, dailyUtilitiesRate: undefined, utilitiesEstimate: "150" }));

    recordApprovedApplicationCharges(applicantRow(propertyId, email, "2026-03-10", "2026-03-25"), MANAGER_ID, true, { leaseExecuted: true });

    // Zero utilities lines — the daily rent already covers them.
    expect(chargesFor(email).some((c) => c.kind === "prorated_utilities" || c.kind === "utilities")).toBe(false);
    // Rent bills the all-in 46/day (unchanged total vs when the fold was active).
    expect(proratedRent(email)?.title).toContain("$46/day");
  });

  it("auto proration still bills the monthly utilities estimate (unchanged)", () => {
    const email = "auto-utils@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-auto-utils";
    seed(propertyId, room({ prorateMethod: "auto", utilitiesEstimate: "150" }));

    recordApprovedApplicationCharges(applicantRow(propertyId, email, "2026-03-10", "2027-03-09"), MANAGER_ID, true, { leaseExecuted: true });
    expect(chargesFor(email).some((c) => c.kind === "utilities" || c.kind === "prorated_utilities")).toBe(true);
  });
});
