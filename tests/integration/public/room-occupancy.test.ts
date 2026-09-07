import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/public-listings.server", () => ({
  getPublicListings: vi.fn(),
}));

import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import { GET as roomOccupancy } from "@/app/api/public/approved-room-occupancy/route";

const LISTING = {
  id: "p1",
  managerUserId: "mgr-1",
  listingSubmission: { v: 1, rooms: [{ id: "r1", name: "Room A" }] },
};

const APPROVED_APPLICATION = {
  id: "app-1",
  occupancy_start: null,
  manager_user_id: "mgr-1",
  property_id: "p1",
  assigned_property_id: "p1",
  assigned: "p1",
  property: "p1",
  application_property: "p1",
  withdrawn: null,
  manually_added: false,
  choice: "p1::r1",
  preferred: "p1::r1",
  manual_room: "Room A",
  manual_start: "2026-06-01",
  manual_end: "2026-08-31",
  lease_start: "2026-06-01",
  lease_end: "2026-08-31",
};

const EXECUTED_LEASE = {
  manager_user_id: "mgr-1",
  row_data: {
    id: "lease_app-1",
    residentName: "Resident",
    residentEmail: "resident@test.com",
    unit: "A",
    updated: "2026-01-01",
    bucket: "signed",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-01-01T00:00:00Z",
    axisId: "app-1",
    fullySignedAt: "2026-01-01T00:00:00Z",
    status: "Fully Signed",
    thread: [],
    managerSignature: { role: "manager", name: "Manager", signedAtIso: "2026-01-01" },
    residentSignature: { role: "resident", name: "Resident", signedAtIso: "2026-01-01" },
  },
};

/** `manager_property_records` resolves on `.in()`; applications and leases on `.range()`. */
function fakeDb(opts: { properties: unknown[]; applications: unknown[]; leases?: unknown[] }) {
  const chain = (terminal: string, value: unknown) => {
    const node: Record<string, unknown> = {};
    for (const key of ["select", "eq", "in", "order", "range"]) {
      node[key] = () => (key === terminal ? Promise.resolve({ data: value, error: null }) : node);
    }
    return node;
  };
  return {
    from: (table: string) => {
      if (table === "manager_property_records") return chain("in", opts.properties);
      if (table === "portal_lease_pipeline_records") return chain("range", opts.leases ?? []);
      return chain("range", opts.applications);
    },
  } as never;
}

describe("GET /api/public/approved-room-occupancy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPublicListings).mockResolvedValue([LISTING] as never);
  });

  it("returns aggregate capacity spans and no applicant identity", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      fakeDb({
        properties: [{ id: "p1", manager_user_id: "mgr-1" }],
        applications: [APPROVED_APPLICATION],
        leases: [EXECUTED_LEASE],
      }),
    );

    const res = await roomOccupancy();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.rooms).toEqual([
      { roomChoice: "p1::r1", spans: [{ start: "2026-06-01", end: "2026-08-31", count: 1 }] },
    ]);
    expect(JSON.stringify(data)).not.toContain("app-1");
    expect(JSON.stringify(data)).not.toContain("mgr-1");
  });

  it("ignores approved applications whose lease is not fully executed", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      fakeDb({
        properties: [{ id: "p1", manager_user_id: "mgr-1" }],
        applications: [APPROVED_APPLICATION],
        leases: [],
      }),
    );

    const res = await roomOccupancy();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.rooms).toEqual([{ roomChoice: "p1::r1", spans: [] }]);
  });

  it("counts manager-added residents without a signed lease", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      fakeDb({
        properties: [{ id: "p1", manager_user_id: "mgr-1" }],
        applications: [{ ...APPROVED_APPLICATION, manually_added: true }],
        leases: [],
      }),
    );

    const res = await roomOccupancy();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.rooms).toEqual([
      { roomChoice: "p1::r1", spans: [{ start: "2026-06-01", end: "2026-08-31", count: 1 }] },
    ]);
  });

  /**
   * The owner scope is the `manager_user_id` COLUMN, not the manager-mirrored
   * `property_data` blob: a planted owner there must not aim this unauthenticated
   * endpoint's scan at another manager's applications.
   */
  it("scopes on the stored owner column, not the listing blob's managerUserId", async () => {
    vi.mocked(getPublicListings).mockResolvedValue([{ ...LISTING, managerUserId: "planted" }] as never);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      fakeDb({
        properties: [{ id: "p1", manager_user_id: "mgr-1" }],
        applications: [APPROVED_APPLICATION],
        leases: [EXECUTED_LEASE],
      }),
    );

    const res = await roomOccupancy();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.rooms).toEqual([
      { roomChoice: "p1::r1", spans: [{ start: "2026-06-01", end: "2026-08-31", count: 1 }] },
    ]);
  });

  it("reports an empty room rather than counting a placement owned by someone else", async () => {
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(
      fakeDb({
        properties: [{ id: "p1", manager_user_id: "mgr-1" }],
        applications: [{ ...APPROVED_APPLICATION, manager_user_id: "other-manager" }],
        leases: [EXECUTED_LEASE],
      }),
    );

    const res = await roomOccupancy();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.rooms).toEqual([{ roomChoice: "p1::r1", spans: [] }]);
  });
});
