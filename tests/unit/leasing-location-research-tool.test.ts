import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ research: vi.fn(), publicListings: vi.fn() }));
vi.mock("@/lib/property-location-research.server", () => ({ researchPropertyLocation: mocks.research }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.publicListings }));

import { leasingSmsAgentRegistry } from "@/lib/tools";
import { __resetLeasingCatalogCache, getPropertyLocationResearchTool } from "@/lib/tools/domains/leasing-sms";

function ctx(crossCatalog: boolean) {
  const chain = { select: () => chain, eq: () => chain, in: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
  return { landlordId: "owner-a", leasingScope: { crossCatalog }, db: { from: () => chain } } as never;
}

describe("prospect property location research tool", () => {
  beforeEach(() => {
    __resetLeasingCatalogCache();
    vi.clearAllMocks();
    mocks.research.mockResolvedValue({ available: true, sources: [] });
    mocks.publicListings.mockResolvedValue([{
      id: "public-1",
      address: "1 Main St",
      city: "Oakland",
      state: "CA",
      zip: "94612",
      neighborhood: "Downtown",
      mapLat: 37.8,
      mapLng: -122.2,
      description: "public description",
      listingSubmission: { marketingNotes: "private search bait", managerEmail: "manager@example.com" },
    }]);
  });

  it("accepts only a listing id and a bounded public topic", () => {
    expect(getPropertyLocationResearchTool.inputSchema.safeParse({ propertyId: "p1", topic: "schools" }).success).toBe(true);
    expect(getPropertyLocationResearchTool.inputSchema.safeParse({ propertyId: "p1", topic: "transit_stops" }).success).toBe(true);
    expect(getPropertyLocationResearchTool.inputSchema.safeParse({ propertyId: "p1", topic: "search my query" }).success).toBe(false);
    expect(getPropertyLocationResearchTool.inputSchema.safeParse({ propertyId: "p1", topic: "parks", url: "https://example.com" }).success).toBe(false);
    expect(leasingSmsAgentRegistry.get("research_property_location")?.kind).toBe("read");
  });

  it("authorizes a listing before research and sends only public location facts", async () => {
    const result = await getPropertyLocationResearchTool.handler(ctx(true), { propertyId: "public-1", topic: "schools" });
    expect(result).toMatchObject({ found: true, available: true });
    expect(mocks.research).toHaveBeenCalledWith({
      scopeKey: "leasing:public-1",
      propertyId: "public-1",
      topic: "schools",
      location: {
        address: "1 Main St", neighborhood: "Downtown", city: "Oakland", state: "CA", zip: "94612", mapLat: 37.8, mapLng: -122.2,
      },
    });
    const serialized = JSON.stringify(mocks.research.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("private search bait");
    expect(serialized).not.toContain("manager@example.com");
  });

  it("does not search for a listing outside an owner-scoped line", async () => {
    await expect(getPropertyLocationResearchTool.handler(ctx(false), { propertyId: "public-1", topic: "parks" }))
      .resolves.toMatchObject({ found: false, error: "listing_not_found" });
    expect(mocks.publicListings).not.toHaveBeenCalled();
    expect(mocks.research).not.toHaveBeenCalled();
  });
});
