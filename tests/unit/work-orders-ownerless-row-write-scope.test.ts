/**
 * PRP-232. `actorOwnsRecord` used to end with
 *
 *   if (!rec.manager_user_id && actor.role !== "resident") return true;
 *
 * a DENYLIST, so a work order whose `manager_user_id` was never backfilled was
 * writable and deletable by every authenticated non-resident — every other
 * manager on the platform, and any account whose role failed to resolve to a
 * known string. Claiming a legacy row is now positive: only a manager who
 * holds the property the row itself names may write it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const { getUser, resolveResidentScopedActorRole, linkedPropertyIdsForModule } = vi.hoisted(() => ({
  getUser: vi.fn(),
  resolveResidentScopedActorRole: vi.fn(),
  linkedPropertyIdsForModule: vi.fn(),
}));

/** The single stored work order every test writes against. */
let STORED_ROW: Record<string, unknown> | null;
/** Property ids owned outright by the calling manager. */
let OWNED_PROPERTY_IDS: string[];
let UPSERTS: unknown[];
let DELETES: string[];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  fetchRowsForManagerWithLinked: async () => [],
  linkedPropertyIdsForModule: (...a: unknown[]) => linkedPropertyIdsForModule(...(a as [])),
}));
vi.mock("@/lib/auth/resident-role-access", () => ({
  resolveResidentScopedActorRole: (...a: unknown[]) => resolveResidentScopedActorRole(...(a as [])),
}));
vi.mock("@/lib/resident-manager-scope", () => ({ resolveResidentFilingScope: async () => null }));
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  repairWorkOrderScopesForManager: async () => undefined,
  shouldRunScopeRepair: () => false,
}));
vi.mock("@/lib/work-order-notification.server", () => ({
  notifyManagerOfResidentFiledItem: async () => undefined,
  notifyManagersOfManagerAuthoredItem: async () => undefined,
  notifyWorkOrderEvent: async () => undefined,
}));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: async () => undefined }));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: async (_d: unknown, _m: unknown, row: unknown) => row,
  workOrderGoogleCalendarSyncChanged: () => false,
}));

import { POST as workOrdersPost } from "@/app/api/portal-work-orders/route";

function makeDb() {
  return {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: async () => ({ data: { email: "caller@test.proplane.local", role: "manager" }, error: null }),
        };
      }
      if (table === "manager_property_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          limit: async () => ({ data: OWNED_PROPERTY_IDS.map((id) => ({ id })), error: null }),
        };
        return builder;
      }
      if (table === "portal_work_order_records") {
        const builder: Record<string, unknown> = {
          select: vi.fn(() => builder),
          eq: vi.fn(() => builder),
          maybeSingle: async () => ({ data: STORED_ROW, error: null }),
          upsert: vi.fn((row: unknown) => {
            UPSERTS.push(row);
            return Promise.resolve({ error: null });
          }),
          delete: vi.fn(() => ({
            eq: vi.fn((_c: string, id: string) => {
              DELETES.push(id);
              return Promise.resolve({ error: null });
            }),
          })),
        };
        return builder;
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: async () => ({ data: null }) };
    },
  };
}

/** An un-backfilled row: no `manager_user_id`, but it names a property. */
function ownerlessRowOnProperty(propertyId: string | null) {
  return {
    manager_user_id: null,
    resident_email: "tenant@test.proplane.local",
    row_data: {
      id: "wo-legacy",
      title: "Legacy leaking roof",
      ...(propertyId ? { propertyId } : {}),
    },
  };
}

function upsertLegacyRow() {
  return workOrdersPost(
    jsonRequest("http://localhost/api/portal-work-orders", {
      method: "POST",
      body: { row: { id: "wo-legacy", title: "Rewritten by the caller" } },
    }),
  );
}

describe("POST /api/portal-work-orders — ownerless legacy rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    UPSERTS = [];
    DELETES = [];
    OWNED_PROPERTY_IDS = [];
    STORED_ROW = ownerlessRowOnProperty("prop-victim");
    getUser.mockResolvedValue({ data: { user: { id: "mgr-outsider", email: "caller@test.proplane.local" } } });
    resolveResidentScopedActorRole.mockResolvedValue("manager");
    linkedPropertyIdsForModule.mockResolvedValue(new Set<string>());
  });

  it("refuses a manager who does not hold the property the row names", async () => {
    const res = await upsertLegacyRow();
    expect(res.status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("refuses an account whose role did not resolve to a known string", async () => {
    resolveResidentScopedActorRole.mockResolvedValue("");
    const res = await upsertLegacyRow();
    expect(res.status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("refuses a legacy row that names no property at all", async () => {
    STORED_ROW = ownerlessRowOnProperty(null);
    OWNED_PROPERTY_IDS = ["prop-victim"];
    const res = await upsertLegacyRow();
    expect(res.status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("refuses a DELETE from a manager who does not hold the property", async () => {
    const res = await workOrdersPost(
      jsonRequest("http://localhost/api/portal-work-orders", {
        method: "POST",
        body: { action: "delete", id: "wo-legacy" },
      }),
    );
    expect(res.status).toBe(403);
    expect(DELETES).toHaveLength(0);
  });

  it("skips, rather than writes, an unowned legacy row in a replace sync", async () => {
    const res = await workOrdersPost(
      jsonRequest("http://localhost/api/portal-work-orders", {
        method: "POST",
        body: { action: "replace", rows: [{ id: "wo-legacy", title: "Rewritten by the caller" }] },
      }),
    );
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(0);
  });

  it("allows the manager who owns the property the row names", async () => {
    OWNED_PROPERTY_IDS = ["prop-victim"];
    const res = await upsertLegacyRow();
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("allows a co-manager whose Services link covers the property", async () => {
    linkedPropertyIdsForModule.mockResolvedValue(new Set(["prop-victim"]));
    const res = await upsertLegacyRow();
    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });
});
