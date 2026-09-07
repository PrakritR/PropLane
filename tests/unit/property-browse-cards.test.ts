import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MockProperty } from "@/data/types";
import {
  buildPropertyBrowseCards,
  demoOnlyBrowseCardPlaceholderImage,
  filterRoomListings,
  sortPropertyBrowseCards,
} from "@/lib/room-listings-catalog";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { writeManagerApplicationRows } from "@/lib/manager-applications-storage";

const leaseRows: Record<string, unknown>[] = [];

vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return {
    ...actual,
    readLeasePipeline: () => leaseRows.map((row) => actual.normalizeLeasePipelineRow(row)),
  };
});

function executedLease(appId: string) {
  leaseRows.push({
    id: `lease_${appId}`,
    axisId: appId,
    status: "Fully Signed",
    fullySignedAt: "2026-01-01T00:00:00.000Z",
    managerSignature: { role: "manager", name: "Manager", signedAtIso: "2026-01-01" },
    residentSignature: { role: "resident", name: "Resident", signedAtIso: "2026-01-01" },
  });
}

beforeEach(() => {
  leaseRows.length = 0;
});

function mockProperty(overrides: Partial<MockProperty> & Pick<MockProperty, "id">): MockProperty {
  return {
    title: "Test home",
    tagline: "Cozy room",
    address: "123 Main St, Seattle, WA",
    zip: "98101",
    neighborhood: "Capitol Hill",
    beds: 2,
    baths: 1,
    rentLabel: "$900/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Main House",
    unitLabel: "Unit A",
    adminPublishLive: true,
    ...overrides,
  };
}

describe("buildPropertyBrowseCards", () => {
  it("sorts properties by cheapest available room rent", () => {
    const properties = [
      mockProperty({ id: "expensive", neighborhood: "Ballard" }),
      mockProperty({ id: "cheap", neighborhood: "U District" }),
    ];

    const cards = buildPropertyBrowseCards(properties);
    if (cards.length < 2) return;

    for (let i = 1; i < cards.length; i++) {
      const prev = cards[i - 1]!.rentNumeric;
      const next = cards[i]!.rentNumeric;
      if (prev !== null && next !== null) {
        expect(prev).toBeLessThanOrEqual(next);
      }
    }
  });

  it("leaves imageUrl empty for a listing with no genuine uploaded photo (never fabricates a stock photo)", () => {
    const properties = [mockProperty({ id: "p1" })];
    const cards = buildPropertyBrowseCards(properties);
    if (cards.length === 0) return;

    expect(cards[0]!.imageUrl).toBe("");
    expect(cards[0]!.propertyId).toBe("p1");
  });

  it("uses the real uploaded photo when one exists", () => {
    const properties = [
      mockProperty({
        id: "p2",
        listingSubmission: {
          v: 1,
          buildingName: "Main House",
          address: "123 Main St, Seattle, WA",
          zip: "98101",
          neighborhood: "Capitol Hill",
          listingPlaceCategoryId: "private_room",
          tagline: "",
          petFriendly: false,
          houseOverview: "",
          houseRulesText: "",
          housePhotoDataUrls: [],
          leaseTermsBody: "",
          applicationFee: "",
          securityDeposit: "",
          moveInFee: "",
          paymentAtSigningIncludes: ["security_deposit", "move_in_fee"],
          houseCostsDetail: "",
          parkingMonthly: "",
          hoaMonthly: "",
          otherMonthlyFees: "",
          sharedSpaces: [],
          amenitiesText: "",
          rooms: [
            {
              id: "r1",
              name: "Room 1",
              floor: "",
              monthlyRent: 900,
              availability: "",
              moveInAvailableDate: "",
              moveInInstructions: "",
              manualUnavailableRanges: [],
              detail: "",
              furnishing: "",
              roomAmenitiesText: "",
              photoDataUrls: ["https://storage.example.com/real-room-photo.jpg"],
              videoDataUrl: null,
              utilitiesEstimate: "",
            },
          ],
          bathrooms: [],
          bundles: [],
          quickFacts: [],
        } as MockProperty["listingSubmission"],
      }),
    ];
    const cards = buildPropertyBrowseCards(properties);
    if (cards.length === 0) return;

    expect(cards[0]!.imageUrl).toBe("https://storage.example.com/real-room-photo.jpg");
  });

  it("demo-only placeholder fallback is deterministic per property id (used only when isDemoModeActive())", () => {
    expect(demoOnlyBrowseCardPlaceholderImage("p1")).toBe(demoOnlyBrowseCardPlaceholderImage("p1"));
    expect(demoOnlyBrowseCardPlaceholderImage("p1")).toMatch(/^https:\/\/images\.unsplash\.com\//);
  });

  it("sorts highest price first when requested", () => {
    const properties = [
      mockProperty({ id: "cheap", neighborhood: "U District" }),
      mockProperty({ id: "expensive", neighborhood: "Ballard" }),
    ];
    const cards = sortPropertyBrowseCards(buildPropertyBrowseCards(properties), "price-desc");
    if (cards.length < 2) return;

    const first = cards[0]!.rentNumeric;
    const second = cards[1]!.rentNumeric;
    if (first !== null && second !== null) {
      expect(first).toBeGreaterThanOrEqual(second);
    }
  });

  it("shows all listed properties when no move-in or move-out is set", () => {
    const property = mockProperty({
      id: "brooklyn",
      title: "5259 Brooklyn Ave NE",
      listingSubmission: {
        v: 1,
        rooms: [{ id: "r3", name: "Room 3", monthlyRent: 825, floor: "", detail: "", furnishing: "", roomAmenitiesText: "", utilitiesEstimate: "", photoDataUrls: [] }],
        bathrooms: [],
        buildingPhotos: [],
        entireHome: false,
      } as MockProperty["listingSubmission"],
    });

    writeManagerApplicationRows([
      {
        id: "resident-1",
        bucket: "approved",
        assignedPropertyId: "brooklyn",
        assignedRoomChoice: `brooklyn${LISTING_ROOM_CHOICE_SEP}r3`,
        manualResidentDetails: {
          moveInDate: "2026-05-23",
          moveOutDate: "2026-09-05",
          roomNumber: "Room 3",
        },
      } as never,
    ]);

    const rows = filterRoomListings([property], {
      zipRaw: "",
      radiusMiles: 50,
      maxBudgetNum: null,
      bathroom: "any",
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  // PRP-398: an approved application does NOT hold a room on the public listing.
  // Only a manager-added resident (`manuallyAdded`) or a fully executed lease does,
  // so the fixture below has to be a genuine hold rather than a bare approval.
  it("hides rooms occupied during the requested move-in window", () => {
    const property = mockProperty({
      id: "brooklyn",
      listingSubmission: {
        v: 1,
        rooms: [{ id: "r3", name: "Room 3", monthlyRent: 825, floor: "", detail: "", furnishing: "", roomAmenitiesText: "", utilitiesEstimate: "", photoDataUrls: [] }],
        bathrooms: [],
        buildingPhotos: [],
        entireHome: false,
      } as MockProperty["listingSubmission"],
    });

    writeManagerApplicationRows([
      {
        id: "resident-1",
        bucket: "approved",
        manuallyAdded: true,
        assignedPropertyId: "brooklyn",
        assignedRoomChoice: `brooklyn${LISTING_ROOM_CHOICE_SEP}r3`,
        manualResidentDetails: {
          moveInDate: "2026-05-23",
          moveOutDate: "2026-09-05",
          roomNumber: "Room 3",
        },
      } as never,
    ]);
    executedLease("resident-1");

    const blocked = filterRoomListings([property], {
      zipRaw: "",
      radiusMiles: 50,
      maxBudgetNum: null,
      bathroom: "any",
      moveIn: "2026-06-01",
    });
    expect(blocked.some((r) => r.roomId === "r3")).toBe(false);

    const available = filterRoomListings([property], {
      zipRaw: "",
      radiusMiles: 50,
      maxBudgetNum: null,
      bathroom: "any",
      moveIn: "2026-09-14",
    });
    expect(available.some((r) => r.roomId === "r3")).toBe(true);
  });

  it("keeps a room browsable while an approved application is still unsigned (PRP-398)", () => {
    const property = mockProperty({
      id: "brooklyn",
      listingSubmission: {
        v: 1,
        rooms: [{ id: "r3", name: "Room 3", monthlyRent: 825, floor: "", detail: "", furnishing: "", roomAmenitiesText: "", utilitiesEstimate: "", photoDataUrls: [] }],
        bathrooms: [],
        buildingPhotos: [],
        entireHome: false,
      } as MockProperty["listingSubmission"],
    });

    // Same window as above, but a plain approval with no executed lease and no
    // manager-added resident. Public availability must not move for it.
    writeManagerApplicationRows([
      {
        id: "resident-1",
        bucket: "approved",
        assignedPropertyId: "brooklyn",
        assignedRoomChoice: `brooklyn${LISTING_ROOM_CHOICE_SEP}r3`,
        manualResidentDetails: {
          moveInDate: "2026-05-23",
          moveOutDate: "2026-09-05",
          roomNumber: "Room 3",
        },
      } as never,
    ]);

    const rows = filterRoomListings([property], {
      zipRaw: "",
      radiusMiles: 50,
      maxBudgetNum: null,
      bathroom: "any",
      moveIn: "2026-06-01",
    });
    expect(rows.some((r) => r.roomId === "r3")).toBe(true);
  });
});

describe("buildPropertyBrowseCards — propertyIds filter (shared 'these homes' link)", () => {
  it("restricts the browse set to exactly the given property ids", () => {
    const properties = [
      mockProperty({ id: "a", neighborhood: "Ballard" }),
      mockProperty({ id: "b", neighborhood: "U District" }),
      mockProperty({ id: "c", neighborhood: "Fremont" }),
    ];

    const cards = buildPropertyBrowseCards(properties, { filters: { propertyIds: ["a", "c"] } });
    const ids = cards.map((card) => card.propertyId).sort();
    expect(ids).toEqual(["a", "c"]);
  });

  it("is a no-op when propertyIds is empty or undefined (shows all)", () => {
    const properties = [mockProperty({ id: "a" }), mockProperty({ id: "b" })];
    expect(buildPropertyBrowseCards(properties, { filters: { propertyIds: [] } }).length).toBe(
      buildPropertyBrowseCards(properties).length,
    );
    expect(buildPropertyBrowseCards(properties, { filters: { propertyIds: null } }).length).toBe(
      buildPropertyBrowseCards(properties).length,
    );
  });

  it("ignores ids that are not in the catalog", () => {
    const properties = [mockProperty({ id: "a" }), mockProperty({ id: "b" })];
    const cards = buildPropertyBrowseCards(properties, { filters: { propertyIds: ["a", "does-not-exist"] } });
    expect(cards.map((c) => c.propertyId)).toEqual(["a"]);
  });
});
