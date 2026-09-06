import { describe, expect, it } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import {
  CALIFORNIA_LEASE_CONFIG,
  SEATTLE_LEASE_CONFIG,
  WASHINGTON_LEASE_CONFIG,
} from "@/lib/lease-templates/types";
import {
  createDefaultListingSubmission,
  emptyRoom,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { LeaseGenerationContext } from "@/lib/generated-lease";

/**
 * A generated lease may not assert a term mandatory law overrides.
 *
 * Sources read for the two Washington rules below:
 *  - RCW 59.18.283 — a landlord must apply a tenant's payment to RENT first.
 *    https://app.leg.wa.gov/RCW/default.aspx?cite=59.18.283
 *  - Seattle renting guidance — a landlord must make a reasonable renewal offer
 *    60-90 days before a term ends, absent lawful just cause.
 *    https://www.seattle.gov/rentinginseattle/renters/moving-in/types-of-rental-agreements
 *    https://www.seattle.gov/construction-and-inspections/codes/common-code-questions/rental-agreements
 */
function context(overrides: Partial<ManagerListingSubmissionV1> = {}): LeaseGenerationContext {
  const room = { ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 900, utilitiesEstimate: "150" };
  return {
    application: {
      fullLegalName: "Jordan Lee",
      email: "jordan@example.com",
      leaseTerm: "Long-term",
      leaseStart: "2026-10-01",
      leaseEnd: "2027-09-30",
      roomChoice1: "property-1::room-1",
    },
    leasedRoom: undefined,
    listingProperty: {
      id: "property-1",
      title: "Brooklyn House",
      address: "5259 Brooklyn Ave NE, Seattle, WA 98105",
      buildingName: "Brooklyn House",
      unitLabel: "Room 1",
    } as LeaseGenerationContext["listingProperty"],
    submission: {
      ...createDefaultListingSubmission(),
      buildingName: "Brooklyn House",
      address: "5259 Brooklyn Ave NE, Seattle, WA 98105",
      city: "Seattle",
      state: "WA",
      zip: "98105",
      rooms: [room],
      ...overrides,
    },
    generatedAtIso: "2026-09-01T00:00:00.000Z",
    leaseBilling: {
      monthlyRent: 900,
      monthlyUtilities: 150,
      securityDeposit: 400,
      moveInFee: 150,
      otherCostLabel: "Other costs",
      otherCostAmount: 0,
      dueAtSigning: 550,
    },
  };
}

// The full long body, which WA reaches for a daily-basis tenancy and which every
// non-compact jurisdiction reaches always.
const WASHINGTON_LONG_FORM = { ...WASHINGTON_LEASE_CONFIG, documentStyle: undefined };

describe("end of a fixed term is qualified by law, not asserted", () => {
  it.each([
    ["compact", SEATTLE_LEASE_CONFIG],
    ["full long form", { ...SEATTLE_LEASE_CONFIG, documentStyle: undefined }],
  ])("%s stops short of promising automatic termination", (_label, config) => {
    const html = buildLeaseHtml(context(), config);
    expect(html).toContain("does not automatically continue as a month-to-month tenancy");
    expect(html).not.toContain("automatically terminates at the end of the lease term");
    expect(html).toContain("renewal-offer, just-cause and notice requirements");
    // A move-out hour nothing in the listing states must not be invented.
    expect(html).not.toContain("12:00 PM");
  });

  it.each([
    ["compact", SEATTLE_LEASE_CONFIG],
    ["full long form", { ...SEATTLE_LEASE_CONFIG, documentStyle: undefined }],
  ])("%s carries Seattle's renewal-offer duty", (_label, config) => {
    expect(buildLeaseHtml(context(), config)).toContain(
      "between 60 and 90 days before the end of the lease term",
    );
  });

  it("asserts no local renewal duty where none was sourced", () => {
    const html = buildLeaseHtml(context(), WASHINGTON_LONG_FORM);
    expect(html).not.toContain("between 60 and 90 days");
    expect(html).toContain("does not automatically continue as a month-to-month tenancy");
  });
});

describe("payment application follows mandatory law", () => {
  it("applies rent first and cites the Washington statute", () => {
    const html = buildLeaseHtml(context(), WASHINGTON_LONG_FORM);
    expect(html).toContain("applied <strong>first to rent</strong>, as required by RCW 59.18.283");
    const order = html.slice(html.indexOf("Payment Application Order"));
    expect(order.indexOf("past due rent")).toBeLessThan(order.indexOf("damage charges"));
    expect(order.indexOf("current rent")).toBeLessThan(order.indexOf("late fees"));
  });

  it("names no statute for a jurisdiction where none was sourced, and still puts rent first", () => {
    const html = buildLeaseHtml(context(), CALIFORNIA_LEASE_CONFIG);
    expect(html).toContain("applied <strong>first to rent</strong> to the extent required by applicable law");
    expect(html).not.toContain("RCW 59.18.283");
  });
});

describe("notices separate routine communication from service required by law", () => {
  it("does not let email or portal delivery stand in for statutory service", () => {
    const html = buildLeaseHtml(context(), WASHINGTON_LONG_FORM);
    expect(html).toContain("For routine communication");
    expect(html).toContain("electronic delivery alone does not satisfy those requirements");
  });
});

/**
 * Zelle and Venmo were retired product-wide: normalization forces them off, the
 * portal accepts neither, and `acceptedPaymentMethodsForListing` filters both out.
 * The lease body read the RAW submission, so a listing row that still carried a
 * Zelle contact printed an instruction the product can no longer honour.
 */
describe("payment instructions follow the normalized listing", () => {
  it("never promises a retired channel a legacy listing still stores", () => {
    const html = buildLeaseHtml(
      context({
        zellePaymentsEnabled: true,
        zelleContact: "pay@example.com",
        venmoPaymentsEnabled: true,
        venmoContact: "@landlord",
      } as Partial<ManagerListingSubmissionV1>),
      SEATTLE_LEASE_CONFIG,
    );
    expect(html).not.toContain("Zelle");
    expect(html).not.toContain("Venmo");
    expect(html).not.toContain("pay@example.com");
    expect(html).toContain("Payments shall be made by the PropLane portal");
  });
});
