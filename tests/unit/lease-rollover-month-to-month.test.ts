/**
 * "Add option to also make leases when end become month to month."
 *
 * A fixed-term lease says, in the document, that it "does not automatically
 * continue as a month-to-month tenancy" after the term ends.
 * Rolling over therefore cannot be a silent default — it changes what the
 * signed agreement promises, so it is opt-in per listing.
 */
import { describe, expect, it } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { LeaseGenerationContext } from "@/lib/generated-lease";

function ctx(overrides: Partial<ManagerListingSubmissionV1> = {}): LeaseGenerationContext {
  const room = { ...emptyRoom(0), id: "room-1", name: "Room 1", monthlyRent: 900, utilitiesEstimate: "150" };
  const submission = {
    ...createDefaultListingSubmission(),
    buildingName: "Brooklyn House",
    address: "5259 Brooklyn Ave NE, Seattle, WA 98105",
    city: "Seattle",
    state: "WA",
    zip: "98105",
    rooms: [room],
    ...overrides,
  };
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
    submission,
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

const TERMINATES = "does not automatically continue as a month-to-month tenancy";
const CONTINUES = "continues as a month-to-month tenancy";

describe("lease rollover to month-to-month", () => {
  it("defaults OFF — the document keeps its termination promise", () => {
    const html = buildLeaseHtml(ctx(), SEATTLE_LEASE_CONFIG);
    expect(html).toContain(TERMINATES);
    expect(html).not.toContain(CONTINUES);
  });

  it("states the continuation when the listing opts in", () => {
    const html = buildLeaseHtml(ctx({ rolloverToMonthToMonth: true }), SEATTLE_LEASE_CONFIG);
    expect(html).toContain(CONTINUES);
    expect(html).not.toContain(TERMINATES);
  });

  it("drops the vacate-by and holdover language when it rolls over", () => {
    // Both describe staying on WITHOUT a tenancy, which is exactly what the
    // rollover prevents — keeping them would threaten a holdover charge for the
    // tenancy the same clause just granted.
    const html = buildLeaseHtml(
      ctx({ rolloverToMonthToMonth: true, longTermHoldoverDailyRate: "45" }),
      SEATTLE_LEASE_CONFIG,
    );
    expect(html).not.toContain("agrees to vacate the Premises by the end of the final day");
    expect(html).not.toContain("Any continued occupancy after termination");
  });

  it("names the month-to-month surcharge only when one is configured", () => {
    const withFee = buildLeaseHtml(
      ctx({ rolloverToMonthToMonth: true, monthToMonthSurcharge: "25" }),
      SEATTLE_LEASE_CONFIG,
    );
    expect(withFee).toContain("month-to-month surcharge");
    const withoutFee = buildLeaseHtml(ctx({ rolloverToMonthToMonth: true }), SEATTLE_LEASE_CONFIG);
    expect(withoutFee).not.toContain("month-to-month surcharge");
  });

  it("only an explicit true turns it on", () => {
    // A stored null / string / absent value must keep the standard promise.
    for (const raw of [undefined, null, "true", 1, 0, false]) {
      const normalized = normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(),
        rolloverToMonthToMonth: raw as unknown as boolean,
      });
      expect(normalized.rolloverToMonthToMonth).toBeUndefined();
    }
    expect(
      normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(),
        rolloverToMonthToMonth: true,
      }).rolloverToMonthToMonth,
    ).toBe(true);
  });
});
