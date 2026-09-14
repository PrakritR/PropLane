/**
 * @vitest-environment jsdom
 *
 * Signature freezes the money terms.
 *
 * The bug this pins: nothing wrote the signed rent onto the resident's record,
 * so every Payments load re-priced a signed tenant from the CURRENT listing. A
 * manager editing a room's rent moved a signed resident's pending rent and
 * recurring profile with it — two "Rent — October 2026" rows, $1,000 and
 * $1,100, for a lease signed at one number.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  readRecurringRentProfilesForManager,
  reconcileApprovedResidentPaymentSchedules,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
  seedDemoHouseholdCharges,
} from "@/lib/household-charges";
import { writeManagerApplicationRows } from "@/lib/manager-applications-storage";
import {
  executedLeaseForRow,
  freezeSignedLeaseTerms,
  rowHasFrozenTerms,
  signedTermsFromLeaseHtml,
} from "@/lib/lease-signed-terms";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { applyListingFeesToSubmission } from "@/lib/listing-fees";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-signed-terms";
const PROPERTY_ID = "prop-signed-terms";
const EMAIL = "signed@example.com";
const ROOM_ID = "room-signed";

function seedListing(opts: { monthlyRent?: number; utilities?: string; deposit?: string; dailyRate?: number } = {}) {
  let sub = createDefaultListingSubmission();
  sub.rooms = [
    {
      ...sub.rooms[0]!,
      id: ROOM_ID,
      name: "Room S",
      monthlyRent: opts.monthlyRent ?? 1000,
      utilitiesEstimate: opts.utilities ?? "200",
      utilitiesPaymentModel: "manager_billed",
      ...(opts.dailyRate ? { rentBasis: "daily", dailyRentPrice: opts.dailyRate } : {}),
    } as (typeof sub.rooms)[number],
  ];
  sub = applyListingFeesToSubmission(sub, [
    {
      id: "fee-sec",
      presetId: "security_deposit",
      label: "Security deposit",
      amount: opts.deposit ?? "400",
      frequency: "one-time",
      dueAtSigning: true,
    },
  ]);
  sub.securityDeposit = "";
  const property: MockProperty = {
    id: PROPERTY_ID,
    title: "Signed Terms House",
    managerUserId: MANAGER_ID,
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property]);
}

function row(overrides: Partial<DemoApplicantRow> = {}, app: Record<string, unknown> = {}): DemoApplicantRow {
  const roomChoice = `Room S${LISTING_ROOM_CHOICE_SEP}${ROOM_ID}`;
  return {
    id: `app-${EMAIL}`,
    name: "Sam Signed",
    email: EMAIL,
    property: "Signed Terms House",
    propertyId: PROPERTY_ID,
    assignedPropertyId: PROPERTY_ID,
    assignedRoomChoice: roomChoice,
    bucket: "approved",
    stage: "Approved",
    managerUserId: MANAGER_ID,
    application: {
      propertyId: PROPERTY_ID,
      roomChoice1: roomChoice,
      leaseStart: "2026-08-19",
      leaseEnd: "2027-08-18",
      leaseTerm: "12 months",
      fullLegalName: "Sam Signed",
      ...app,
    },
    ...overrides,
  } as DemoApplicantRow;
}

const LEASE_HTML = `
<table class="fee-table">
  <tr><th>Monthly rent</th><td class="amount"><strong>$1,000.00</strong></td></tr>
  <tr><th>Monthly utilities</th><td class="amount"><strong>$200.00</strong></td></tr>
  <tr><th>Security deposit</th><td class="amount">$400.00</td></tr>
  <tr><th>Move-in fee</th><td class="amount">$0.00</td></tr>
</table>`;

function mine() {
  return readHouseholdCharges().filter((c) => c.residentEmail.toLowerCase() === EMAIL);
}

function profile() {
  return readRecurringRentProfilesForManager(MANAGER_ID).find((p) => p.residentEmail.toLowerCase() === EMAIL);
}

beforeEach(() => {
  removeResidentHouseholdPaymentData(EMAIL);
  seedListing();
});

describe("reading the signed document", () => {
  it("takes the four money terms from the lease summary table", () => {
    expect(signedTermsFromLeaseHtml(LEASE_HTML)).toEqual({
      monthlyRent: 1000,
      monthlyUtilities: 200,
      securityDeposit: 400,
      moveInFee: 0,
    });
  });

  it("states no monthly rent for a document billed by the day", () => {
    const daily = LEASE_HTML.replace("Monthly rent", "Daily rent");
    expect(signedTermsFromLeaseHtml(daily).monthlyRent).toBeUndefined();
  });

  it("matches a lease to its application by axis id, email, or joint membership", () => {
    const leases = [
      { axisId: "AXIS-OTHER", residentEmail: "other@example.com" },
      { axisId: "", residentEmail: "joint@example.com", jointLeaseMembers: [{ residentEmail: EMAIL, applicationId: null }] },
    ];
    expect(executedLeaseForRow(row(), leases)).toBe(leases[1]);
    expect(executedLeaseForRow(row({ id: "AXIS-OTHER", email: "nobody@example.com" }), leases)).toBe(leases[0]);
    expect(executedLeaseForRow(row({ id: "x", email: "nobody@example.com" }), leases)).toBeNull();
  });
});

describe("freezing at signature", () => {
  it("writes rent, utilities, deposit and move-in fee from the document onto the row", () => {
    const { row: frozen, changed } = freezeSignedLeaseTerms(row(), {
      managerUserId: MANAGER_ID,
      lease: { residentEmail: EMAIL, generatedHtml: LEASE_HTML },
    });
    expect(changed).toBe(true);
    expect(frozen.signedMonthlyRent).toBe(1000);
    expect(frozen.application?.managerRentOverride).toBe("1000");
    expect(frozen.application?.managerUtilitiesOverride).toBe("200");
    expect(frozen.application?.managerSecurityDepositOverride).toBe("400");
    expect(frozen.application?.managerMoveInFeeOverride).toBe("0");
    expect(rowHasFrozenTerms(frozen)).toBe(true);
  });

  it("falls back to the billing snapshot when there is no document to read", () => {
    const { row: frozen } = freezeSignedLeaseTerms(row(), { managerUserId: MANAGER_ID, lease: null });
    expect(frozen.signedMonthlyRent).toBe(1000);
    expect(frozen.application?.managerUtilitiesOverride).toBe("200");
    expect(frozen.application?.managerSecurityDepositOverride).toBe("400");
  });

  it("never overwrites a term the manager already set", () => {
    const { row: frozen } = freezeSignedLeaseTerms(
      row({}, { managerRentOverride: "950", managerSecurityDepositOverride: "250" }),
      { managerUserId: MANAGER_ID, lease: { residentEmail: EMAIL, generatedHtml: LEASE_HTML } },
    );
    expect(frozen.application?.managerRentOverride).toBe("950");
    expect(frozen.application?.managerSecurityDepositOverride).toBe("250");
    // The empty terms still freeze.
    expect(frozen.application?.managerUtilitiesOverride).toBe("200");
  });

  it("is a no-op the second time", () => {
    const first = freezeSignedLeaseTerms(row(), { managerUserId: MANAGER_ID, lease: null });
    const second = freezeSignedLeaseTerms(first.row, { managerUserId: MANAGER_ID, lease: null });
    expect(second.changed).toBe(false);
    expect(second.row).toBe(first.row);
  });

  it("leaves a manually added resident alone — their terms are already their own", () => {
    const manual = row({ manuallyAdded: true, signedMonthlyRent: 800 });
    expect(freezeSignedLeaseTerms(manual, { managerUserId: MANAGER_ID, lease: null }).changed).toBe(false);
  });

  it("does not freeze a monthly rent onto a daily-priced room, but still freezes the rest", () => {
    seedListing({ dailyRate: 40 });
    const { row: frozen } = freezeSignedLeaseTerms(row(), { managerUserId: MANAGER_ID, lease: null });
    expect(frozen.signedMonthlyRent).toBeUndefined();
    expect(frozen.application?.managerRentOverride ?? "").toBe("");
    expect(frozen.application?.managerSecurityDepositOverride).toBe("400");
  });
});

describe("after the freeze, the listing can change and the resident's charges cannot", () => {
  it("keeps first-month rent, utilities and the recurring profile at the signed figures on a forced regenerate", () => {
    const { row: frozen } = freezeSignedLeaseTerms(row(), {
      managerUserId: MANAGER_ID,
      lease: { residentEmail: EMAIL, generatedHtml: LEASE_HTML },
    });
    recordApprovedApplicationCharges(frozen, MANAGER_ID, true, { leaseExecuted: true });
    expect(profile()?.monthlyRent).toBe(1000);
    expect(profile()?.monthlyUtilities).toBe(200);

    // The manager re-prices the room for the next applicant.
    seedListing({ monthlyRent: 1100, utilities: "250", deposit: "600" });
    recordApprovedApplicationCharges(frozen, MANAGER_ID, true, { leaseExecuted: true });

    expect(profile()?.monthlyRent).toBe(1000);
    expect(profile()?.monthlyUtilities).toBe(200);
    const deposit = mine().find((c) => c.kind === "security_deposit");
    expect(deposit?.amountLabel).toBe("$400.00");
    const rentRows = mine().filter((c) => c.kind === "prorated_rent" || c.kind === "first_month_rent");
    expect(rentRows.length).toBeGreaterThan(0);
    for (const c of rentRows) expect(c.amountLabel).not.toContain("1,100");
  });

  it("does not patch pending amounts from the new listing price on an ordinary (unforced) load", () => {
    const { row: frozen } = freezeSignedLeaseTerms(row(), { managerUserId: MANAGER_ID, lease: null });
    recordApprovedApplicationCharges(frozen, MANAGER_ID, true, { leaseExecuted: true });
    const before = mine().map((c) => `${c.kind}:${c.amountLabel}`).sort();

    seedListing({ monthlyRent: 1100, utilities: "250", deposit: "600" });
    recordApprovedApplicationCharges(frozen, MANAGER_ID, false, { leaseExecuted: true });

    expect(mine().map((c) => `${c.kind}:${c.amountLabel}`).sort()).toEqual(before);
  });

  it("an UNFROZEN row still tracks the listing — nothing has been agreed yet", () => {
    recordApprovedApplicationCharges(row(), MANAGER_ID, true, { leaseExecuted: true });
    seedListing({ monthlyRent: 1100 });
    recordApprovedApplicationCharges(row(), MANAGER_ID, true, { leaseExecuted: true });
    expect(profile()?.monthlyRent).toBe(1100);
  });
});

describe("a resident moved to another property", () => {
  const OTHER_PROPERTY_ID = "prop-signed-terms-other";

  function seedBothListings() {
    seedListing();
    // Second home, priced differently, alongside the first.
    const sub = createDefaultListingSubmission();
    sub.rooms = [{ ...sub.rooms[0]!, id: "room-o", name: "Room O", monthlyRent: 1100 }];
    cachePublicExtraListings([
      { id: PROPERTY_ID, title: "Signed Terms House", managerUserId: MANAGER_ID, listingSubmission: normalizeManagerListingSubmissionV1(createDefaultListingSubmission()) },
      { id: OTHER_PROPERTY_ID, title: "Other House", managerUserId: MANAGER_ID, listingSubmission: normalizeManagerListingSubmissionV1(sub) },
    ] as MockProperty[]);
  }

  function manualRow(propertyId: string, rent: number): DemoApplicantRow {
    return row(
      {
        propertyId,
        assignedPropertyId: propertyId,
        assignedRoomChoice: "",
        manuallyAdded: true,
        signedMonthlyRent: rent,
        manualResidentDetails: { moveInDate: "2026-08-19", moveOutDate: "2027-08-18", monthlyUtilities: 200 },
      } as Partial<DemoApplicantRow>,
      { propertyId, roomChoice1: "" },
    );
  }

  it("retires the old property's recurring profile and its untouched months, and keeps a paid one", () => {
    seedBothListings();
    writeManagerApplicationRows([manualRow(PROPERTY_ID, 1000)]);
    reconcileApprovedResidentPaymentSchedules(MANAGER_ID, true);
    const oldMonths = mine().filter((c) => c.kind === "rent" && c.propertyId === PROPERTY_ID && c.rentMonth);
    expect(oldMonths.length).toBeGreaterThan(0);
    // One month at the old home was paid — history, never deleted.
    const paid = { ...oldMonths[0]!, status: "paid" as const, paidAmountCents: 100000 };
    seedDemoHouseholdCharges(
      readHouseholdCharges().map((c) => (c.id === paid.id ? paid : c)),
      readRecurringRentProfilesForManager(MANAGER_ID),
    );

    writeManagerApplicationRows([manualRow(OTHER_PROPERTY_ID, 1100)]);
    reconcileApprovedResidentPaymentSchedules(MANAGER_ID, true);

    const profiles = readRecurringRentProfilesForManager(MANAGER_ID).filter((p) => p.residentEmail.toLowerCase() === EMAIL);
    expect(profiles.map((p) => p.propertyId)).toEqual([OTHER_PROPERTY_ID]);
    const rentMonths = mine().filter((c) => c.kind === "rent" && c.rentMonth);
    const byMonth = new Map<string, string[]>();
    for (const c of rentMonths) byMonth.set(c.rentMonth!, [...(byMonth.get(c.rentMonth!) ?? []), c.propertyId]);
    // No month is billed twice across the two homes …
    for (const [month, props] of byMonth) {
      if (month === paid.rentMonth) continue;
      expect(props, month).toEqual([OTHER_PROPERTY_ID]);
    }
    // … and the paid month at the old home is still on record.
    expect(mine().find((c) => c.id === paid.id)?.status).toBe("paid");
  });
});
