// The live availability check (`/api/public/approved-room-occupancy?fresh=1`) answers `no-store` about ONE house, so
// AGENTS.md § Performance & egress forbids serving it from the shared catalog snapshot ("Never for anything scoped to
// a viewer, a workspace, or a `fresh=1` read"). It stays cheap by asking the loader for that one listing instead — the
// scoping tested here, over the real loader with the database rows mocked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceDb = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));
vi.mock("@/lib/server-env", () => ({ isProductionRuntime: () => false }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveActiveManagerSendNumber: async () => null }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveActiveManagerWorkEmail: async () => null }));

import { getPublicListings } from "@/lib/public-listings.server";

const row = (id: string, street: string) => ({
  id,
  manager_user_id: `mgr-${id}`,
  workspace_id: `ws-${id}`,
  status: "live",
  test_workspace_id: null,
  property_data: { title: street, buildingName: street, address: street, adminPublishLive: true },
});

const ROWS = [row("h1", "4709A 8th Ave"), row("h2", "12 Ravenna Pl"), row("h3", "9 Pine St")];

let filters: [string, unknown][];
let propertyReads: number;

function fakeDb() {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "is", "in", "order", "limit"]) q[m] = () => q;
      q.eq = (column: string, value: unknown) => {
        if (table === "manager_property_records") filters.push([column, value]);
        return q;
      };
      q.then = (resolve: (v: unknown) => unknown) => {
        if (table !== "manager_property_records") return Promise.resolve(resolve({ data: [], error: null }));
        propertyReads += 1;
        const wanted = filters.find(([column]) => column === "id")?.[1];
        return Promise.resolve(resolve({ data: wanted ? ROWS.filter((r) => r.id === wanted) : ROWS, error: null }));
      };
      return q;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  filters = [];
  propertyReads = 0;
  serviceDb.mockReturnValue(fakeDb());
});

describe("getPublicListings({ propertyId })", () => {
  it("asks the database for that one listing, and returns only it", async () => {
    const listings = await getPublicListings({ liveAvailability: false, propertyId: "h2" });
    expect(listings.map((l) => l.id)).toEqual(["h2"]);
    expect(filters).toContainEqual(["id", "h2"]);
  });

  it("still builds the whole catalog when no listing is named", async () => {
    const listings = await getPublicListings({ liveAvailability: false });
    expect(listings.map((l) => l.id).sort()).toEqual(["h1", "h2", "h3"]);
    expect(filters.some(([column]) => column === "id")).toBe(false);
  });

  it("names no listing at all rather than the whole catalog when the id is blank", async () => {
    expect(await getPublicListings({ liveAvailability: false, propertyId: "  " })).toEqual([]);
    expect(propertyReads).toBe(0);
  });
});
