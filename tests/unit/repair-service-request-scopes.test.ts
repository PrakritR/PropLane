import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/resident-manager-scope", async () => {
  const actual = await vi.importActual<typeof import("@/lib/resident-manager-scope")>(
    "@/lib/resident-manager-scope",
  );
  return {
    ...actual,
    residentHasApprovedResidency: vi.fn(),
  };
});

import { residentHasApprovedResidency } from "@/lib/resident-manager-scope";
import { repairServiceRequestScopesForManager, repairWorkOrderScopesForManager } from "@/lib/repair-service-request-scopes.server";

type SrRec = {
  resident_user_id?: string;
  id: string;
  manager_user_id: string | null;
  resident_email: string;
  property_id: string | null;
  status: string;
  row_data: Record<string, unknown>;
};

function mockDb(
  apps: { resident_email: string; property_id: string; bucket?: string }[],
  srs: SrRec[],
  options: { transfer?: boolean } = {},
) {
  const upserts: unknown[] = [];
  const client = {
    from(table: string) {
      if (table === "manager_application_records") {
        return {
          select: () => ({
            eq: () => ({
              limit: async () => ({
                data: apps.map((a) => ({
                  resident_email: a.resident_email,
                  property_id: a.property_id,
                  assigned_property_id: null,
                  row_data: { bucket: a.bucket ?? "approved" },
                })),
                error: null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          in: () => ({
            limit: async () => ({ data: srs, error: null }),
          }),
        }),
        update: (rec: unknown) => {
          const filters: Array<[string, unknown]> = [];
          const q = { eq: (column: string, value: unknown) => { filters.push([column, value]); return q; }, is: () => q, select: async () => {
            if (options.transfer && filters.some(([column]) => column === "manager_user_id")) return { data: [], error: null };
            upserts.push(rec);
            return { data: [{ id: "updated" }], error: null };
          } };
          return q;
        },
      };
    },
  };
  return { client, upserts };
}

describe("repairServiceRequestScopesForManager", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not move another manager’s legacy row based on reused email", async () => {
    vi.mocked(residentHasApprovedResidency).mockImplementation(async (_db, params) => {
      return params.managerUserId === "mgr-demo";
    });
    const { client, upserts } = mockDb(
      [{ resident_email: "resident@test.proplane.local", property_id: "mgr-demo-pioneer", bucket: "approved" }],
      [
        {
          id: "SR-orphan",
          manager_user_id: "mgr-2",
          resident_email: "resident@test.proplane.local",
          property_id: "mgr-test-spruce",
          status: "pending",
          row_data: {
            id: "SR-orphan",
            offerName: "Reserved parking spot",
            offerId: "parking",
            residentEmail: "resident@test.proplane.local",
            managerUserId: "mgr-2",
            propertyId: "mgr-test-spruce",
          },
        },
      ],
    );

    const result = await repairServiceRequestScopesForManager(client as never, "mgr-demo");
    expect(result.repaired).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("never reassigns a subject-bound request from a reused email", async () => {
    const { client, upserts } = mockDb(
      [{ resident_email: "res@test.proplane.local", property_id: "new-property", bucket: "approved" }],
      [{ id: "SR-bound", resident_user_id: "old-subject", manager_user_id: "old-manager", resident_email: "res@test.proplane.local", property_id: "old-property", status: "pending", row_data: {} }],
    );
    expect((await repairServiceRequestScopesForManager(client as never, "new-manager")).repaired).toBe(0);
    expect(upserts).toHaveLength(0);
  });

  it("does not steal a request that belongs to another approved residency", async () => {
    vi.mocked(residentHasApprovedResidency).mockResolvedValue(true);
    const { client, upserts } = mockDb(
      [{ resident_email: "res@test.proplane.local", property_id: "pioneer-1", bucket: "approved" }],
      [
        {
          id: "SR-other",
          manager_user_id: "mgr-other",
          resident_email: "res@test.proplane.local",
          property_id: "other-prop",
          status: "pending",
          row_data: { id: "SR-other", managerUserId: "mgr-other", propertyId: "other-prop" },
        },
      ],
    );

    const result = await repairServiceRequestScopesForManager(client as never, "mgr-1");
    expect(result.repaired).toBe(0);
    expect(upserts).toHaveLength(0);
  });
});


it("does not reassign bound work orders for a reused email", async () => {
  const { client, upserts } = mockDb(
    [{ resident_email: "res@test.proplane.local", property_id: "new-property", bucket: "approved" }],
    [{ id: "WO-bound", resident_user_id: "old-subject", manager_user_id: "old-manager", resident_email: "res@test.proplane.local", property_id: "old-property", status: "open", row_data: {} }],
  );
  expect((await repairWorkOrderScopesForManager(client as never, "new-manager")).repaired).toBe(0);
  expect(upserts).toHaveLength(0);
});


it("does not overwrite a row transferred after the repair read", async () => {
  const { client, upserts } = mockDb(
    [{ resident_email: "res@test.proplane.local", property_id: "house", bucket: "approved" }],
    [{ id: "SR-transfer", manager_user_id: "mgr-1", resident_email: "res@test.proplane.local", property_id: null, status: "pending", row_data: {} }],
    { transfer: true },
  );
  expect((await repairServiceRequestScopesForManager(client as never, "mgr-1")).repaired).toBe(0);
  expect(upserts).toHaveLength(0);
});
