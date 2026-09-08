/**
 * @vitest-environment jsdom
 *
 * Charges follow the lease, not the application.
 *
 * The bug this pins: submitting an application generated the FULL move-in
 * schedule — deposit, first month's rent, utilities, move-in fee and a recurring
 * rent profile — for someone nobody had approved. Those are persisted rows, so
 * each one also posted to the manager's ledger and emitted a resident-addressed
 * `charge_created` notification. The applicant opened their dashboard to eight
 * pending and overdue payments on a home they had not been given.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  chargesImplyTenancy,
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
  readRecurringRentProfilesForManager,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-charges-follow-lease";
const PROPERTY_ID = "prop-charges-follow-lease";
const EMAIL = "applicant@example.com";

const ROOM_ID = "room-a";

function seedListing() {
  let sub = createDefaultListingSubmission();
  sub.rooms = [
    {
      ...sub.rooms[0]!,
      id: ROOM_ID,
      name: "Room A",
      monthlyRent: 2000,
      utilitiesEstimate: "150",
      utilitiesPaymentModel: "manager_billed",
    },
  ];
  sub = applyListingFeesToSubmission(sub, [
    {
      id: "fee-sec",
      presetId: "security_deposit",
      label: "Security deposit",
      amount: "1500",
      frequency: "one-time",
      dueAtSigning: true,
    },
  ]);
  sub.securityDeposit = "";
  const property: MockProperty = {
    id: PROPERTY_ID,
    title: "Charges Follow Lease House",
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property]);
}

function row(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  const roomChoice = `Room A${LISTING_ROOM_CHOICE_SEP}${ROOM_ID}`;
  return {
    id: `app-${EMAIL}`,
    name: "Dana Applicant",
    email: EMAIL,
    property: "Charges Follow Lease House",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    assignedRoomChoice: roomChoice,
    bucket: "pending",
    stage: "Submitted",
    managerUserId: MANAGER_ID,
    application: {
      propertyId: PROPERTY_ID,
      roomChoice1: roomChoice,
      leaseStart: "2026-08-01",
      leaseEnd: "2027-07-31",
      leaseTerm: "12 months",
      fullLegalName: "Dana Applicant",
    },
    ...overrides,
  } as DemoApplicantRow;
}

function mine() {
  return readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === EMAIL);
}

function kinds() {
  return mine().map((c) => c.kind).sort();
}

beforeEach(() => {
  removeResidentHouseholdPaymentData(EMAIL);
  seedListing();
});

describe("moment 1 — application submitted", () => {
  it("bills the application fee and NOTHING else", () => {
    recordApprovedApplicationCharges(row(), MANAGER_ID, true, { leaseExecuted: false });

    expect(kinds()).not.toContain("security_deposit");
    expect(kinds()).not.toContain("first_month_rent");
    expect(kinds()).not.toContain("prorated_rent");
    expect(kinds()).not.toContain("utilities");
    expect(kinds()).not.toContain("move_in_fee");
    // Every kind present must be one a PROSPECT can owe.
    for (const kind of kinds()) expect(["application_fee", "holding_deposit"]).toContain(kind);
  });

  it("creates no recurring rent profile, so no month ever materializes", () => {
    recordApprovedApplicationCharges(row(), MANAGER_ID, true, { leaseExecuted: false });

    expect(
      readRecurringRentProfilesForManager(MANAGER_ID).filter((p) => p.residentEmail.toLowerCase() === EMAIL),
    ).toHaveLength(0);
  });

  it("does not let those charges unlock the resident Payments surface", () => {
    recordApprovedApplicationCharges(row(), MANAGER_ID, true, { leaseExecuted: false });

    expect(chargesImplyTenancy(mine())).toBe(false);
  });
});

describe("approval alone", () => {
  it("generates nothing — an approval is a decision, not a bill", () => {
    recordApprovedApplicationCharges(
      row({ bucket: "approved", stage: "Approved" }),
      MANAGER_ID,
      true,
      { leaseExecuted: false },
    );

    expect(kinds()).not.toContain("security_deposit");
    expect(kinds()).not.toContain("first_month_rent");
    expect(kinds()).not.toContain("utilities");
  });
});

describe("moment 2 — the lease is executed", () => {
  it("generates the whole schedule", () => {
    recordApprovedApplicationCharges(
      row({ bucket: "approved", stage: "Approved" }),
      MANAGER_ID,
      true,
      { leaseExecuted: true },
    );

    expect(kinds()).toContain("security_deposit");
    expect(mine().some((c) => c.kind === "first_month_rent" || c.kind === "prorated_rent")).toBe(true);
    expect(chargesImplyTenancy(mine())).toBe(true);
  });

  it("bills on the SIGNATURE even when the application row still reads pending", () => {
    recordApprovedApplicationCharges(row(), MANAGER_ID, true, { leaseExecuted: true });

    expect(chargesImplyTenancy(mine())).toBe(true);
  });
});

describe("chargesImplyTenancy", () => {
  it("treats an application or holding fee as a prospect, not a tenant", () => {
    expect(
      chargesImplyTenancy([
        { kind: "application_fee", status: "paid" },
        { kind: "holding_deposit", status: "pending" },
      ] as never),
    ).toBe(false);
  });

  it("treats rent or a deposit as a real tenancy", () => {
    expect(chargesImplyTenancy([{ kind: "security_deposit", status: "pending" }] as never)).toBe(true);
    expect(chargesImplyTenancy([{ kind: "rent", status: "pending" }] as never)).toBe(true);
  });
});
