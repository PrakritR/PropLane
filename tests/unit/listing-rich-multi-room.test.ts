import { describe, expect, it } from "vitest";
import type { MockProperty } from "@/data/types";
import { getListingRichContent, listingRoomPriceMetaLine } from "@/data/listing-rich-content";
import { listingRichFromManagerSubmission } from "@/data/listing-rich-from-submission";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

function mockProperty(overrides: Partial<MockProperty> & Pick<MockProperty, "id">): MockProperty {
  return {
    title: "Magnolia House",
    tagline: "Shared house",
    address: "1420 Magnolia Ave, Seattle, WA",
    zip: "98122",
    neighborhood: "Capitol Hill",
    beds: 5,
    baths: 2,
    rentLabel: "$1,050–$1,300 / mo",
    available: "Now",
    petFriendly: true,
    buildingId: "b1",
    buildingName: "Magnolia House",
    unitLabel: "5 rooms",
    adminPublishLive: true,
    ...overrides,
  };
}

describe("listing multi-room lease basics", () => {
  it("sorts rooms within a floor by room number in rich content", () => {
    const sub = createDefaultListingSubmission();
    const base = sub.rooms[0]!;
    sub.rooms = [5, 3, 4, 1, 2].map((n) => ({
      ...base,
      id: `room-${n}`,
      name: `Room ${n}`,
      floor: "1st / main floor",
      monthlyRent: 1000 + n,
    }));
    const property = mockProperty({ id: "sort-test", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);
    const names = rich.floorPlans.flatMap((f) => f.rooms.map((r) => r.name));
    expect(names).toEqual(["Room 1", "Room 2", "Room 3", "Room 4", "Room 5"]);
  });

  it("shows per-room rent on floor plans, not in lease basics", () => {
    const sub = createDefaultListingSubmission();
    sub.securityDeposit = "600";
    sub.moveInFee = "150";
    sub.rooms = [
      {
        ...sub.rooms[0]!,
        id: "room-1",
        name: "Room 1",
        floor: "2nd floor",
        monthlyRent: 3000,
        utilitiesEstimate: "$150",
      },
    ];
    const property = mockProperty({ id: "single-room-lease", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);
    const floorRoom = rich.floorPlans.flatMap((f) => f.rooms).find((r) => r.id === "room-1");
    expect(floorRoom?.priceHeadlineAmount).toBe(3000);
    expect(floorRoom?.utilitiesEstimate).toBeTruthy();
    expect(listingRoomPriceMetaLine(floorRoom!)).toMatch(/\$3,000\/mo/);
    expect(listingRoomPriceMetaLine(floorRoom!)).toMatch(/\$150/);
    expect(rich.leaseBasics.some((row) => row.id === "lease-room-room-1")).toBe(false);
    expect(rich.leaseBasics.some((row) => row.id === "lease-utilities")).toBe(false);
    expect(rich.leaseBasics.some((row) => row.id === "lease-signing")).toBe(false);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Security deposit")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Move-in fee")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Holding deposit")).toBe(false);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Due at signing")).toBe(false);
  });

  it("includes unified long-term fees in the pricing sidebar breakdown", () => {
    const sub = createDefaultListingSubmission();
    sub.applicationFee = "50";
    sub.monthToMonthSurcharge = "25";
    sub.customLeaseSurcharge = "100";
    sub.holdingDeposit = "50";
    const property = mockProperty({ id: "unified-fees-sidebar", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    expect(rich.pricingBreakdown?.some((line) => line.label === "Application fee" && line.value === "$50.00")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Month-to-month surcharge" && line.value === "$25.00/mo")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Custom lease" && line.value === "$100.00/mo")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Holding deposit")).toBe(false);
  });

  it("uses entire-home utilities estimate in the sidebar monthly total", () => {
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "entire_home";
    sub.entireHomeMonthlyRent = 1200;
    sub.entireHomeUtilitiesEstimate = "200";
    sub.rooms = [{ ...sub.rooms[0]!, id: "bed-1", name: "Bedroom 1", monthlyRent: 1200 }];
    const property = mockProperty({ id: "entire-home-utilities-sidebar", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    expect(rich.startingRentLabel).toBe("$1200/mo");
    expect(rich.estimatedMonthlyTotalLabel).toBe("$1400/mo");
  });

  it("reflects entire-home short-term prices from the fees form in the sidebar", () => {
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "entire_home";
    sub.entireHomeMonthlyRent = 1200;
    sub.entireHomeUtilitiesEstimate = "200";
    sub.shortTermRentalsAllowed = true;
    sub.shortTermDailyCost = "75";
    sub.shortTermApplicationFee = "50";
    sub.shortTermDeposit = "200";
    sub.shortTermMoveInFee = "75";
    sub.rooms = [{ ...sub.rooms[0]!, id: "bed-1", name: "Bedroom 1", monthlyRent: 1200 }];
    const property = mockProperty({ id: "entire-home-st-sidebar", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    expect(rich.pricingBreakdown?.some((line) => line.label === "Short-term application fee" && line.value === "$50.00")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Nightly rate" && line.value === "$75.00/night")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Short-term deposit" && line.value === "$200.00")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Move-in / cleaning" && line.value === "$75.00")).toBe(true);
  });

  it("shows short-term room nightly rates and placement fees on listing", () => {
    const sub = createDefaultListingSubmission();
    sub.shortTermRentalsAllowed = true;
    sub.shortTermApplicationFee = "50";
    sub.shortTermMoveInFee = "75";
    sub.rooms = [
      { ...sub.rooms[0]!, id: "room-1", name: "Room 1", floor: "2nd floor", monthlyRent: 800, shortTermRent: "50", shortTermDeposit: "200" },
      { ...sub.rooms[0]!, id: "room-2", name: "Room 2", floor: "2nd floor", monthlyRent: 800, shortTermRent: "50", shortTermDeposit: "200" },
    ];
    const property = mockProperty({ id: "st-room-costs", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    expect(rich.leaseBasics.find((row) => row.id === "lease-st-application")?.price).toBe("$50.00");
    expect(rich.leaseBasics.filter((row) => row.section === "short-term" && row.price.endsWith("/night"))).toHaveLength(2);
    expect(rich.leaseBasics.find((row) => row.id === "lease-st-deposit")?.price).toBe("$200.00");
    expect(rich.leaseBasics.find((row) => row.id === "lease-st-move-in")?.price).toBe("$75.00");

    expect(rich.pricingBreakdown?.some((line) => line.label === "Short-term application fee" && line.value === "$50.00")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Nightly rate" && line.value === "$50.00/night")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Short-term deposit")).toBe(true);
    expect(rich.pricingBreakdown?.some((line) => line.label === "Move-in / cleaning")).toBe(true);
  });

  it("does not show short-term deposit when none is configured on the listing", () => {
    const sub = createDefaultListingSubmission();
    sub.shortTermRentalsAllowed = true;
    sub.shortTermDailyCost = "50";
    sub.shortTermApplicationFee = "25";
    sub.securityDeposit = "400";
    sub.shortTermDeposit = "";
    sub.rooms = [
      { ...sub.rooms[0]!, id: "room-1", name: "Room 1", monthlyRent: 800, shortTermRent: "50" },
    ];
  sub.customFees = [
    {
      id: "st-dep-ghost",
      presetId: "short_term_deposit",
      label: "Short-term deposit",
      amount: "250",
      frequency: "one-time",
      cadence: "one-time",
    },
  ];
    const property = mockProperty({ id: "st-no-deposit", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    expect(rich.pricingBreakdown?.some((line) => line.label === "Short-term deposit")).toBe(false);
    expect(rich.leaseBasics.some((row) => row.title === "Short-term deposit")).toBe(false);
  });

  it("routes short-term custom fees to the short-term lease basics section", () => {
    const sub = createDefaultListingSubmission();
    sub.shortTermRentalsAllowed = true;
    sub.shortTermDailyCost = "95";
    sub.customFees = [
      ...(sub.customFees ?? []),
      { id: "cf-st", label: "Short term lease", amount: "100", frequency: "one-time" },
    ];
    const property = mockProperty({ id: "st-custom-fee", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);
    expect(rich.shortTermRentalsAllowed).toBe(true);
    const custom = rich.leaseBasics.find((row) => row.id === "fee-cf-st");
    expect(custom?.section).toBe("short-term");
    expect(custom?.title).toBe("Custom lease");
    expect(rich.leaseBasics.some((row) => row.section === "long-term" && row.title === "Custom lease")).toBe(false);
  });

  it("adds a two-or-more-rooms row to lease basics for shared listings", () => {
    const sub = createDefaultListingSubmission();
    sub.rooms = [
      { ...sub.rooms[0]!, id: "room-5", name: "Room 5", monthlyRent: 1050 },
      { ...sub.rooms[0]!, id: "room-4", name: "Room 4", monthlyRent: 1150 },
      { ...sub.rooms[0]!, id: "room-3", name: "Room 3", monthlyRent: 1200 },
    ];
    sub.bundles = [
      {
        id: "bundle-multi",
        label: "Two or more rooms",
        price: "$2,200/mo",
        strikethrough: "",
        promo: "Combine any two or more bedrooms on one lease.",
        roomsLine: "Example: Room 5 + Room 4",
        includedRoomIds: ["room-5", "room-4"],
      },
    ];

    const property = mockProperty({ id: "mgr-test-magnolia", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);
    const leaseRow = rich.leaseBasics.find((row) => row.id === "lease-bundle-bundle-multi");

    expect(leaseRow?.title).toBe("Two or more rooms");
    expect(leaseRow?.price).toBe("$2,200/mo");
    expect(rich.bundleCards[0]?.label).toBe("Two or more rooms");
    expect(rich.bundleCards[0]?.price).toBe("$2,200/mo");
  });

  it("does not show bundle cards for entire-home listings", () => {
    const sub = createDefaultListingSubmission();
    sub.listingPlaceCategoryId = "entire_home";
    sub.entireHomeMonthlyRent = 4500;
    sub.rooms = [{ ...sub.rooms[0]!, id: "bed-1", name: "Bedroom 1", monthlyRent: 4500 }];
    sub.bundles = [
      {
        id: "bundle-legacy",
        label: "Whole house lease",
        price: "$4500/mo",
        strikethrough: "",
        promo: "",
        roomsLine: "",
        includedRoomIds: ["bed-1"],
      },
    ];

    const property = mockProperty({ id: "entire-home-no-bundles", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    expect(rich.bundleCards).toEqual([]);
    expect(rich.leaseBasics.some((row) => row.id === "lease-multi-room")).toBe(false);
    const entireRow = rich.leaseBasics.find((row) => row.id === "lease-entire-home");
    expect(entireRow?.price).toBe("$4500.00/mo");
    expect(entireRow?.section).toBe("long-term");
  });

  it("falls back to generated demo lease basics when no submission exists", () => {
    const rich = getListingRichContent(mockProperty({ id: "demo-only" }));
    expect(rich.leaseBasics.some((row) => row.id === "lease-multi-room")).toBe(true);
    expect(rich.bundleCards[0]?.label).toBe("Two or more rooms");
  });

  it("passes per-floor and property-wide floor plan URLs into floor cards", () => {
    const sub = createDefaultListingSubmission();
    sub.rooms = [
      { ...sub.rooms[0]!, id: "r1", name: "Room 1", floor: "1st / main floor", monthlyRent: 900 },
      { ...sub.rooms[0]!, id: "r2", name: "Room 2", floor: "2nd floor", monthlyRent: 950 },
    ];
    sub.floorPlanByLabel = {
      "1st / main floor": "data:image/png;base64,first-floor",
      "2nd floor": "data:image/png;base64,second-floor",
    };
    sub.propertyFloorPlanDataUrl = "data:image/png;base64,whole-house";

    const property = mockProperty({ id: "mgr-floor-plans", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    const main = rich.floorPlans.find((f) => f.floorLabel === "1st / main floor");
    const upper = rich.floorPlans.find((f) => f.floorLabel === "2nd floor");
    expect(main?.floorPlanImageUrl).toBe("data:image/png;base64,first-floor");
    expect(upper?.floorPlanImageUrl).toBe("data:image/png;base64,second-floor");
    expect(main?.rooms[0]?.modal.bathroomShortLabel).toBeDefined();
  });

  it("uses property-wide floor plan when a floor has no dedicated upload", () => {
    const sub = createDefaultListingSubmission();
    sub.rooms = [{ ...sub.rooms[0]!, id: "r1", name: "Room 1", floor: "Loft / attic", monthlyRent: 800 }];
    sub.propertyFloorPlanDataUrl = "data:image/png;base64,property-wide";

    const property = mockProperty({ id: "mgr-floor-fallback", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    expect(rich.floorPlans[0]?.floorPlanImageUrl).toBe("data:image/png;base64,property-wide");
  });

  it("groups floor plans by bedroom floor even when bathrooms assign cross-floor rooms", () => {
    const sub = createDefaultListingSubmission();
    sub.rooms = [
      { ...sub.rooms[0]!, id: "r5", name: "Room 5", floor: "3rd floor", monthlyRent: 775 },
      { ...sub.rooms[0]!, id: "r6", name: "Room 6", floor: "3rd floor", monthlyRent: 775 },
      { ...sub.rooms[0]!, id: "r7", name: "Room 7", floor: "3rd floor", monthlyRent: 775 },
      { ...sub.rooms[0]!, id: "r8", name: "Room 8", floor: "3rd floor", monthlyRent: 775 },
      { ...sub.rooms[0]!, id: "r9", name: "Room 9", floor: "1st / main floor", monthlyRent: 750 },
    ];
    sub.bathrooms = [
      {
        ...sub.bathrooms[0]!,
        id: "bath-4",
        name: "Bathroom 4",
        location: "Third Floor",
        assignedRoomIds: ["r5", "r6", "r7", "r8", "r9"],
      },
    ];

    const property = mockProperty({ id: "mgr-cross-floor", listingSubmission: sub });
    const rich = listingRichFromManagerSubmission(property, sub);

    expect(rich.floorPlansSectionTitle).toBeUndefined();
    expect(rich.floorPlans).toHaveLength(2);
    expect(rich.floorPlans[0]?.floorLabel).toBe("1st / main floor");
    expect(rich.floorPlans[0]?.rooms.map((r) => r.name)).toEqual(["Room 9"]);
    expect(rich.floorPlans[1]?.floorLabel).toBe("3rd floor");
    expect(rich.floorPlans[1]?.rooms.map((r) => r.name)).toEqual(["Room 5", "Room 6", "Room 7", "Room 8"]);
  });
});
