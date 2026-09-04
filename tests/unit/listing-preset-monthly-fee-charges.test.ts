/**
 * @vitest-environment jsdom
 *
 * Billing for the preset fee rows that own no legacy submission field — parking, HOA and
 * "other monthly fees" (PRP-219). The unified-fees migration materializes these into
 * `customFees` as preset-tagged rows, which billing excluded as "preset-backed"; unlike every
 * other preset there was no field billing them either, so a fee the manager entered and the
 * public listing advertises was charged to nobody.
 *
 * The invariant these pin is the ticket's: the fee bills when its checkbox is on, and bills
 * NOTHING when it is off — proven with a stale amount still sitting on the row, so a pass
 * cannot come from the row happening to be blank.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { applyListingLtFeeToggle } from "@/lib/listing-fee-term-toggles";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerCustomFeeRow,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { ListingFeeRowId } from "@/lib/listing-fee-term-toggles";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-preset-monthly";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Room 1", monthlyRent: 1200, utilitiesEstimate: "", ...over } as ManagerRoomSubmission;
}

function seed(propertyId: string, customFees: ManagerCustomFeeRow[]): MockProperty {
  const sub = createDefaultListingSubmission();
  sub.rooms = [room({})];
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.customFees = customFees;
  const property: MockProperty = {
    id: propertyId,
    title: "Monthly Fee House",
    tagline: "",
    address: "1500 Pike St, Seattle, WA",
    zip: "98101",
    neighborhood: "Belltown",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Monthly Fee House",
    unitLabel: "Room 1",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

// Lease Mar 10 → Jun 12 2026: recurring months are 2026-04, 2026-05, 2026-06 (move-in month
// 2026-03 is covered by the first-month charge, not the recurring loop).
function applicant(propertyId: string, email: string): DemoApplicantRow {
  return {
    id: `app-${email}`,
    name: "Dana Tenant",
    email,
    property: "Monthly Fee House",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
    managerUserId: MANAGER_ID,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`,
      rentalType: "standard",
      leaseStart: "2026-03-10",
      leaseEnd: "2026-06-12",
      fullLegalName: "Dana Tenant",
    },
  } as unknown as DemoApplicantRow;
}

function bikeRows(email: string) {
  return readHouseholdCharges()
    .filter(
      (c) =>
        c.residentEmail.toLowerCase() === email.toLowerCase() &&
        c.kind === "other_cost" &&
        c.customFeeId === "cf-bike",
    )
    .sort((a, b) => (a.rentMonth ?? "").localeCompare(b.rentMonth ?? ""));
}

beforeEach(() => {
  window.sessionStorage.clear();
});


type PresetRow = ManagerCustomFeeRow & { presetId: string };

function presetFee(over: Partial<PresetRow>): ManagerCustomFeeRow {
  return {
    id: "cf-other",
    label: "Other monthly fees",
    amount: "150",
    frequency: "monthly",
    presetId: "other_monthly",
    ...over,
  } as ManagerCustomFeeRow;
}

/**
 * Seed a listing carrying the preset fee row. `uncheck` drives the real wizard toggle rather
 * than blanking the legacy scalar — that scalar is a projection `normalizeManagerListingSubmissionV1`
 * re-derives from the fee row on every load, so a test that cleared it by hand would be
 * asserting a state the product can never persist.
 */
function seedPreset(propertyId: string, fee: ManagerCustomFeeRow, uncheck?: ListingFeeRowId) {
  const property = seed(propertyId, [fee]);
  if (uncheck) {
    property.listingSubmission = normalizeManagerListingSubmissionV1(
      applyListingLtFeeToggle(property.listingSubmission as ManagerListingSubmissionV1, uncheck, false),
    );
  }
  cachePublicExtraListings([property], { silent: true });
}

function feeRows(email: string, customFeeId: string) {
  return readHouseholdCharges()
    .filter(
      (c) =>
        c.residentEmail.toLowerCase() === email.toLowerCase() &&
        c.kind === "other_cost" &&
        c.customFeeId === customFeeId,
    )
    .sort((a, b) => (a.rentMonth ?? "").localeCompare(b.rentMonth ?? ""));
}

describe("preset monthly fees with no legacy billing field", () => {
  it("bills 'other monthly fees' every recurring month when the checkbox is on", () => {
    const email = "preset-other-on@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-preset-other-on";
    seedPreset(propertyId, presetFee({}));

    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    const rows = feeRows(email, "cf-other");
    expect(rows.map((r) => r.rentMonth)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(rows.every((r) => r.amountLabel === "$150.00")).toBe(true);
  });

  it("bills nothing after the manager unchecks the fee", () => {
    const email = "preset-other-off@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-preset-other-off";
    seedPreset(propertyId, presetFee({}), "otherMonthlyFees");

    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    expect(feeRows(email, "cf-other")).toEqual([]);
  });

  it("bills parking and HOA the same way", () => {
    const email = "preset-parking-on@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-preset-parking-on";
    seedPreset(
      propertyId,
      presetFee({ id: "cf-parking", label: "Parking", amount: "75", presetId: "parking_monthly" }),
    );

    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    const rows = feeRows(email, "cf-parking");
    expect(rows.map((r) => r.rentMonth)).toEqual(["2026-04", "2026-05", "2026-06"]);
    expect(rows.every((r) => r.amountLabel === "$75.00")).toBe(true);
  });

  it("bills once at move-in when the manager switched the fee to one-time cadence", () => {
    const email = "preset-other-once@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-preset-other-once";
    seedPreset(propertyId, presetFee({ frequency: "one-time" }));

    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    const rows = feeRows(email, "cf-other");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountLabel).toBe("$150.00");
    expect(rows[0]?.rentMonth).toBeFalsy();
  });

  it("does not double-emit across repeated charge generation", () => {
    const email = "preset-other-dup@example.com";
    removeResidentHouseholdPaymentData(email);
    const propertyId = "prop-preset-other-dup";
    seedPreset(propertyId, presetFee({}));

    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);
    recordApprovedApplicationCharges(applicant(propertyId, email), MANAGER_ID, true);

    expect(feeRows(email, "cf-other").map((r) => r.rentMonth)).toEqual(["2026-04", "2026-05", "2026-06"]);
  });
});
