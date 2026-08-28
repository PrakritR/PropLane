import { describe, expect, it } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { CALIFORNIA_LEASE_CONFIG, SEATTLE_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  createDefaultListingSubmission,
  emptyBathroom,
  emptyRoom,
  emptySharedSpace,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import type { LeaseGenerationContext } from "@/lib/generated-lease";

function longTermContext(overrides: Partial<ManagerListingSubmissionV1> = {}): LeaseGenerationContext {
  const room = { ...emptyRoom(0), id: "room-7", name: "Room 7", monthlyRent: 825, utilitiesEstimate: "175" };
  const bathroom = {
    ...emptyBathroom(0),
    id: "bath-1",
    name: "Hall bath",
    assignedRoomIds: ["room-7", "room-6"],
  };
  const submission = {
    ...createDefaultListingSubmission(),
    buildingName: "Brooklyn House",
    address: "5259 Brooklyn Ave NE, Seattle, WA 98105",
    city: "Seattle",
    state: "WA",
    zip: "98105",
    neighborhood: "Greek Row",
    yearBuilt: 1977,
    securityDeposit: "400",
    moveInFee: "200",
    lateFeeAmount: "75",
    rooms: [room, { ...emptyRoom(1), id: "room-6", name: "Room 6", monthlyRent: 800 }],
    bathrooms: [bathroom],
    sharedSpaces: [
      {
        ...emptySharedSpace(0),
        name: "Kitchen & dining",
        roomAccessIds: ["room-7", "room-6"],
      },
    ],
    longTermBreakLeaseFee: "900",
    longTermLeaseUpFeePercent: 100,
    longTermHoldoverDailyRate: "45",
    longTermReturnedPaymentFee: "35",
    longTermDepositLaborRate: "60",
    longTermDepositReissueFee: "50",
    longTermTrashViolationFee: "30",
    longTermQuietHours: "10:00 PM to 8:00 AM",
    longTermGuestCap: 4,
    longTermDisputeVenue: "King County, Washington",
    longTermProfessionalCleaningRequired: true,
    ...overrides,
  };
  return {
    application: {
      fullLegalName: "Jordan Lee",
      email: "jordan@example.com",
      leaseTerm: "12-Month",
      leaseStart: "2026-06-01",
      leaseEnd: "2027-05-31",
      roomChoice1: "property-1::room-7",
    },
    leasedRoom: undefined,
    listingProperty: {
      id: "property-1",
      title: "Brooklyn House",
      address: "5259 Brooklyn Ave NE, Seattle, WA 98105",
      buildingName: "Brooklyn House",
      unitLabel: "Room 7",
    } as LeaseGenerationContext["listingProperty"],
    submission,
    generatedAtIso: "2026-05-01T00:00:00.000Z",
    leaseBilling: {
      monthlyRent: 825,
      monthlyUtilities: 175,
      securityDeposit: 400,
      moveInFee: 200,
      otherCostLabel: "Other costs",
      otherCostAmount: 0,
      dueAtSigning: 600,
    },
  };
}

function headings(html: string): string[] {
  return [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map((match) => match[1]!.replace(/&amp;/g, "&"));
}

describe("long-term lease parity", () => {
  it("keeps the long-form sections and addenda in a stable order", () => {
    const sections = headings(buildLeaseHtml(longTermContext(), SEATTLE_LEASE_CONFIG));
    const expected = [
      "1. Parties",
      "2. Premises",
      "3. Lease Term",
      "4. Rent",
      "5. Security Deposit & Move-In Charges",
      "6. Returned Payments",
      "7. Utilities & Services",
      "8. Use, Occupancy & Guest Policy",
      "9. Shared Spaces",
      "10. House Rules",
      "11. Pets",
      "12. Maintenance & Repairs",
      "13. Entry (RCW 59.18.150)",
      "14. Assignment & Subletting",
      "15. Move-Out & Surrender",
      "16. Renter's Insurance",
      "17. Default & Remedies",
      "18. Early Termination",
      "19. Payment Application Order",
      "20. Notices",
      "21. Lead-Based Paint Disclosure",
      "22. Governing Law; Severability; Entire Agreement",
      "23. Attorney Fees",
      "24. Application Summary (Incorporated by Reference)",
      "25. Rent & Fees Schedule (Exhibit A)",
      "26. Electronic Signature",
      `Addendum A ${String.fromCharCode(8212)} Move-In Condition Report`,
      `Addendum B ${String.fromCharCode(8212)} Bed Bug Disclosure`,
      `Addendum C ${String.fromCharCode(8212)} Mold & Moisture Policy`,
      `Addendum D ${String.fromCharCode(8212)} Maintenance & Tenant Responsibilities Detail`,
      `Addendum E ${String.fromCharCode(8212)} House Rules Enforcement`,
    ];
    expect(sections).toEqual(expected);
  });

  it("renders configured commercial terms from the listing and moves when the listing changes", () => {
    const first = buildLeaseHtml(longTermContext(), SEATTLE_LEASE_CONFIG);
    const changed = buildLeaseHtml(longTermContext({ longTermBreakLeaseFee: "750", longTermHoldoverDailyRate: "55" }), SEATTLE_LEASE_CONFIG);

    expect(first).toContain("$900.00");
    expect(first).toContain("$45.00 per day");
    expect(first).toContain("12:00 PM");
    expect(first).toContain("does not convert to a month-to-month tenancy unless both parties agree in writing");
    expect(first).toContain("Residents do not have exclusive possession of shared areas");
    expect(first).toContain("Break lease fee");
    expect(first).toContain("Holdover after lease end");
    expect(first).toContain("$60.00 per hour");
    expect(first).toContain("$30.00");
    expect(first).toContain("Hall bath is shared with Room 6.");
    expect(first).toContain("Lease Summary");
    expect(first).toContain("Monthly rent</th><td class=\"amount\"><strong>$825.00");
    expect(first).toContain("Monthly utilities</th><td class=\"amount\"><strong>$175.00");
    expect(first).toContain("Total monthly payment</th><td class=\"amount\"><strong>$1,000.00");
    expect(first).toContain("Payment due at signing</th><td class=\"amount\"><strong>$600.00");
    expect(first).toContain("Mailing address: 5259 Brooklyn Ave NE, Seattle, WA 98105");
    expect(first).not.toContain("Greek Row");
    expect(first).not.toContain("additional authorized occupant");
    expect(first).toContain("<ul class=\"lease-shared-spaces\">");
    expect(changed).toContain("$750.00");
    expect(changed).toContain("$55.00 per day");
    expect(changed).not.toContain("$900.00");
    expect(changed).not.toContain("$45.00 per day");
  });

  it("omits every new optional commercial clause when a listing did not configure it", () => {
    const html = buildLeaseHtml(
      longTermContext({
        longTermBreakLeaseFee: undefined,
        longTermLeaseUpFeePercent: undefined,
        longTermHoldoverDailyRate: undefined,
        longTermReturnedPaymentFee: undefined,
        longTermDepositLaborRate: undefined,
        longTermDepositReissueFee: undefined,
        longTermTrashViolationFee: undefined,
        longTermQuietHours: undefined,
        longTermGuestCap: undefined,
        longTermDisputeVenue: undefined,
        longTermProfessionalCleaningRequired: undefined,
      }),
      CALIFORNIA_LEASE_CONFIG,
    );

    expect(html).not.toContain("Holdover:");
    expect(html).not.toContain("Break lease fee");
    expect(html).not.toContain("lease-up fee");
    expect(html).not.toContain("stop-payment or reissuance fee");
    expect(html).not.toContain("Trash rules:");
    expect(html).not.toContain("$60.00 per hour");
    expect(html).not.toContain("more than 4 guests");
    expect(html).not.toContain("Venue for a dispute");
    expect(html).not.toContain("Move-Out &amp; Surrender");
    expect(html).not.toContain("professional cleaning and provide a paid invoice");
  });

  it("keeps configured quiet hours when the listing supplies custom house rules", () => {
    const html = buildLeaseHtml(longTermContext({ houseRulesText: "No shoes indoors." }), SEATTLE_LEASE_CONFIG);
    expect(html).toContain("No shoes indoors.");
    expect(html).toContain("Quiet hours:</strong> 10:00 PM to 8:00 AM");
  });

  it("does not print a jurisdiction default late fee when the listing disables late fees", () => {
    const html = buildLeaseHtml(longTermContext({ lateFeeEnabled: false }), SEATTLE_LEASE_CONFIG);
    expect(html).not.toContain("<strong>Late fee:</strong>");
  });

  it("drops malformed commercial amounts instead of turning them into lease terms", () => {
    const html = buildLeaseHtml(
      longTermContext({ longTermBreakLeaseFee: "-$900", longTermHoldoverDailyRate: "fee 45" }),
      SEATTLE_LEASE_CONFIG,
    );
    expect(html).not.toContain("$900.00");
    expect(html).not.toContain("Holdover:");
    expect(html).not.toContain("break-lease fee");
  });

  it("honors payment-at-signing checkboxes for the due-at-signing total", () => {
    const ctx = longTermContext({
      paymentAtSigningIncludes: ["security_deposit"],
    });
    ctx.leaseBilling = { ...ctx.leaseBilling!, dueAtSigning: 400 };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("Payment due at signing</th><td class=\"amount\"><strong>$400.00");
    expect(html).toContain("Due at signing includes: security deposit");
    expect(html).not.toContain("Due at signing includes: security deposit and move-in fee");
  });

  it("renders a configured returned-payment clause without an unset jurisdiction citation", () => {
    const config = { ...CALIFORNIA_LEASE_CONFIG, returnedPaymentStatuteRef: undefined };
    const html = buildLeaseHtml(
      longTermContext({
        address: "1 Market St, San Francisco, CA 94105",
        longTermReturnedPaymentFee: "40",
      }),
      config,
    );

    expect(html).toContain("returned-payment fee of <strong>$40.00</strong>");
    expect(html).not.toContain("subject to California");
    expect(html).not.toContain("RCW");
    expect(html).not.toContain("State of Washington");
  });

  it("matches the lease summary first partial month payment to the prorated section total", () => {
    const ctx = longTermContext();
    ctx.application = {
      ...ctx.application,
      leaseStart: "2026-09-15",
      leaseEnd: "2027-08-31",
    };
    ctx.leaseBilling = {
      ...ctx.leaseBilling!,
      proratedRent: 550,
      proratedUtilities: 116.67,
    };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("Prorated total due first month</strong></td><td><strong>$666.67</strong>");
    expect(html).toContain("First partial month payment</th><td class=\"amount\">$666.67");
  });

  it("leaves short-term agreements byte-identical when only long-term terms change", () => {
    const context = longTermContext({
      shortTermRentalsAllowed: true,
      shortTermDailyCost: "75",
      shortTermDeposit: "100",
      rooms: [{ ...emptyRoom(0), id: "room-7", name: "Room 7", monthlyRent: 825, shortTermRent: "75", shortTermDeposit: "100" }],
      longTermBreakLeaseFee: undefined,
      longTermHoldoverDailyRate: undefined,
    });
    context.application = {
      ...context.application,
      rentalType: "short_term",
      leaseTerm: "Short-Term Stay",
      leaseEnd: "2026-06-04",
    };

    const before = buildLeaseHtml(context, SEATTLE_LEASE_CONFIG);
    const after = buildLeaseHtml(
      { ...context, submission: { ...context.submission!, longTermBreakLeaseFee: "900", longTermHoldoverDailyRate: "45" } },
      SEATTLE_LEASE_CONFIG,
    );
    expect(after).toBe(before);
  });
});
