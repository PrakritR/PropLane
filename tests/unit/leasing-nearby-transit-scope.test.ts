import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ nearby: vi.fn(), publicListings: vi.fn() }));
vi.mock("@/lib/nearby-transit.server", () => ({ getNearbyTransit: mocks.nearby }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.publicListings }));

import { __resetLeasingCatalogCache, getNearbyTransitTool } from "@/lib/tools/domains/leasing-sms";

function ctx(crossCatalog: boolean) {
  const chain = { select: () => chain, eq: () => chain, in: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
  return { landlordId: "owner-a", leasingScope: { crossCatalog }, db: { from: () => chain } } as never;
}

describe("nearby transit listing scope", () => {
  beforeEach(() => {
    __resetLeasingCatalogCache(); vi.clearAllMocks();
    mocks.nearby.mockResolvedValue({ verified: true, stops: [] });
    mocks.publicListings.mockResolvedValue([{ id: "foreign-live", address: "1 Main", zip: "94102" }]);
  });

  it("does not look up an absent or foreign listing on an owner-scoped line", async () => {
    await expect(getNearbyTransitTool.handler(ctx(false), { propertyId: "foreign-live" }))
      .resolves.toEqual({ found: false, error: "listing_not_found" });
    expect(mocks.publicListings).not.toHaveBeenCalled();
    expect(mocks.nearby).not.toHaveBeenCalled();
  });

  it("resolves the same listing only through the authorized public cross-catalog", async () => {
    await expect(getNearbyTransitTool.handler(ctx(true), { propertyId: "foreign-live", mode: "bus" }))
      .resolves.toMatchObject({ found: true, verified: true });
    expect(mocks.publicListings).toHaveBeenCalledTimes(1);
    expect(mocks.nearby).toHaveBeenCalledWith(expect.objectContaining({ id: "foreign-live" }), "bus");
  });
});
