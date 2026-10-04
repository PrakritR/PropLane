/**
 * @vitest-environment jsdom
 *
 * MONEY follow-ups for the leasing pipeline:
 *  1. A short stay with no stay rate never quotes a figure: there is no "First stay payment" line, no
 *     fallback to the long-term rent, and a ticked-at-signing rent line adds nothing to the total.
 *  2. A custom one-time fee is collected at signing only when the manager ticked it. The charge step
 *     (stamp), the gate and the billing snapshot all follow the same tick the preview does; an unticked
 *     fee is billed as a normal one-time charge instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  HOUSEHOLD_CHARGES_SESSION_KEY,
  readHouseholdCharges,
  recordApprovedApplicationCharges,
  removeResidentHouseholdPaymentData,
  type HouseholdCharge,
} from "@/lib/household-charges";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { PricingReceiptPanel } from "@/components/portal/listing-wizard-v2/listing-side-panel";
import { buildListingQuote, splitQuoteLinesBySigning } from "@/lib/listing-quote";
import { buildLeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { atSigningAllowsSignature, chargeKindDueAtSigning, unpaidAtSigningCharges } from "@/lib/lease-at-signing";
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

const MANAGER_ID = "mgr-pipeline-followups";

function room(over: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: "room-1", name: "Unit 2A", monthlyRent: 10502, utilitiesEstimate: "", ...over } as ManagerRoomSubmission;
}

/* ------------------------------ 1. a stay with no stay rate ------------------------------ */

function stayListing(opts: { signing: string[]; stayRate?: boolean }): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const normalized = normalizeManagerListingSubmissionV1({
    ...base,
    address: "10 Test St",
    city: "Portland",
    state: "OR",
    zip: "97201",
    securityDeposit: "500",
    allowedLeaseTerms: [LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM],
    shortTermRentalsAllowed: true,
    shortTermDailyCost: "",
    rooms: [
      {
        ...base.rooms[0]!,
        id: "room-a",
        name: "Unit 2A",
        monthlyRent: 10502,
        ...(opts.stayRate ? { shortTermRent: "120" } : {}),
      },
    ],
  } as ManagerListingSubmissionV1);
  return {
    ...normalized,
    moveInFee: "11",
    paymentAtSigningByLeaseType: { [SHORT_TERM_LEASE_TERM]: opts.signing },
  } as ManagerListingSubmissionV1;
}

afterEach(cleanup);

describe("a stay with no stay rate quotes no stay figure", () => {
  it("has no First stay payment line and never falls back to the long-term rent", () => {
    for (const signing of [["move_in_fee"], ["room_rent:room-a", "move_in_fee"]]) {
      const quote = buildListingQuote(stayListing({ signing }), { roomId: "room-a", leaseTerm: SHORT_TERM_LEASE_TERM });
      expect(quote.isStay).toBe(true);
      expect(quote.nightlyRate).toBeNull();
      expect(quote.signingLines.map((l) => l.label)).not.toContain("First stay payment");
      expect(quote.signingLines.some((l) => l.amount === 10502)).toBe(false);
      // A ticked rent line contributes no number: the total is exactly the other ticked lines.
      const { atSigning } = splitQuoteLinesBySigning(quote);
      expect(quote.signingTotal).toBe(atSigning.reduce((s, l) => s + l.amount, 0));
      expect(quote.signingTotal).toBeLessThan(10502);
    }
  });

  it("still quotes the first stay payment once a stay rate is set", () => {
    const quote = buildListingQuote(stayListing({ signing: ["room_rent:room-a"], stayRate: true }), {
      roomId: "room-a",
      leaseTerm: SHORT_TERM_LEASE_TERM,
    });
    expect(quote.nightlyRate).toBe(120);
    expect(quote.signingLines.map((l) => l.label)).toContain("First stay payment");
  });

  it("a long-term quote is unchanged: it keeps First month's rent", () => {
    const quote = buildListingQuote(stayListing({ signing: ["room_rent:room-a"] }), {
      roomId: "room-a",
      leaseTerm: LONG_TERM_LEASE_TERM,
    });
    expect(quote.signingLines.find((l) => l.label === "First month's rent")?.amount).toBe(10502);
  });

  it("the preview shows Stay rate, Not set and no first stay payment figure", () => {
    render(
      <PricingReceiptPanel
        sub={stayListing({ signing: ["room_rent:room-a", "move_in_fee"] })}
        patch={() => {}}
        leaseTerm={SHORT_TERM_LEASE_TERM}
        roomId="room-a"
        onRoomChange={() => {}}
        onLeaseTermChange={() => {}}
        leaseTerms={[LONG_TERM_LEASE_TERM, SHORT_TERM_LEASE_TERM]}
        lockLeaseTerm
        plainReceipt
      />,
    );
    expect(screen.getByText("Stay rate")).toBeTruthy();
    expect(screen.getByText("Not set")).toBeTruthy();
    expect(screen.queryByText("First stay payment")).toBeNull();
    expect(document.body.textContent).not.toContain("10,502");
  });
});

/* ------------------------ 2. a custom one-time fee follows the tick ------------------------ */

function feeListing(signing: string[]): ManagerListingSubmissionV1 {
  const sub = createDefaultListingSubmission();
  sub.shortTermRentalsAllowed = false;
  sub.securityDeposit = "";
  sub.moveInFee = "";
  sub.applicationFee = "";
  sub.allowedLeaseTerms = [LONG_TERM_LEASE_TERM];
  sub.rooms = [room({ monthlyRent: 1100 })];
  sub.customFees = [
    { id: "cf-clean", label: "Move-in cleaning", amount: "250", frequency: "one-time", presetId: "custom" },
  ] as never;
  return {
    ...normalizeManagerListingSubmissionV1(sub),
    paymentAtSigningByLeaseType: { [LONG_TERM_LEASE_TERM]: signing },
  } as ManagerListingSubmissionV1;
}

function seed(propertyId: string, sub: ManagerListingSubmissionV1): MockProperty {
  const property: MockProperty = {
    id: propertyId,
    title: "Cascade Lofts",
    tagline: "",
    address: "100 Oak St, Tacoma, WA",
    zip: "98402",
    neighborhood: "Downtown",
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

function applicant(propertyId: string, email: string): DemoApplicantRow {
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
      rentalType: "standard",
      leaseTerm: LONG_TERM_LEASE_TERM,
      leaseStart: "2026-08-01",
      leaseEnd: "2027-07-31",
    },
  } as unknown as DemoApplicantRow;
}

const chargesFor = (email: string): HouseholdCharge[] =>
  readHouseholdCharges().filter((c) => c.residentEmail === email);
const cleaning = (charges: HouseholdCharge[]) => charges.filter((c) => c.kind === "other_cost" && c.customFeeId === "cf-clean");

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.removeItem(HOUSEHOLD_CHARGES_SESSION_KEY);
});

describe("chargeKindDueAtSigning follows the custom fee's own tick", () => {
  const ctx = (signing: string[]) => ({ sub: feeListing(signing), leaseTerm: LONG_TERM_LEASE_TERM, roomId: "room-1" });

  it("an unticked custom fee is not due at signing; a ticked one is", () => {
    expect(chargeKindDueAtSigning("other_cost", { ...ctx([]), customFeeId: "cf-clean" })).toBe(false);
    expect(chargeKindDueAtSigning("other_cost", { ...ctx(["fee:cf-clean"]), customFeeId: "cf-clean" })).toBe(true);
  });

  it("the manager's own per-application other cost (no fee id) is still collected at signing", () => {
    expect(chargeKindDueAtSigning("other_cost", ctx([]))).toBe(true);
  });
});

describe("the charge step respects the tick (preview == charge)", () => {
  it("an unticked custom fee is not in the at-signing charges and not in the gate", () => {
    seed("prop-pf-off", feeListing([]));
    const email = "pf-off@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant("prop-pf-off", email), MANAGER_ID, false, {
      leaseExecuted: false,
      atSigningOnly: true,
    });
    expect(cleaning(chargesFor(email))).toEqual([]);
    expect(atSigningAllowsSignature(chargesFor(email))).toBe(true);
  });

  it("an unticked custom fee is billed as a normal one-time charge instead, not stamped, never gating", () => {
    seed("prop-pf-normal", feeListing([]));
    const email = "pf-normal@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant("prop-pf-normal", email), MANAGER_ID, true, { leaseExecuted: true });
    const fee = cleaning(chargesFor(email));
    expect(fee).toHaveLength(1);
    expect(fee[0]!.amountLabel).toBe("$250.00");
    expect(fee[0]!.dueAtSigning).toBeUndefined();
    expect(unpaidAtSigningCharges(chargesFor(email))).toEqual([]);
    expect(atSigningAllowsSignature(chargesFor(email))).toBe(true);
  });

  it("a ticked custom fee is an at-signing charge and gates the signature until paid", () => {
    seed("prop-pf-on", feeListing(["fee:cf-clean"]));
    const email = "pf-on@example.com";
    removeResidentHouseholdPaymentData(email);
    recordApprovedApplicationCharges(applicant("prop-pf-on", email), MANAGER_ID, false, {
      leaseExecuted: false,
      atSigningOnly: true,
    });
    const fee = cleaning(chargesFor(email));
    expect(fee).toHaveLength(1);
    expect(fee[0]!.dueAtSigning).toBe(true);
    expect(fee[0]!.amountLabel).toBe("$250.00");
    expect(atSigningAllowsSignature(chargesFor(email))).toBe(false);
  });

  it("the quote and the charge agree on the same fee for both ticks", () => {
    for (const signing of [[], ["fee:cf-clean"]]) {
      const sub = feeListing(signing);
      const line = buildListingQuote(sub, { roomId: "room-1", leaseTerm: LONG_TERM_LEASE_TERM }).signingLines.find(
        (l) => l.label === "Move-in cleaning",
      )!;
      expect(line.dueAtSigning).toBe(
        chargeKindDueAtSigning("other_cost", {
          sub,
          leaseTerm: LONG_TERM_LEASE_TERM,
          roomId: "room-1",
          customFeeId: "cf-clean",
        }),
      );
    }
  });
});

describe("the billing snapshot's total at signing follows the tick", () => {
  it("counts a ticked custom fee and leaves an unticked one out", () => {
    const totals: Record<string, number> = {};
    for (const [name, signing] of [["off", []], ["on", ["fee:cf-clean"]]] as const) {
      const sub = feeListing([...signing]);
      seed(`prop-pf-snap-${name}`, sub);
      totals[name] = buildLeaseBillingSnapshot(applicant(`prop-pf-snap-${name}`, `snap-${name}@example.com`), MANAGER_ID).dueAtSigning;
    }
    expect(totals.on! - totals.off!).toBe(250);
  });
});
