/**
 * @vitest-environment jsdom
 *
 * MONEY: the lease fee is a charge kind, collected with the other at-signing charges when the lease is
 * SENT, and signing waits for the payment (captain, 2026-10-03).
 *
 *  - the `lease_fee` charge carries the ONE resolver's amount for the room + stay type;
 *  - the listing's per-lease-type ticks decide which other lines are "at signing";
 *  - a waived lease fee is not charged and is not in the total;
 *  - the total shown is the sum of the charges, and signing is allowed only once none is unpaid;
 *  - the ledger books it as income (not a liability), and the old one-time `other_cost` "Lease fee"
 *    line no longer double-bills.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  HOUSEHOLD_CHARGES_SESSION_KEY,
  markHouseholdChargePaid,
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { buildListingQuote } from "@/lib/listing-quote";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import {
  AT_SIGNING_UNPAID_CODE,
  atSigningAllowsSignature,
  atSigningTotalCents,
  chargesForLeaseSigning,
  leaseFeeDollarsFromOverlaidSubmission,
  unpaidAtSigningCharges,
} from "@/lib/lease-at-signing";
import { categoryCodeForChargeKind } from "@/lib/reports/categories";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-lease-fee";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Unit 2A", monthlyRent: 1100, utilitiesEstimate: "", ...over } as ManagerRoomSubmission;
}

/** Long-term row: move-in 50, lease fee 300. Short term: move-in 20, lease fee 100. Deposit 500. */
function listing(over: { signing?: string[] } = {}): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  sub.shortTermDailyCost = "85";
  sub.securityDeposit = "500";
  sub.moveInFee = "25";
  sub.allowedLeaseTerms = [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM];
  sub.paymentAtSigningIncludes = (over.signing ?? ["security_deposit", "move_in_fee"]) as never;
  sub.rooms = [
    room({
      occupancyPrices: [{ count: 1, moveInFee: "50", leaseFee: "300" }],
      termPricing: { [SHORT_TERM_LEASE_TERM]: { moveInFee: "20", leaseFee: "100" } },
    }),
  ];
  return normalizeManagerListingSubmissionV1(sub);
}

function seed(propertyId: string, sub: ManagerListingSubmissionV1): MockProperty {
  const property: MockProperty = {
    id: propertyId,
    title: "Cascade Lofts",
    tagline: "",
    address: "100 Oak St, Seattle, WA",
    zip: "98101",
    neighborhood: "Capitol Hill",
    beds: 1,
    baths: 1,
    rentLabel: "$1,100/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Cascade Lofts",
    unitLabel: "Unit 2A",
    adminPublishLive: true,
    managerUserId: MANAGER_ID,
    listingSubmission: sub,
  };
  cachePublicExtraListings([property], { silent: true });
  return property;
}

function applicant(
  propertyId: string,
  email: string,
  kind: "long" | "short",
  extra: Record<string, unknown> = {},
): DemoApplicantRow {
  const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`;
  return {
    id: `app-${email}`,
    name: "Fee Tenant",
    email,
    property: "Cascade Lofts",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: choice,
    managerUserId: MANAGER_ID,
    signedMonthlyRent: 1100,
    bucket: "approved",
    application: {
      propertyId,
      roomChoice1: choice,
      fullLegalName: "Fee Tenant",
      ...(kind === "short"
        ? { rentalType: "short_term", leaseStart: "2026-03-10", leaseEnd: "2026-03-16" }
        : { rentalType: "standard", leaseTerm: LONG_TERM_LEASE_TERM, leaseStart: "2026-08-01", leaseEnd: "2027-07-31" }),
      ...extra,
    },
  } as unknown as DemoApplicantRow;
}

function chargesFor(email: string): HouseholdCharge[] {
  return readHouseholdCharges().filter((c) => c.residentEmail === email);
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.removeItem(HOUSEHOLD_CHARGES_SESSION_KEY);
});

describe("the lease fee is a charge kind with the resolver's amount", () => {
  it("bills the long-term and the short-term lease fee as their own lease_fee charge", () => {
    seed("prop-lf-amounts", listing());
    for (const [kind, expected] of [["long", "$300.00"], ["short", "$100.00"]] as const) {
      const email = `lf-${kind}@example.com`;
      removeResidentHouseholdPaymentData(email);
      recordApprovedApplicationCharges(applicant("prop-lf-amounts", email, kind), MANAGER_ID, true, { leaseExecuted: true });
      const fees = chargesFor(email).filter((c) => c.kind === "lease_fee");
      expect(fees.map((c) => c.amountLabel)).toEqual([expected]);
      expect(fees[0]!.title).toBe("Lease fee");
      // No second, generic one-time line for the same fee.
      expect(chargesFor(email).filter((c) => c.kind === "other_cost" && /lease fee/i.test(c.title))).toEqual([]);
    }
  });

  it("the quote's Lease fee equals the lease fee charged, for both terms", () => {
    const sub = listing();
    seed("prop-lf-quote", sub);
    for (const kind of ["long", "short"] as const) {
      const email = `lf-quote-${kind}@example.com`;
      removeResidentHouseholdPaymentData(email);
      recordApprovedApplicationCharges(applicant("prop-lf-quote", email, kind), MANAGER_ID, true, { leaseExecuted: true });
      const charged = chargesFor(email).find((c) => c.kind === "lease_fee")?.amountLabel;
      const quoted = buildListingQuote(sub, {
        roomId: "room-1",
        leaseTerm: kind === "long" ? LONG_TERM_LEASE_TERM : SHORT_TERM_LEASE_TERM,
      }).signingLines.find((l) => l.label === "Lease fee")?.amount;
      expect(charged).toBe(`$${quoted!.toFixed(2)}`);
    }
  });

  it("is income, never a liability", () => {
    expect(categoryCodeForChargeKind("lease_fee")).toBe("other_income");
    expect(categoryCodeForChargeKind("security_deposit")).toBe("security_deposit_liability");
  });

  it("reads the same resolver answer off the overlaid listing", () => {
    expect(leaseFeeDollarsFromOverlaidSubmission(undefined)).toBe(0);
    expect(leaseFeeDollarsFromOverlaidSubmission({ customFees: [] })).toBe(0);
  });
});

describe("the at-signing lines are created when the lease is sent", () => {
  it("posts only the lines the listing collects at signing, each stamped, before anyone signs", () => {
    seed("prop-lf-send", listing());
    const email = "lf-send@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant("prop-lf-send", email, "long"), MANAGER_ID, false, {
      leaseExecuted: false,
      atSigningOnly: true,
    });
    const charges = chargesFor(email);
    expect(charges.map((c) => c.kind).sort()).toEqual(["lease_fee", "move_in_fee", "security_deposit"]);
    expect(charges.every((c) => c.dueAtSigning === true && c.status === "pending")).toBe(true);
    // No rent, no recurring schedule: the rest waits for the executed lease.
    expect(charges.some((c) => c.kind === "first_month_rent" || c.kind === "prorated_rent" || c.kind === "rent")).toBe(false);
    const byKind = Object.fromEntries(charges.map((c) => [c.kind, c.amountLabel]));
    expect(byKind).toEqual({ lease_fee: "$300.00", move_in_fee: "$50.00", security_deposit: "$500.00" });
  });

  it("includes the first month's rent only when the listing collects it at signing", () => {
    seed("prop-lf-rent-on", listing({ signing: ["security_deposit", "move_in_fee", "first_month_rent"] }));
    seed("prop-lf-rent-off", listing({ signing: ["security_deposit", "move_in_fee"] }));
    const on = "lf-rent-on@example.com";
    const off = "lf-rent-off@example.com";
    removeResidentHouseholdPaymentData(on);
    removeResidentHouseholdPaymentData(off);
    recordApprovedApplicationCharges(applicant("prop-lf-rent-on", on, "long"), MANAGER_ID, false, { leaseExecuted: false, atSigningOnly: true });
    recordApprovedApplicationCharges(applicant("prop-lf-rent-off", off, "long"), MANAGER_ID, false, { leaseExecuted: false, atSigningOnly: true });
    const kindsOn = chargesFor(on).map((c) => c.kind);
    expect(kindsOn.some((k) => k === "first_month_rent" || k === "prorated_rent")).toBe(true);
    expect(chargesFor(off).map((c) => c.kind).some((k) => k === "first_month_rent" || k === "prorated_rent")).toBe(false);
  });

  it("is idempotent, and signing then bills the rest without a second lease fee or deposit", () => {
    seed("prop-lf-idem", listing());
    const email = "lf-idem@example.com";
    removeResidentHouseholdPaymentData(email);
    const row = applicant("prop-lf-idem", email, "long");
    recordApprovedApplicationCharges(row, MANAGER_ID, false, { leaseExecuted: false, atSigningOnly: true });
    recordApprovedApplicationCharges(row, MANAGER_ID, false, { leaseExecuted: false, atSigningOnly: true });
    expect(chargesFor(email)).toHaveLength(3);

    // The resident pays the at-signing lines (the webhook writes `paid`), then the lease is executed.
    for (const c of chargesFor(email)) expect(markHouseholdChargePaid(c.id, MANAGER_ID)).toBe(true);
    recordApprovedApplicationCharges(row, MANAGER_ID, false, { leaseExecuted: true });
    const after = chargesFor(email);
    expect(after.filter((c) => c.kind === "lease_fee")).toHaveLength(1);
    expect(after.filter((c) => c.kind === "security_deposit")).toHaveLength(1);
    expect(after.filter((c) => c.kind === "move_in_fee")).toHaveLength(1);
    expect(after.filter((c) => c.kind === "lease_fee")[0]!.status).toBe("paid");
    // The rest of the schedule exists now.
    expect(after.some((c) => c.kind === "first_month_rent" || c.kind === "prorated_rent")).toBe(true);
  });

  it("does not post anything for a lease nobody sent", () => {
    seed("prop-lf-unsent", listing());
    const email = "lf-unsent@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant("prop-lf-unsent", email, "long"), MANAGER_ID, false, { leaseExecuted: false });
    expect(chargesFor(email).filter((c) => c.kind !== "application_fee")).toEqual([]);
  });
});

describe("a waived lease fee is not charged and drops out of the total", () => {
  it("skips the lease_fee charge entirely when the application carries a waiver", () => {
    seed("prop-lf-waive", listing());
    const email = "lf-waive@example.com";
    removeResidentHouseholdPaymentData(email);
    const waiver = { waivedAtIso: "2026-10-03T12:00:00.000Z", waivedByUserId: MANAGER_ID, reason: "Referral" };
    recordApprovedApplicationCharges(
      applicant("prop-lf-waive", email, "long", { managerLeaseFeeWaiver: waiver }),
      MANAGER_ID,
      false,
      { leaseExecuted: false, atSigningOnly: true },
    );
    const charges = chargesFor(email);
    expect(charges.some((c) => c.kind === "lease_fee")).toBe(false);
    expect(atSigningTotalCents(charges)).toBe(50_000 + 5_000);
  });

  it("the snapshot's due-at-signing drops the waived fee and keeps it for everyone else", () => {
    seed("prop-lf-snap", listing());
    const waivedRow = applicant("prop-lf-snap", "lf-snap-w@example.com", "long", {
      managerLeaseFeeWaiver: { waivedAtIso: "2026-10-03T12:00:00.000Z", waivedByUserId: MANAGER_ID, reason: "x" },
    });
    const plainRow = applicant("prop-lf-snap", "lf-snap-p@example.com", "long");
    const waived = buildLeaseBillingSnapshot(waivedRow, MANAGER_ID);
    const plain = buildLeaseBillingSnapshot(plainRow, MANAGER_ID);
    expect(waived.leaseFeeDue).toBe(0);
    expect(plain.leaseFee).toBe(300);
    expect(plain.dueAtSigning - waived.dueAtSigning).toBe(300);
  });
});

describe("the total is the sum of the charges, and signing waits for them", () => {
  it("the snapshot's due-at-signing equals the sum of the at-signing charges", () => {
    seed("prop-lf-total", listing());
    const email = "lf-total@example.com";
    removeResidentHouseholdPaymentData(email);
    const row = applicant("prop-lf-total", email, "long");
    recordApprovedApplicationCharges(row, MANAGER_ID, false, { leaseExecuted: false, atSigningOnly: true });
    const charges = chargesFor(email);
    const sum = charges.reduce((s, c) => s + Number.parseFloat(c.balanceLabel.replace(/[^0-9.]/g, "")), 0);
    expect(atSigningTotalCents(charges)).toBe(Math.round(sum * 100));
    expect(buildLeaseBillingSnapshot(row, MANAGER_ID).dueAtSigning).toBeCloseTo(sum, 2);
  });

  it("blocks signing while any at-signing line is unpaid and allows it once all are paid", () => {
    const base = {
      applicationId: "A",
      residentEmail: "r@example.com",
      propertyId: "p",
      dueAtSigning: true as const,
      amountLabel: "$100.00",
      balanceLabel: "$100.00",
    };
    const lines = [
      { ...base, status: "paid" as const },
      { ...base, status: "pending" as const },
      { ...base, dueAtSigning: undefined, status: "pending" as const }, // a post-signing line never blocks
    ];
    expect(unpaidAtSigningCharges(lines)).toHaveLength(1);
    expect(atSigningAllowsSignature(lines)).toBe(false);
    // A clearing bank transfer has not succeeded yet.
    expect(atSigningAllowsSignature([{ ...base, status: "processing" as const }])).toBe(false);
    // Paid, waived (cancelled) and refunded lines do not block.
    expect(
      atSigningAllowsSignature([
        { ...base, status: "paid" as const },
        { ...base, status: "cancelled" as const },
        { ...base, status: "refunded" as const },
      ]),
    ).toBe(true);
    expect(atSigningAllowsSignature([])).toBe(true);
    expect(AT_SIGNING_UNPAID_CODE).toBe("AT_SIGNING_UNPAID");
  });

  it("scopes a charge list to one lease by application, else by resident and property", () => {
    const mk = (applicationId: string | undefined, residentEmail: string, propertyId: string) => ({
      applicationId,
      residentEmail,
      propertyId,
    });
    const all = [mk("APP-1", "a@x.com", "p1"), mk("APP-2", "b@x.com", "p1"), mk(undefined, "a@x.com", "p1"), mk(undefined, "a@x.com", "p2")];
    expect(
      chargesForLeaseSigning(all, { applicationIds: ["app-1"], residentEmails: ["a@x.com"], propertyId: "p1" }),
    ).toEqual([all[0], all[2]]);
    expect(
      chargesForLeaseSigning(all, { applicationIds: [], residentEmails: ["a@x.com"], propertyId: "p1" }),
    ).toEqual([all[0], all[2]]);
    expect(
      chargesForLeaseSigning(all, { applicationIds: ["app-2"], residentEmails: ["b@x.com"], propertyId: "p1" }),
    ).toEqual([all[1]]);
  });
});
