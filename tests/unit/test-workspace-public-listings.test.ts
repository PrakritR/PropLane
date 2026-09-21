import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));
vi.mock("@/lib/server-env", () => ({ isProductionRuntime: () => false }));

import { getPublicListings } from "@/lib/public-listings.server";

function listingDb() {
  const calls: Array<[string, string, unknown]> = [];
  const allRows = [
    { id: "live-public", manager_user_id: "manager-a", status: "live", test_workspace_id: null, property_data: { title: "Public Home", buildingName: "Public Home", address: "1 Main St", adminPublishLive: true } },
    { id: "live-test", manager_user_id: "manager-a", status: "live", test_workspace_id: "workspace-a", property_data: { title: "Private Test Home", buildingName: "Private Test Home", address: "2 Main St", adminPublishLive: true } },
  ];
  const db = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = (key: string, value: unknown) => { filters.push([key, value]); calls.push([table, key, value]); return query; };
      query.is = (key: string, value: unknown) => { filters.push([key, value]); calls.push([table, key, value]); return query; };
      query.order = () => query;
      query.limit = () => query;
      query.in = () => query;
      query.then = (resolve: (value: unknown) => unknown) => {
        if (table === "profiles") return Promise.resolve(resolve({ data: [{ id: "manager-a", email: "manager@example.com", phone: null, phone_verified_at: null, sms_from_number: null }], error: null }));
        const data = allRows.filter((row) => filters.every(([key, value]) => (row as Record<string, unknown>)[key] === value));
        return Promise.resolve(resolve({ data, error: null }));
      };
      return query;
    },
  };
  return { db, calls };
}

beforeEach(() => vi.clearAllMocks());

describe("public listing workspace exclusion", () => {
  it("excludes classified workspace listings from the service-role public catalog", async () => {
    const { db, calls } = listingDb();
    serviceDb.mockReturnValue(db);
    const listings = await getPublicListings();

    expect(calls).toContainEqual(["manager_property_records", "test_workspace_id", null]);
    expect(listings.map((listing) => listing.address)).toEqual(["1 Main St"]);
    expect(listings.some((listing) => listing.address === "2 Main St")).toBe(false);
  });

  it("returns only the active workspace catalog when a private scope is supplied", async () => {
    const { db, calls } = listingDb();
    serviceDb.mockReturnValue(db);
    const listings = await getPublicListings({ testWorkspaceId: "workspace-a" });

    expect(calls).toContainEqual(["manager_property_records", "test_workspace_id", "workspace-a"]);
    expect(listings.map((listing) => listing.address)).toEqual(["2 Main St"]);
  });
});
