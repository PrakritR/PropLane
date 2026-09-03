import { describe, expect, it } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  createDefaultListingSubmission,
  emptyRoom,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import type { LeaseGenerationContext } from "@/lib/generated-lease";

/**
 * 4709A 8th Ave NE Room 2 as it actually bills: $825 rent + $200 utilities, Sep 22 2026
 * through Dec 1 2027, so BOTH boundary months are partial. The manager prices proration by
 * the day ($35/day), which is the only way the summary's $315 / $35 figures come out.
 */
function context(
  roomOverrides: Partial<ManagerRoomSubmission> = {},
  subOverrides: Partial<ManagerListingSubmissionV1> = {},
): LeaseGenerationContext {
  const room: ManagerRoomSubmission = {
    ...emptyRoom(0),
    id: "room-2",
    name: "Room 2",
    monthlyRent: 825,
    utilitiesEstimate: "200",
    ...roomOverrides,
  };
  const submission: ManagerListingSubmissionV1 = {
    ...createDefaultListingSubmission(),
    buildingName: "8th Ave House",
    address: "4709A 8th Ave NE, Seattle, WA 98105",
    city: "Seattle",
    state: "WA",
    zip: "98105",
    securityDeposit: "400",
    moveInFee: "150",
    rooms: [room],
    paymentAtSigningIncludes: ["security_deposit", "move_in_fee", "first_month_rent", "first_month_utilities"],
    ...subOverrides,
  };
  return {
    application: {
      fullLegalName: "Sohan Vivek Naik",
      email: "sohan@example.com",
      leaseTerm: "12-Month",
      leaseStart: "2026-09-22",
      leaseEnd: "2027-12-01",
      roomChoice1: "property-1::room-2",
    },
    leasedRoom: undefined,
    listingProperty: {
      id: "property-1",
      title: "8th Ave House",
      address: "4709A 8th Ave NE, Seattle, WA 98105",
      buildingName: "8th Ave House",
      unitLabel: "Room 2",
    } as LeaseGenerationContext["listingProperty"],
    submission,
    generatedAtIso: "2026-09-01T00:00:00.000Z",
    leaseBilling: {
      monthlyRent: 825,
      monthlyUtilities: 200,
      securityDeposit: 400,
      moveInFee: 150,
      otherCostLabel: "Other costs",
      otherCostAmount: 0,
      dueAtSigning: 857.5,
    },
  };
}

describe("lease summary — prorated first and final month", () => {
  it("names the month on every prorated line and states last month's rent", () => {
    const html = buildLeaseHtml(context(), SEATTLE_LEASE_CONFIG);

    // Grouped summary, in mom's order.
    expect(html).toContain("Monthly charges");
    expect(html).toContain("Fees &amp; deposit");
    expect(html).toContain("Initial payment");
    expect(html).toContain("Total Monthly Housing Cost:");
    expect(html).toContain("$1,025.00");

    // 9 of 30 September days, 1 of 31 December days — the same math the ledger bills.
    expect(html).toContain("Prorated Rent for September 2026:");
    expect(html).toContain("$247.50");
    expect(html).toContain("Prorated Utilities for September 2026:");
    expect(html).toContain("$60.00");
    expect(html).toContain("Last Month&apos;s Rent for December 2027:");
    expect(html).toContain("$26.61");
    expect(html).toContain("Last Month&apos;s Utilities for December 2027:");
    expect(html).toContain("$6.45");
    expect(html).toContain("Payment Due at Signing:");
  });

  it("prices both partial months by the day when the room prorates by daily rate", () => {
    const html = buildLeaseHtml(
      context({ prorateMethod: "daily_rate", dailyRentRate: 35 }),
      SEATTLE_LEASE_CONFIG,
    );
    // 9 days × $35 into September, 1 day × $35 into December.
    expect(html).toContain("Prorated Rent for September 2026:");
    expect(html).toContain("$315.00");
    expect(html).toContain("Last Month&apos;s Rent for December 2027:");
    expect(html).toContain("$35.00");
  });

  it("states the final month in the body, not only the summary", () => {
    const html = buildLeaseHtml(context(), SEATTLE_LEASE_CONFIG);
    expect(html).toContain("The final month of the term is partial");
    expect(html).toContain("1/31 days through lease end");
  });

  it("omits the final-month lines when the lease ends on the last day of a month", () => {
    const ctx = context();
    ctx.application = { ...ctx.application, leaseEnd: "2027-11-30" };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("Prorated Rent for September 2026:");
    expect(html).not.toContain("Last Month&apos;s Rent");
    expect(html).not.toContain("The final month of the term is partial");
  });

  it("gives the long-form document its own prorated final-month section", () => {
    // The long-form document style, rather than the compact room lease. Seattle's config is
    // the branded one, and the long-form summary block only renders under a brand title.
    const html = buildLeaseHtml(context(), { ...SEATTLE_LEASE_CONFIG, documentStyle: "standard" });
    expect(html).toContain("Prorated Final Month");
    expect(html).toContain("Total due for the final month");
    expect(html).toContain("$33.06");
    // Named months in the long-form summary rows too.
    expect(html).toContain("Prorated rent for September 2026");
    expect(html).toContain("Last month&apos;s rent for December 2027");
  });
});
