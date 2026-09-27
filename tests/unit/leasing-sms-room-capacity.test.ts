import { beforeEach, describe, expect, it, vi } from "vitest";

const occupancy = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/public-listings.server", () => ({
  getPublicListings: vi.fn(),
}));
vi.mock("@/lib/public-room-occupancy.server", () => ({
  loadPublicRoomOccupancy: occupancy.load,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({}),
}));

import { getPublicListings } from "@/lib/public-listings.server";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import type { AgentContext } from "@/lib/tools/context";
import {
  __resetLeasingCatalogCache,
  __resetSmsOccupancyCache,
  getListingDetailsTool,
  listLiveListingsTool,
} from "@/lib/tools/domains/leasing-sms";

const PROPERTY_ID = "capacity-house";

function emptyOwnedListingDb(): AgentContext["db"] {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    query[method] = () => query;
  }
  query.maybeSingle = async () => ({ data: null, error: null });
  return { from: () => query } as AgentContext["db"];
}

function context(): AgentContext {
  return {
    landlordId: "manager-1",
    userId: "manager-1",
    email: "",
    roles: ["leasing_sms_agent"],
    isAdmin: false,
    db: emptyOwnedListingDb(),
    leasingScope: {
      sessionId: "session-1",
      prospectPhoneE164: "+12065550123",
      workNumber: "+12065550124",
      crossCatalog: true,
    },
  } as AgentContext;
}

function listing(rooms: Record<string, unknown>[]) {
  const submission = createDefaultListingSubmission();
  submission.rooms = rooms as typeof submission.rooms;
  return {
    id: PROPERTY_ID,
    status: "live",
    title: "Capacity House",
    address: "1 Capacity Way",
    managerUserId: "manager-1",
    listingSubmission: submission,
  };
}

describe("leasing SMS room capacity facts", () => {
  beforeEach(() => {
    __resetLeasingCatalogCache();
    __resetSmsOccupancyCache();
    vi.mocked(getPublicListings).mockReset();
    occupancy.load.mockReset();
  });

  it("returns resident capacity and physical beds as distinct public room facts", async () => {
    vi.mocked(getPublicListings).mockResolvedValue([listing([
      { id: "shared", name: "Shared Room", monthlyRent: 900, occupancyCapacity: 2, bedCount: 1 },
      { id: "private", name: "Private Room", monthlyRent: 1000, occupancyCapacity: 1, bedCount: 2 },
    ])]);
    occupancy.load.mockResolvedValue([]);

    const listed = await listLiveListingsTool.handler(context(), { query: "Capacity" });
    expect(listed.listings[0]?.rooms).toEqual([
      expect.objectContaining({ name: "Shared Room", residentCapacity: 2, physicalBeds: 1 }),
      expect.objectContaining({ name: "Private Room", residentCapacity: 1, physicalBeds: 2 }),
    ]);

    const details = await getListingDetailsTool.handler(context(), { propertyId: PROPERTY_ID });
    expect(details.listing).toMatchObject({ maximumResidents: 3 });
    expect(details.listing?.rooms).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Shared Room", residentCapacity: 2, physicalBeds: 1 }),
    ]));
  });

  it("normalizes unreadable capacity to one without inventing physical beds", async () => {
    vi.mocked(getPublicListings).mockResolvedValue([listing([
      { id: "legacy", name: "Legacy Room", monthlyRent: 800, occupancyCapacity: "not-a-number", bedCount: "not-a-number" },
      { id: "missing", name: "Missing Capacity", monthlyRent: 850 },
    ])]);
    occupancy.load.mockResolvedValue([]);

    const details = await getListingDetailsTool.handler(context(), { propertyId: PROPERTY_ID });
    expect(details.listing).toMatchObject({ maximumResidents: 2 });
    expect(details.listing?.rooms).toEqual([
      expect.objectContaining({ name: "Legacy Room", residentCapacity: 1, physicalBeds: null }),
      expect.objectContaining({ name: "Missing Capacity", residentCapacity: 1, physicalBeds: null }),
    ]);
  });

  it("keeps the listing total while filtering returned rooms", async () => {
    vi.mocked(getPublicListings).mockResolvedValue([listing([
      { id: "shared", name: "Shared Room", monthlyRent: 900, occupancyCapacity: 2 },
      { id: "private", name: "Private Room", monthlyRent: 1000, occupancyCapacity: 1 },
    ])]);
    occupancy.load.mockResolvedValue([]);

    const details = await getListingDetailsTool.handler(context(), {
      propertyId: PROPERTY_ID,
      roomQuery: "Shared",
    });

    expect(details.listing).toMatchObject({ allRoomCount: 2, maximumResidents: 3 });
    expect(details.listing?.rooms).toEqual([
      expect.objectContaining({ name: "Shared Room", residentCapacity: 2 }),
    ]);
  });

  it("returns an unknown total when a stored room is omitted from the public room summary", async () => {
    vi.mocked(getPublicListings).mockResolvedValue([listing([
      { id: "shared", name: "Shared Room", monthlyRent: 900, occupancyCapacity: 2 },
      { id: "hidden", name: "", monthlyRent: 0, occupancyCapacity: 3 },
    ])]);
    occupancy.load.mockResolvedValue([]);

    const details = await getListingDetailsTool.handler(context(), { propertyId: PROPERTY_ID });

    expect(details.listing).toMatchObject({ allRoomCount: 1, maximumResidents: null });
    expect(details.listing?.rooms).toEqual([
      expect.objectContaining({ name: "Shared Room", residentCapacity: 2 }),
    ]);
  });

  it("keeps capacity published but current availability unknown when occupancy fails", async () => {
    vi.mocked(getPublicListings).mockResolvedValue([listing([
      { id: "shared", name: "Shared Room", monthlyRent: 900, occupancyCapacity: 2, bedCount: 2, availability: "Available now" },
    ])]);
    occupancy.load.mockRejectedValueOnce(new Error("occupancy unavailable"));

    const details = await getListingDetailsTool.handler(context(), { propertyId: PROPERTY_ID });
    expect(details.listing?.rooms).toEqual([
      expect.objectContaining({
        name: "Shared Room",
        residentCapacity: 2,
        physicalBeds: 2,
        publishedAvailability: "Available now",
        currentAvailability: null,
        currentAvailabilityVerified: false,
      }),
    ]);
  });
});
