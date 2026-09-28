import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  db: {}, listings: vi.fn(), load: vi.fn(), rate: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => mocks.db }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.listings }));
vi.mock("@/lib/public-room-occupancy.server", () => ({ loadPublicRoomOccupancy: mocks.load }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test-ip", rateLimit: mocks.rate }));
import { GET } from "@/app/api/public/approved-room-occupancy/route";
const request = (query: string) => new NextRequest(`http://localhost/api/public/approved-room-occupancy${query}`);
describe("public occupancy refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listings.mockResolvedValue([{ id: "home" }, { id: "other" }]);
    mocks.load.mockResolvedValue([]);
    mocks.rate.mockResolvedValue({ ok: true });
  });
  it("scopes an uncached fresh read to the selected public listing", async () => {
    const res = await GET(request("?fresh=1&propertyId=home"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.load).toHaveBeenCalledWith(mocks.db, [{ id: "home" }]);
    expect(mocks.rate).toHaveBeenCalledWith("room-availability:test-ip", 10, 60_000);
  });
  it("rejects unscoped or private-listing fresh reads", async () => {
    expect((await GET(request("?fresh=1"))).status).toBe(400);
    expect((await GET(request("?fresh=1&propertyId=private"))).status).toBe(404);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("stops rate-limited requests before querying", async () => {
    mocks.rate.mockResolvedValue({ ok: false });
    expect((await GET(request("?fresh=1&propertyId=home"))).status).toBe(429);
    expect(mocks.listings).not.toHaveBeenCalled();
  });
  it("retains CDN caching for the background snapshot", async () => {
    const res = await GET(request(""));
    expect(res.headers.get("cache-control")).toContain("s-maxage=60");
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith(mocks.db, [{ id: "home" }, { id: "other" }]);
  });
  it("fails closed if availability cannot be loaded", async () => {
    mocks.load.mockRejectedValue(new Error("database unavailable"));
    expect((await GET(request("?fresh=1&propertyId=home"))).status).toBe(503);
  });
});
