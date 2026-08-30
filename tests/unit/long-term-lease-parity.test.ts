import { describe, expect, it } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import {
  CALIFORNIA_LEASE_CONFIG,
  SEATTLE_LEASE_CONFIG,
  WASHINGTON_LEASE_CONFIG,
} from "@/lib/lease-templates/types";
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
  it("keeps the compact Washington room lease sections and addenda in a stable order", () => {
    const sections = headings(buildLeaseHtml(longTermContext(), SEATTLE_LEASE_CONFIG));
    const expected = [
      "1. Parties and Premises",
      "2. Lease Term",
      "3. Rent and Utilities",
      "4. Move-In Payment Summary",
      "5. Security Deposit",
      "6. Utilities",
      "7. Occupancy",
      "8. House Rules",
      "9. Furnishings",
      "10. Maintenance",
      "11. Entry",
      "12. Pets and Smoking",
      "13. Subletting or Assignment",
      "14. Alterations",
      "15. Move-Out",
      "16. Default",
      "17. General Provisions",
      "18. Governing Law",
      "19. Entire Agreement",
      "20. Addenda",
      `Addendum A ${String.fromCharCode(8212)} Move-In Condition Report`,
      `Addendum B ${String.fromCharCode(8212)} Bed Bug Disclosure`,
      `Addendum C ${String.fromCharCode(8212)} Mold & Moisture Policy`,
      `Addendum D ${String.fromCharCode(8212)} Maintenance & Tenant Responsibilities Detail`,
      `Addendum E ${String.fromCharCode(8212)} House Rules Enforcement`,
      // Federally required for pre-1978 housing, so it belongs in the compact
      // lease alongside the other disclosures rather than only the long form.
      "Lead-Based Paint Disclosure",
      "21. Signatures",
    ];
    expect(sections).toEqual(expected);
  });

  it("renders configured commercial terms from the listing and moves when the listing changes", () => {
    const first = buildLeaseHtml(longTermContext(), SEATTLE_LEASE_CONFIG);
    const changed = buildLeaseHtml(longTermContext({ longTermBreakLeaseFee: "750", longTermHoldoverDailyRate: "55" }), SEATTLE_LEASE_CONFIG);

    expect(first).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
    expect(first).toContain("$900.00");
    expect(first).toContain("$45.00 per day");
    expect(first).toContain("12:00 PM");
    expect(first).toContain("does not convert to a month-to-month tenancy unless both parties agree in writing");
    expect(first).toContain("Residents do not have exclusive possession of shared areas");
    expect(first).toContain("break lease fee of <strong>$900.00</strong>");
    expect(first).toContain("RCW 59.18.310");
    expect(first).toContain("use only bathroom on their floor");
    expect(first).toContain("Lease Summary");
    expect(first).toContain("<strong>Monthly Rent:</strong> $825.00");
    expect(first).toContain("<strong>Utility:</strong> $175.00");
    expect(first).toContain("<strong>Payment Due at Signing:</strong> $600.00");
    expect(first).toContain("Total payment due at signing: <strong>$600.00</strong>");
    expect(first).not.toContain("Greek Row");
    expect(first).not.toContain("additional authorized occupant");
    expect(changed).toContain("break lease fee of <strong>$750.00</strong>");
    expect(changed).toContain("$55.00 per day");
    expect(changed).not.toContain("break lease fee of <strong>$900.00</strong>");
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
    expect(html).toContain("Quiet hours are strictly enforced (10:00 PM to 8:00 AM)");
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
    expect(html).not.toContain("break lease fee of <strong>$900.00</strong>");
    expect(html).not.toContain("$45.00 per day");
  });

  it("honors payment-at-signing checkboxes for the due-at-signing total", () => {
    const ctx = longTermContext({
      paymentAtSigningIncludes: ["security_deposit"],
    });
    ctx.leaseBilling = { ...ctx.leaseBilling!, dueAtSigning: 400 };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("Total payment due at signing: <strong>$400.00</strong>");
    expect(html).toContain("<strong>$400.00</strong> security deposit");
    expect(html).not.toContain("move-in fee");
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

  it("includes first partial month payment in the move-in payment summary", () => {
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
    expect(html).toContain("For the first partial month, Resident shall pay <strong>$666.67</strong>");
  });

  it("prorates the move-in payment summary for a custom mid-month term using flexible lease dates", () => {
    const ctx = longTermContext();
    ctx.application = {
      ...ctx.application,
      leaseTerm: "Custom",
      leaseStart: "9/22/2026",
      leaseEnd: "12/1/2026",
      managerRentOverride: "$800",
      managerUtilitiesOverride: "$200",
    };
    ctx.leaseBilling = {
      monthlyRent: 800,
      monthlyUtilities: 200,
      securityDeposit: 400,
      moveInFee: 150,
      otherCostLabel: "",
      otherCostAmount: 0,
      dueAtSigning: 850,
    };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("For the first partial month, Resident shall pay <strong>$300.00</strong>");
  });

  it("uses the long-form standard document for California", () => {
    const sections = headings(
      buildLeaseHtml(
        longTermContext({ address: "1 Market St, San Francisco, CA 94105", state: "CA", city: "San Francisco" }),
        CALIFORNIA_LEASE_CONFIG,
      ),
    );
    expect(sections[0]).toBe("1. Parties");
    expect(sections.some((s) => s.includes("Electronic Signature"))).toBe(true);
  });

  it("inherits compact room style from statewide Washington config", () => {
    expect(WASHINGTON_LEASE_CONFIG.documentStyle).toBe("compact_room");
    const html = buildLeaseHtml(longTermContext(), WASHINGTON_LEASE_CONFIG);
    expect(html).toContain("RESIDENTIAL ROOM LEASE AGREEMENT");
    expect(html).toContain("4. Move-In Payment Summary");
  });

  it("renders listing Other fees (preset monthly and one-time) in the compact lease", () => {
    const html = buildLeaseHtml(
      longTermContext({
        applicationFee: "50",
        holdingDeposit: "100",
        monthToMonthSurcharge: "25",
        customLeaseSurcharge: "100",
      }),
      SEATTLE_LEASE_CONFIG,
    );
    expect(html).toContain("Month-to-month surcharge");
    expect(html).toMatch(/<strong>Month-to-month surcharge:<\/strong> \$25\.00 \(monthly\)/);
    expect(html).toContain("Custom lease");
    expect(html).toMatch(/<strong>Custom lease:<\/strong> \$100\.00 \(monthly\)/);
    expect(html).toContain("Holding deposit");
    expect(html).toMatch(/<strong>Holding deposit:<\/strong> \$100\.00 \(one-time\)/);
    expect(html).toContain("Application fee");
    expect(html).toMatch(/<strong>Application fee:<\/strong> \$50\.00 \(one-time\)/);
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
