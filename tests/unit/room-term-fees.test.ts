import { describe, expect, it } from "vitest";
import { buildLeaseHtml } from "@/lib/lease-templates/build-lease-html";
import { SEATTLE_LEASE_CONFIG, WASHINGTON_LEASE_CONFIG } from "@/lib/lease-templates/types";
import {
  createDefaultListingSubmission,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { buildListingQuote } from "@/lib/listing-quote";
import type { LeaseGenerationContext } from "@/lib/generated-lease";
import {
  feeVisibilityForTerms,
  resolveRoomTermFees,
  roomFeeTermScope,
  roomPricingFeeVisibility,
  submissionWithRoomTermFees,
  termFeePatch,
  termFeeText,
} from "@/lib/room-term-fees";

function room(over: Partial<ManagerRoomSubmission> = {}): ManagerRoomSubmission {
  return { ...emptyRoom(0), id: "room-7", name: "Room 7", monthlyRent: 800, ...over };
}

function listing(
  roomOver: Partial<ManagerRoomSubmission> = {},
  subOver: Partial<ManagerListingSubmissionV1> = {},
): ManagerListingSubmissionV1 {
  return normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    buildingName: "Spokane House",
    address: "100 Main St, Spokane, WA 99201",
    city: "Spokane",
    state: "WA",
    zip: "99201",
    securityDeposit: "400",
    allowedLeaseTerms: ["Long-term", "Month-to-Month", "Custom"],
    shortTermRentalsAllowed: true,
    rooms: [room(roomOver)],
    ...subOver,
  });
}

describe("which rows the room pricing popup shows", () => {
  it("shows the month-to-month surcharge only when Month-to-month is offered", () => {
    expect(feeVisibilityForTerms(["Long-term", "Month-to-Month"]).monthToMonthSurcharge).toBe(true);
    expect(feeVisibilityForTerms(["Long-term", "Custom"]).monthToMonthSurcharge).toBe(false);
  });

  it("shows the custom start surcharge and Partial months only when Custom is offered", () => {
    const withCustom = feeVisibilityForTerms(["Long-term", "Custom"]);
    expect(withCustom.customStartSurcharge).toBe(true);
    expect(withCustom.partialMonths).toBe(true);
    const without = feeVisibilityForTerms(["Long-term", "Month-to-Month"]);
    expect(without.customStartSurcharge).toBe(false);
    expect(without.partialMonths).toBe(false);
  });

  it("follows the room's own Leases offered when it restricts them, else the listing's", () => {
    const sub = listing();
    expect(roomPricingFeeVisibility(sub, sub.rooms[0])).toEqual({
      monthToMonthSurcharge: true,
      customStartSurcharge: true,
      partialMonths: true,
    });
    const restricted = listing({ offeredLeaseTerms: ["Long-term", "Month-to-Month"] });
    expect(roomPricingFeeVisibility(restricted, restricted.rooms[0])).toEqual({
      monthToMonthSurcharge: true,
      customStartSurcharge: false,
      partialMonths: false,
    });
    const customOnly = listing({ offeredLeaseTerms: ["Long-term", "Custom"] });
    expect(roomPricingFeeVisibility(customOnly, customOnly.rooms[0]).monthToMonthSurcharge).toBe(false);
  });

  it("a listing that never offers Custom hides its rows for every room", () => {
    const sub = listing({}, { allowedLeaseTerms: ["Long-term", "Month-to-Month"] });
    expect(roomPricingFeeVisibility(sub, sub.rooms[0]).partialMonths).toBe(false);
  });
});

describe("Application fee and Lease fee are bound to their step", () => {
  it("the Long-term step edits the shared value and the Short term step its own", () => {
    expect(termFeePatch("applicationFee", "long", "50")).toEqual({ applicationFee: "50" });
    expect(termFeePatch("applicationFee", "short", "20")).toEqual({ shortTermApplicationFee: "20" });
    expect(termFeePatch("leaseFee", "long", "100")).toEqual({ leaseFee: "100" });
    expect(termFeePatch("leaseFee", "short", "40")).toEqual({ shortTermLeaseFee: "40" });
  });

  it("a short-term box with no value of its own shows the shared one as inherited", () => {
    const row = { applicationFee: "50", leaseFee: "100" };
    expect(termFeeText(row, "applicationFee", "short")).toEqual({ value: "", placeholder: "50", own: false });
    expect(termFeeText(row, "leaseFee", "long")).toEqual({ value: "100", placeholder: "", own: true });
    expect(termFeeText({ ...row, shortTermLeaseFee: "40" }, "leaseFee", "short")).toEqual({
      value: "40",
      placeholder: "",
      own: true,
    });
  });

  it("scope follows the lease term and rental type", () => {
    expect(roomFeeTermScope("Long-term")).toBe("long");
    expect(roomFeeTermScope("Month-to-Month")).toBe("long");
    expect(roomFeeTermScope("Short-Term Stay")).toBe("short");
    expect(roomFeeTermScope("Long-term", "short_term")).toBe("short");
  });

  it("persists the short-term fees on the Private row and old rows read unchanged", () => {
    const sub = listing({
      occupancyPrices: [{ count: 1, applicationFee: "50", leaseFee: "100", shortTermApplicationFee: "20" }],
    });
    const row = sub.rooms[0]!.occupancyPrices![0]!;
    expect(row.shortTermApplicationFee).toBe("20");
    expect(row.shortTermLeaseFee).toBeUndefined();
    const legacy = listing({ occupancyPrices: [{ count: 1, applicationFee: "50", leaseFee: "100" }] });
    const resolved = resolveRoomTermFees({ sub: legacy, room: legacy.rooms[0], leaseTerm: "Short-Term Stay" });
    // No short-term value of its own: the stay pays the shared one, exactly as before.
    expect(resolved.applicationFee).toBe(50);
    expect(resolved.leaseFee).toBe(100);
  });

  it("resolves each term to its own value and never invents one", () => {
    const sub = listing({
      occupancyPrices: [
        {
          count: 1,
          applicationFee: "50",
          leaseFee: "100",
          shortTermApplicationFee: "20",
          shortTermLeaseFee: "0",
          monthToMonthSurcharge: "25",
          customStartSurcharge: "60",
        },
      ],
    });
    const long = resolveRoomTermFees({ sub, room: sub.rooms[0], leaseTerm: "Long-term" });
    expect(long).toMatchObject({ applicationFee: 50, leaseFee: 100, monthToMonthSurcharge: 25, customStartSurcharge: 60 });
    const short = resolveRoomTermFees({ sub, room: sub.rooms[0], leaseTerm: "Short-Term Stay" });
    // A typed 0 is a real answer ("free for stays"), not "fall back to the shared fee".
    expect(short).toMatchObject({ applicationFee: 20, leaseFee: 0, monthToMonthSurcharge: 0, customStartSurcharge: 0 });
    const nothing = resolveRoomTermFees({ sub: listing(), room: listing().rooms[0], leaseTerm: "Long-term" });
    expect(nothing).toMatchObject({ leaseFee: 0, monthToMonthSurcharge: 0, customStartSurcharge: 0 });
  });
});

describe("the receipt and the overlay read the same fees", () => {
  const priced = listing({
    occupancyPrices: [
      {
        count: 1,
        applicationFee: "50",
        leaseFee: "100",
        shortTermApplicationFee: "20",
        shortTermLeaseFee: "40",
        monthToMonthSurcharge: "25",
        customStartSurcharge: "60",
      },
    ],
  });

  it("the receipt prices each step with its own Lease fee and Application fee", () => {
    const long = buildListingQuote(priced, { roomId: "room-7", leaseTerm: "Long-term", arrangementCount: 1 });
    expect(long.applicationFees.map((f) => f.amount)).toContain(50);
    expect(long.signingLines.find((l) => l.key === "arrangement_lease_fee")?.amount).toBe(100);
    const short = buildListingQuote(priced, { roomId: "room-7", leaseTerm: "Short-Term Stay", arrangementCount: 1 });
    expect(short.applicationFees.map((f) => f.amount)).toContain(20);
    expect(short.signingLines.find((l) => l.key === "arrangement_lease_fee")?.amount).toBe(40);
  });

  it("the receipt adds the start surcharge to the monthly rent only for that start", () => {
    const std = buildListingQuote(priced, { roomId: "room-7", leaseTerm: "Long-term", arrangementCount: 1 });
    const m2m = buildListingQuote(priced, { roomId: "room-7", leaseTerm: "Long-term", arrangementCount: 1, startKind: "m2m" });
    const cst = buildListingQuote(priced, { roomId: "room-7", leaseTerm: "Long-term", arrangementCount: 1, startKind: "cst" });
    expect(m2m.monthlyRent - std.monthlyRent).toBe(25);
    expect(cst.monthlyRent - std.monthlyRent).toBe(60);
  });

  it("the overlay hands the room's surcharges and Lease fee to everything that reads the listing", () => {
    const out = submissionWithRoomTermFees(priced, priced.rooms[0], { leaseTerm: "Long-term" });
    expect(out.monthToMonthSurcharge).toBe("25");
    expect(out.customLeaseSurcharge).toBe("60");
    expect(out.applicationFee).toBe("50");
    const leaseFee = out.customFees?.find((f) => f.id === "room_lease_fee:room-7");
    expect(leaseFee).toMatchObject({ label: "Lease fee", amount: "100", frequency: "one-time" });
    const stay = submissionWithRoomTermFees(priced, priced.rooms[0], { leaseTerm: "Short-Term Stay" });
    // A stay never carries the start surcharges; it carries the short-term fees.
    expect(stay.monthToMonthSurcharge).toBe(priced.monthToMonthSurcharge);
    expect(stay.applicationFee).toBe("20");
    expect(stay.customFees?.find((f) => f.id === "room_lease_fee:room-7")).toMatchObject({ amount: "40", shortTermAmount: "40" });
  });

  it("returns the very same listing when the room sets nothing", () => {
    const plain = listing();
    expect(submissionWithRoomTermFees(plain, plain.rooms[0], { leaseTerm: "Long-term" })).toBe(plain);
  });
});

function leaseContext(
  sub: ManagerListingSubmissionV1,
  application: Partial<LeaseGenerationContext["application"]> = {},
): LeaseGenerationContext {
  return {
    application: {
      fullLegalName: "Jordan Lee",
      email: "jordan@example.com",
      leaseTerm: "Long-term",
      leaseStart: "2026-06-01",
      leaseEnd: "2027-05-31",
      roomChoice1: "property-1::room-7",
      ...application,
    },
    leasedRoom: undefined,
    listingProperty: {
      id: "property-1",
      title: "Spokane House",
      address: "100 Main St, Spokane, WA 99201",
      buildingName: "Spokane House",
      unitLabel: "Room 7",
    } as LeaseGenerationContext["listingProperty"],
    submission: sub,
    generatedAtIso: "2026-05-01T00:00:00.000Z",
    leaseBilling: {
      monthlyRent: 800,
      monthlyUtilities: 0,
      securityDeposit: 400,
      moveInFee: 0,
      otherCostLabel: "Other costs",
      otherCostAmount: 0,
      dueAtSigning: 400,
    },
  };
}

describe("the generated lease carries the room's fees for its term", () => {
  const priced = listing({
    occupancyPrices: [
      {
        count: 1,
        applicationFee: "50",
        leaseFee: "100",
        shortTermLeaseFee: "40",
        monthToMonthSurcharge: "25",
        customStartSurcharge: "60",
      },
    ],
  });

  it("prints the Lease fee for the lease's term in the summary", () => {
    const html = buildLeaseHtml(leaseContext(priced), WASHINGTON_LEASE_CONFIG);
    expect(html).toMatch(/Lease fee:<\/strong> \$100\.00/);
    expect(html).not.toMatch(/\$40\.00/);
  });

  it("prints the month-to-month surcharge on a month-to-month lease and not on a fixed one", () => {
    const m2m = buildLeaseHtml(
      leaseContext(priced, { leaseTerm: "Month-to-Month", leaseEnd: "" }),
      WASHINGTON_LEASE_CONFIG,
    );
    expect(m2m).toMatch(/Month-to-month surcharge:<\/strong> \$25\.00/);
    const fixed = buildLeaseHtml(leaseContext(priced), WASHINGTON_LEASE_CONFIG);
    expect(fixed).not.toMatch(/Month-to-month surcharge:<\/strong>/);
  });

  it("prints the custom start surcharge on a custom-start lease only", () => {
    const custom = buildLeaseHtml(
      leaseContext(priced, { leaseTerm: "Custom", leaseStart: "2026-06-09", leaseEnd: "2026-09-21" }),
      WASHINGTON_LEASE_CONFIG,
    );
    expect(custom).toMatch(/Custom lease:<\/strong> \$60\.00/);
    const fixed = buildLeaseHtml(leaseContext(priced), WASHINGTON_LEASE_CONFIG);
    expect(fixed).not.toMatch(/Custom lease:<\/strong>/);
  });

  it("never bills a fee the manager did not set", () => {
    const html = buildLeaseHtml(leaseContext(listing()), WASHINGTON_LEASE_CONFIG);
    expect(html).not.toMatch(/Lease fee:<\/strong>/);
    expect(html).not.toMatch(/Month-to-month surcharge:<\/strong>/);
  });

  it("folds the room's month-to-month surcharge into the rent on a Seattle listing, as the ledger does", () => {
    const seattle = listing(
      { occupancyPrices: [{ count: 1, monthToMonthSurcharge: "25" }] },
      { address: "5259 Brooklyn Ave NE, Seattle, WA 98105", city: "Seattle", zip: "98105" },
    );
    const ctx = leaseContext(seattle, { leaseTerm: "Month-to-Month", leaseEnd: "" });
    ctx.listingProperty = { ...ctx.listingProperty!, address: "5259 Brooklyn Ave NE, Seattle, WA 98105" };
    const html = buildLeaseHtml(ctx, SEATTLE_LEASE_CONFIG);
    expect(html).toContain("$25.00 month-to-month surcharge");
  });
});
