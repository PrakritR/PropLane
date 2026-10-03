/**
 * @vitest-environment jsdom
 *
 * Each stay type (Long-term, Month-to-month, Short term, Custom) carries its OWN lease fee,
 * application fee and move-in fee. A stay type's value REPLACES the house fee of the same
 * kind (never a second line); an empty one inherits the house value. One resolver
 * (`listing-placement-standard-fees.ts`) decides, and the quote, the placement preview, the
 * lease billing snapshot and the charges created at approval/signing must all agree.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  HOUSEHOLD_CHARGES_SESSION_KEY,
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { buildListingQuote } from "@/lib/listing-quote";
import { listingTermFollowsLongTerm } from "@/lib/listing-fee-scope";
import { applyListingFeesToSubmission, presetListingFeeRow } from "@/lib/listing-fees";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import {
  mergeTermStandardFees,
  resolvedMoveInFeeRaw,
  resolvePlacementStandardFees,
  termStandardFeeRow,
} from "@/lib/listing-placement-standard-fees";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { resolvePlacementValuesForRow } from "@/lib/rental-application/placement-values";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import type { MockProperty } from "@/data/types";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";

const MANAGER_ID = "mgr-term-fees";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Unit 2A", monthlyRent: 1100, utilitiesEstimate: "", ...over } as ManagerRoomSubmission;
}

/** House: move-in 25, short-term move-in 10, application 35. Long-term row 50/40/300; short term 20/15/100. */
function listing(over: { termPricing?: ManagerRoomSubmission["termPricing"]; longRow?: Record<string, string> } = {}): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = true;
  sub.shortTermDailyCost = "85";
  sub.moveInFee = "25";
  sub.shortTermMoveInFee = "10";
  sub.applicationFee = "35";
  sub.allowedLeaseTerms = [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM];
  sub.rooms = [
    room({
      occupancyPrices: [{ count: 1, moveInFee: "50", applicationFee: "40", leaseFee: "300", ...(over.longRow ?? {}) }],
      termPricing:
        over.termPricing ?? { [SHORT_TERM_LEASE_TERM]: { moveInFee: "20", applicationFee: "15", leaseFee: "100" } },
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

function applicant(propertyId: string, email: string, kind: "long" | "short"): DemoApplicantRow {
  const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}room-1`;
  return {
    id: `app-${email}`,
    name: "Term Tenant",
    email,
    property: "Cascade Lofts",
    propertyId,
    assignedPropertyId: propertyId,
    assignedRoomChoice: choice,
    managerUserId: MANAGER_ID,
    signedMonthlyRent: 1100,
    application: {
      propertyId,
      roomChoice1: choice,
      fullLegalName: "Term Tenant",
      ...(kind === "short"
        ? { rentalType: "short_term", leaseStart: "2026-03-10", leaseEnd: "2026-03-16" }
        : { rentalType: "standard", leaseTerm: LONG_TERM_LEASE_TERM, leaseStart: "2026-08-01", leaseEnd: "2027-07-31" }),
    },
  } as unknown as DemoApplicantRow;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.removeItem(HOUSEHOLD_CHARGES_SESSION_KEY);
});

describe("one resolver: a stay type's own fee replaces the house fee", () => {
  it("resolves each stay type's own lease / application / move-in fee", () => {
    const sub = listing();
    const long = resolvePlacementStandardFees(sub, { leaseTerm: LONG_TERM_LEASE_TERM, room: sub.rooms[0], isStay: false });
    const short = resolvePlacementStandardFees(sub, { leaseTerm: SHORT_TERM_LEASE_TERM, room: sub.rooms[0], isStay: true });
    expect([long.leaseFee, long.applicationFee, long.moveInFee]).toEqual([300, 40, 50]);
    expect([short.leaseFee, short.applicationFee, short.moveInFee]).toEqual([100, 15, 20]);
    expect(short.applicationFeeExplicit).toBe(true);
    expect(short.moveInOverridesHouse).toBe(true);
  });

  it("an empty stay-type fee inherits the long-term row, then the house value", () => {
    const sub = listing({ termPricing: { [SHORT_TERM_LEASE_TERM]: { leaseFee: "100" } } });
    const short = resolvePlacementStandardFees(sub, { leaseTerm: SHORT_TERM_LEASE_TERM, room: sub.rooms[0], isStay: true });
    expect(short.leaseFee).toBe(100);
    expect(short.applicationFee).toBe(40); // inherits the long-term row
    expect(short.moveInFee).toBe(50);
    const bare = listing({ longRow: { moveInFee: "", applicationFee: "" }, termPricing: {} });
    const inherit = resolvePlacementStandardFees(bare, { leaseTerm: SHORT_TERM_LEASE_TERM, room: bare.rooms[0], isStay: true });
    expect(inherit.moveInOverridesHouse).toBe(false);
    expect(inherit.applicationFeeExplicit).toBe(false);
    expect(inherit.applicationFee).toBe(35); // the house application fee
    expect(resolvedMoveInFeeRaw(bare, { leaseTerm: SHORT_TERM_LEASE_TERM, room: bare.rooms[0], isStay: true })).toBe("10");
    expect(resolvedMoveInFeeRaw(sub, { leaseTerm: SHORT_TERM_LEASE_TERM, room: sub.rooms[0], isStay: true })).toBe("50");
  });
});

describe("preview / listing card quote", () => {
  it("shows one move-in line and the term's own fees; the signing total is the lines", () => {
    const sub = listing();
    for (const [term, moveIn, lease, application] of [
      [LONG_TERM_LEASE_TERM, 50, 300, 40],
      [SHORT_TERM_LEASE_TERM, 20, 100, 15],
    ] as const) {
      const quote = buildListingQuote(sub, { roomId: "room-1", leaseTerm: term });
      expect(quote.signingLines.filter((l) => l.label === "Move-in fee").map((l) => l.amount)).toEqual([moveIn]);
      expect(quote.signingLines.filter((l) => l.label === "Lease fee").map((l) => l.amount)).toEqual([lease]);
      expect(quote.applicationFees.find((f) => f.id === "application_fee")?.amount).toBe(application);
      const sum = quote.signingLines.filter((l) => l.dueAtSigning).reduce((s, l) => s + l.amount, 0);
      expect(quote.signingTotal).toBe(sum);
    }
  });
});

describe("house fee rows never stack on a stay type's own fee", () => {
  it("replaces both the long-term and the short-term house move-in rows with the stay type's value", () => {
    const base = listing();
    const sub = normalizeManagerListingSubmissionV1(
      applyListingFeesToSubmission(base, [
        { ...presetListingFeeRow("move_in_fee", "25"), dueAtSigning: true },
        { ...presetListingFeeRow("short_term_move_in", "10"), dueAtSigning: true },
      ]),
    );
    for (const [term, expected] of [[LONG_TERM_LEASE_TERM, 50], [SHORT_TERM_LEASE_TERM, 20]] as const) {
      const quote = buildListingQuote(sub, { roomId: "room-1", leaseTerm: term });
      const moveIns = quote.signingLines.filter((l) => /move-in/i.test(l.label));
      expect(moveIns.map((l) => l.amount)).toEqual([expected]);
    }
  });
});

describe("charges created at approval / signing", () => {
  it("bills the long-term move-in once, from the long-term row, never also the house fee", () => {
    const propertyId = "prop-tf-long";
    seed(propertyId, listing());
    const email = "tf-long@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant(propertyId, email, "long"), MANAGER_ID, true, { leaseExecuted: true });
    const moveIns = readHouseholdCharges().filter((c) => c.residentEmail === email && c.kind === "move_in_fee");
    expect(moveIns.map((c) => c.amountLabel)).toEqual(["$50.00"]);
  });

  it("bills the short-stay move-in from the Short term fee", () => {
    const propertyId = "prop-tf-short";
    seed(propertyId, listing());
    const email = "tf-short@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant(propertyId, email, "short"), MANAGER_ID, true, { leaseExecuted: true });
    const moveIns = readHouseholdCharges().filter((c) => c.residentEmail === email && c.kind === "move_in_fee");
    expect(moveIns.map((c) => c.amountLabel)).toEqual(["$20.00"]);
  });

  it("an empty stay-type move-in inherits the house short-term move-in", () => {
    const propertyId = "prop-tf-inherit";
    seed(propertyId, listing({ longRow: { moveInFee: "" }, termPricing: { [SHORT_TERM_LEASE_TERM]: { leaseFee: "100" } } }));
    const email = "tf-inherit@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant(propertyId, email, "short"), MANAGER_ID, true, { leaseExecuted: true });
    const moveIns = readHouseholdCharges().filter((c) => c.residentEmail === email && c.kind === "move_in_fee");
    expect(moveIns.map((c) => c.amountLabel)).toEqual(["$10.00"]);
  });

  it("the quote's move-in equals the move-in charged, for both terms", () => {
    const sub = listing();
    const propertyId = "prop-tf-agree";
    seed(propertyId, sub);
    for (const kind of ["long", "short"] as const) {
      const email = `tf-agree-${kind}@example.com`;
      removeResidentHouseholdPaymentData(email);
      recordApprovedApplicationCharges(applicant(propertyId, email, kind), MANAGER_ID, true, { leaseExecuted: true });
      const charged = readHouseholdCharges().find((c) => c.residentEmail === email && c.kind === "move_in_fee")?.amountLabel;
      const quoted = buildListingQuote(sub, {
        roomId: "room-1",
        leaseTerm: kind === "long" ? LONG_TERM_LEASE_TERM : SHORT_TERM_LEASE_TERM,
      }).signingLines.find((l) => l.label === "Move-in fee")?.amount;
      expect(charged).toBe(`$${quoted!.toFixed(2)}`);
    }
  });
});

describe("placement preview and lease billing snapshot", () => {
  it("previews the stay type's own move-in", () => {
    const propertyId = "prop-tf-preview";
    seed(propertyId, listing());
    expect(resolvePlacementValuesForRow(applicant(propertyId, "p1@example.com", "long")).moveInFee).toBe(50);
  });

  it("the lease billing snapshot carries the stay type's own move-in", () => {
    const propertyId = "prop-tf-snap";
    seed(propertyId, listing());
    expect(buildLeaseBillingSnapshot(applicant(propertyId, "snap-s@example.com", "short"), MANAGER_ID).moveInFee).toBe(20);
    expect(buildLeaseBillingSnapshot(applicant(propertyId, "snap-l@example.com", "long"), MANAGER_ID).moveInFee).toBe(50);
  });
});

describe("shared-room arrangement bands keep their own fees per stay type", () => {
  function sharedListing() {
    const sub = createDefaultListingSubmission();
    sub.shortTermRentalsAllowed = true;
    sub.allowedLeaseTerms = [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM];
    sub.rooms = [
      room({
        occupancyCapacity: 2,
        offeredResidentCounts: [1, 2],
        occupancyPrices: [
          { count: 1, leaseFee: "300" },
          { count: 2, leaseFee: "150", moveInFee: "30" },
        ],
      }),
    ];
    return normalizeManagerListingSubmissionV1(sub);
  }

  it("writes a band's stay-type fee on the term, leaving the long-term row alone, and blank inherits again", () => {
    const sub = sharedListing();
    const written = mergeTermStandardFees(sub.rooms[0]!, SHORT_TERM_LEASE_TERM, { leaseFee: "60" }, 2);
    expect(termStandardFeeRow(written, SHORT_TERM_LEASE_TERM, 2).leaseFee).toBe("60");
    expect(written.occupancyPrices?.find((r) => r.count === 2)?.leaseFee).toBe("150");
    const keepsOthers = mergeTermStandardFees(written, SHORT_TERM_LEASE_TERM, { moveInFee: "12" }, 2);
    expect(termStandardFeeRow(keepsOthers, SHORT_TERM_LEASE_TERM, 2)).toEqual({ leaseFee: "60", moveInFee: "12" });
    const cleared = mergeTermStandardFees(keepsOthers, SHORT_TERM_LEASE_TERM, { leaseFee: "", moveInFee: "" }, 2);
    expect(cleared.termPricing).toBeUndefined();
  });

  it("resolves the band's own stay-type fee, else the long-term band, per resident count", () => {
    const sub = sharedListing();
    const withTerm = {
      ...sub,
      rooms: [mergeTermStandardFees(sub.rooms[0]!, SHORT_TERM_LEASE_TERM, { leaseFee: "60" }, 2)],
    };
    const normalized = normalizeManagerListingSubmissionV1(withTerm);
    const at = (term: string, isStay: boolean, count: number) =>
      resolvePlacementStandardFees(normalized, { leaseTerm: term, room: normalized.rooms[0], arrangementCount: count, isStay });
    expect(at(SHORT_TERM_LEASE_TERM, true, 2).leaseFee).toBe(60);
    expect(at(SHORT_TERM_LEASE_TERM, true, 2).moveInFee).toBe(30); // blank on the stay band inherits the long-term band
    expect(at(LONG_TERM_LEASE_TERM, false, 2).leaseFee).toBe(150);
    expect(at(SHORT_TERM_LEASE_TERM, true, 1).leaseFee).toBe(300); // private room is untouched
    const quote = buildListingQuote(normalized, { roomId: "room-1", leaseTerm: SHORT_TERM_LEASE_TERM, arrangementCount: 2 });
    expect(quote.signingLines.filter((l) => l.label === "Lease fee").map((l) => l.amount)).toEqual([60]);
  });
});

describe("a stay type's fees alone do not make it stop following long-term prices", () => {
  it("keeps Month-to-month following long-term until it has its own rent", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...listing(),
      rooms: [mergeTermStandardFees(listing().rooms[0]!, "Month-to-Month", { moveInFee: "5" })],
    });
    expect(sub.rooms[0]!.termPricing?.["Month-to-Month"]?.moveInFee).toBe("5");
    expect(listingTermFollowsLongTerm(sub, "Month-to-Month")).toBe(true);
    const priced = { ...sub, rooms: [{ ...sub.rooms[0]!, termPricing: { "Month-to-Month": { monthlyRent: "900", moveInFee: "5" } } }] };
    expect(listingTermFollowsLongTerm(priced as never, "Month-to-Month")).toBe(false);
  });
});
