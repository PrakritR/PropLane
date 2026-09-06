import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn().mockResolvedValue(false) }));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { POST } from "@/app/api/portal-service-requests/route";

type Rec = {
  id: string;
  manager_user_id: string | null;
  resident_email: string | null;
  property_id?: string | null;
  row_data: unknown;
};
type AppRec = {
  id: string;
  manager_user_id: string;
  resident_email: string;
  property_id?: string | null;
  assigned_property_id?: string | null;
};

/**
 * In-memory stand-in for the service-role client, seeded with one request owned
 * by manager "mgr-a" / resident "res@a.com". Captures upserts and deletes so the
 * ownership-gating behavior can be asserted. `appSeed` seeds the
 * `manager_application_records` table that backs resident filing scope.
 */
function mockDb(seed: Rec[], profile: { email: string; role: string }, appSeed: AppRec[] = []) {
  const store = new Map(seed.map((r) => [r.id, r]));
  const upserts: Rec[] = [];
  const deletes: string[] = [];
  const client = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: profile }),
        };
      }
      if (table === "manager_application_records") {
        const filters: Record<string, string> = {};
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (col: string, val: string) => {
            filters[col] = val;
            return builder;
          },
          order: () => builder,
          limit: async () => {
            const rows = appSeed.filter((a) => {
              if (filters.manager_user_id && a.manager_user_id !== filters.manager_user_id) return false;
              if (filters.resident_email && a.resident_email !== filters.resident_email) return false;
              return true;
            });
            return {
              data: rows.map((a) => ({
                id: a.id,
                manager_user_id: a.manager_user_id,
                property_id: a.property_id ?? null,
                assigned_property_id: a.assigned_property_id ?? null,
                row_data: {},
                updated_at: new Date().toISOString(),
              })),
              error: null,
            };
          },
          maybeSingle: async () => {
            const rows = appSeed.filter((a) => {
              if (filters.manager_user_id && a.manager_user_id !== filters.manager_user_id) return false;
              if (filters.resident_email && a.resident_email !== filters.resident_email) return false;
              return true;
            });
            const a = rows[0];
            return {
              data: a
                ? {
                    id: a.id,
                    manager_user_id: a.manager_user_id,
                    property_id: a.property_id ?? null,
                    assigned_property_id: a.assigned_property_id ?? null,
                    row_data: {},
                    updated_at: new Date().toISOString(),
                  }
                : null,
              error: null,
            };
          },
        };
        return builder;
      }
      if (table !== "portal_service_request_records") {
        // Every OTHER table this route touches on its way out — the
        // `action_events` write behind the transition notification, for one.
        // Falling those through to the branch below recorded them in `upserts`,
        // which quietly turned an ownership assertion into a write-COUNT
        // assertion: the first legitimate new side effect made
        // `expect(upserts).toHaveLength(1)` fail and the two assertions that
        // actually check the stamped owner never ran at all.
        const other: Record<string, unknown> = {
          select: () => other,
          insert: async () => ({ data: null, error: null }),
          upsert: async () => ({ data: null, error: null }),
          update: () => other,
          delete: () => other,
          eq: () => other,
          in: () => other,
          order: () => other,
          limit: async () => ({ data: [], error: null }),
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: null, error: null }),
        };
        return other;
      }
      // portal_service_request_records
      return {
        select() {
          return {
            eq(_col: string, id: string) {
              return { maybeSingle: async () => ({ data: store.get(id) ?? null, error: null }) };
            },
          };
        },
        upsert: async (rec: Rec) => {
          upserts.push(rec);
          store.set(rec.id, rec);
          return { error: null };
        },
        delete() {
          return {
            eq: async (_col: string, id: string) => {
              deletes.push(id);
              store.delete(id);
              return { error: null };
            },
          };
        },
      };
    },
  };
  return { client, upserts, deletes };
}

function asUser(id: string, email: string) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id, email, user_metadata: {} } } }) },
  } as never);
}

const SEED: Rec[] = [
  { id: "SR-1", manager_user_id: "mgr-a", resident_email: "res@a.com", row_data: { id: "SR-1" } },
];

describe("/api/portal-service-requests POST ownership gating", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects deletion of a request the caller does not own (IDOR)", async () => {
    asUser("attacker", "evil@x.com");
    const { client, deletes } = mockDb(SEED, { email: "evil@x.com", role: "resident" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(jsonRequest("http://t/api/portal-service-requests", { method: "POST", body: { action: "delete", id: "SR-1" } }));
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(403);
    expect(deletes).toHaveLength(0);
  });

  it("allows the owning manager to delete their own request", async () => {
    asUser("mgr-a", "a@test.com");
    const { client, deletes } = mockDb(SEED, { email: "a@test.com", role: "manager" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(jsonRequest("http://t/api/portal-service-requests", { method: "POST", body: { action: "delete", id: "SR-1" } }));
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(200);
    expect(deletes).toEqual(["SR-1"]);
  });

  it("pins resident_email to the session on a resident upsert (no spoofing)", async () => {
    asUser("res-b", "res@b.com");
    const { client, upserts } = mockDb([], { email: "res@b.com", role: "resident" }, [
      { id: "APP-1", manager_user_id: "mgr-a", resident_email: "res@b.com", property_id: "prop-1" },
    ]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t/api/portal-service-requests", {
        method: "POST",
        body: {
          row: {
            id: "SR-9",
            residentEmail: "victim@x.com",
            managerUserId: "mgr-a",
            propertyId: "prop-1",
            status: "pending",
          },
        },
      }),
    );
    const { status, data } = await parseJsonResponse<{ row?: { managerUserId?: string; propertyId?: string } }>(res);
    expect(status).toBe(200);
    expect(upserts[0]!.resident_email).toBe("res@b.com");
    expect(upserts[0]!.manager_user_id).toBe("mgr-a");
    expect(data.row?.managerUserId).toBe("mgr-a");
  });

  it("ignores a claimed manager the resident does not belong to and stamps their real residency", async () => {
    asUser("res-b", "res@b.com");
    // res@b.com belongs to mgr-b only; they try to claim mgr-a.
    const { client, upserts } = mockDb([], { email: "res@b.com", role: "resident" }, [
      { id: "APP-1", manager_user_id: "mgr-b", resident_email: "res@b.com", property_id: "prop-b" },
    ]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t/api/portal-service-requests", {
        method: "POST",
        body: {
          row: {
            id: "SR-evil",
            residentEmail: "res@b.com",
            managerUserId: "mgr-a",
            propertyId: "prop-a",
            status: "pending",
            offerName: "Parking",
          },
        },
      }),
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(200);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.manager_user_id).toBe("mgr-b");
    expect(upserts[0]!.property_id).toBe("prop-b");
  });

  it("pins manager_user_id to the session on a manager upsert (no spoofing)", async () => {
    asUser("mgr-real", "m@real.com");
    const { client, upserts } = mockDb([], { email: "m@real.com", role: "manager" });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t/api/portal-service-requests", {
        method: "POST",
        body: { row: { id: "SR-10", managerUserId: "mgr-victim", residentEmail: "r@x.com", status: "approved" } },
      }),
    );
    const { status, data } = await parseJsonResponse<{ row?: { managerUserId?: string } }>(res);
    expect(status).toBe(200);
    expect(upserts[0]!.manager_user_id).toBe("mgr-real");
    expect((upserts[0]!.row_data as { managerUserId?: string }).managerUserId).toBe("mgr-real");
    expect(data.row?.managerUserId).toBe("mgr-real");
  });

  it("stamps property_id from residency when resident omits a property", async () => {
    asUser("res-b", "res@b.com");
    const { client, upserts } = mockDb([], { email: "res@b.com", role: "resident" }, [
      {
        id: "APP-1",
        manager_user_id: "mgr-a",
        resident_email: "res@b.com",
        assigned_property_id: "pioneer-1",
      },
    ]);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(client as never);

    const res = await POST(
      jsonRequest("http://t/api/portal-service-requests", {
        method: "POST",
        body: {
          row: {
            id: "SR-prop",
            residentEmail: "res@b.com",
            managerUserId: "mgr-a",
            propertyId: "",
            status: "pending",
            offerName: "Parking",
          },
        },
      }),
    );
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(200);
    expect(upserts[0]!.manager_user_id).toBe("mgr-a");
    expect(upserts[0]!.property_id).toBe("pioneer-1");
  });
});
