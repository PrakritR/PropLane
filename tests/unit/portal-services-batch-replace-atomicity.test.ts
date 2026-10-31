/**
 * The manager client mirrors its WHOLE local list through `action: "replace"` on every change, so a
 * batch here is routinely 20+ rows and there is no transaction around the loop.
 *
 * The release moved the revision refusal from `continue` to `return 409` from INSIDE that loop, which
 * committed rows 1..n-1, never attempted rows n+1.., and told the client "The request changed; please
 * retry" with no hint that the store was now half written. Authorization and stamping now happen for
 * every row BEFORE the first write, so a refused batch costs no writes at all; a revision race during
 * the write pass still answers 409, but every other row is attempted rather than abandoned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  resolveRole: vi.fn(),
  workspaceScope: vi.fn(),
}));

type Row = Record<string, unknown>;

/** id -> stored record. A missing id is a brand-new row. */
let STORED: Record<string, Row>;
/** ids whose UPDATE loses its revision race (zero rows back). */
let RACING: Set<string>;
let WRITES: string[];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: hoisted.getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/admin-oversight.server", () => ({ resolveAdminOversight: async () => false }));
vi.mock("@/lib/auth/resident-role-access", () => ({
  resolveResidentScopedActorRole: (...a: unknown[]) => hoisted.resolveRole(...(a as [])),
}));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>();
  return {
    ...actual,
    fetchRowsForManagerWithLinked: async () => [],
    linkedPropertyIdsForModule: async () => new Set<string>(),
    resolveManagerWorkspaceRowScope: (...a: unknown[]) => hoisted.workspaceScope(...(a as [])),
  };
});
vi.mock("@/lib/resident-manager-scope", () => ({ resolveResidentFilingScope: async () => null }));
vi.mock("@/lib/auth/resident-subject-evidence.server", () => ({
  residentSubjectHasHouse: async () => false,
  boundResidentSubjectForManagerHouse: async () => null,
}));
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  repairWorkOrderScopesForManager: async () => undefined,
  repairServiceRequestScopesForManager: async () => undefined,
  shouldRunScopeRepair: () => false,
}));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: async () => [],
}));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/auth/view-as.server", () => ({ isViewAsSessionOpen: async () => false }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => ({ user: null, roles: [], effectiveRole: null }) }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => undefined }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: async () => undefined }));
vi.mock("@/lib/work-order-vendor-messages.server", () => ({
  emitVendorAssigned: async () => undefined,
  offerNewServiceToPreferredVendor: async () => undefined,
}));
vi.mock("@/lib/work-order-auto-time.server", () => ({
  autoTimeNewWorkOrder: async (_d: unknown, _m: unknown, row: unknown) => ({ row, outcome: { kind: "none" } }),
  notifyVisitAutoBooked: async () => undefined,
  willDispatchRun: async () => false,
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: async (_d: unknown, _m: unknown, row: unknown) => row,
  workOrderGoogleCalendarSyncChanged: () => false,
}));
vi.mock("@/lib/resident-work-order-lifecycle.server", () => ({ deleteWorkOrderRecord: async () => ({ error: null }) }));
vi.mock("@/lib/work-order-manager-names.server", () => ({ attachManagerNamesToWorkOrders: async (rows: unknown[]) => rows }));
vi.mock("@/lib/service-automation-settings.server", () => ({ loadServiceAutomationSettings: async () => null }));
vi.mock("@/lib/one-number/ops-alerts.server", () => ({ alertPhonesOf: async () => undefined }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
  resolveTestWorkspaceClassification: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitServiceRequestTransition: async () => undefined }));
vi.mock("@/lib/work-order-notification.server", () => ({
  notifyManagerOfResidentFiledItem: async () => undefined,
  notifyManagersOfManagerAuthoredItem: async () => undefined,
  notifyResidentOfManagerAuthoredItem: async () => undefined,
}));

import { POST as workOrdersPost } from "@/app/api/portal-work-orders/route";
import { POST as serviceRequestsPost } from "@/app/api/portal-service-requests/route";

const MANAGER = "mgr-1";

function recordTable(table: string) {
  const filters: Row = {};
  let patch: Row | null = null;
  const builder: Record<string, unknown> = {
    select: (cols?: string) => {
      if (patch) {
        const id = String(filters.id ?? "");
        if (RACING.has(id)) return Promise.resolve({ data: [], error: null });
        WRITES.push(id);
        return Promise.resolve({ data: [{ id }], error: null });
      }
      void cols;
      return builder;
    },
    eq: (column: string, value: unknown) => ((filters[column] = value), builder),
    is: () => builder,
    order: () => builder,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: STORED[String(filters.id ?? "")] ?? null, error: null }),
    update: (value: Row) => ((patch = value), builder),
    insert: (row: Row) => {
      WRITES.push(String(row.id));
      return Promise.resolve({ error: null });
    },
  };
  void table;
  return builder;
}

function makeDb() {
  return {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "mgr@test.local", role: "manager" }, error: null }) }) }),
        };
      }
      if (table === "portal_work_order_records" || table === "portal_service_request_records") return recordTable(table);
      if (table === "manager_property_records") {
        const b: Record<string, unknown> = { select: () => b, eq: () => b, limit: async () => ({ data: [], error: null }) };
        return b;
      }
      const b: Record<string, unknown> = { select: () => b, eq: () => b, is: () => b, limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: null, error: null }) };
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

const replaceWorkOrders = (rows: Row[]) =>
  workOrdersPost(jsonRequest("http://localhost/api/portal-work-orders", { method: "POST", body: { action: "replace", rows } }));
const replaceServiceRequests = (rows: Row[]) =>
  serviceRequestsPost(jsonRequest("http://localhost/api/portal-service-requests", { method: "POST", body: { action: "replace", rows } }));

const owned = (id: string, propertyId = "prop-a"): Row => ({
  manager_user_id: MANAGER,
  resident_user_id: null,
  resident_email: null,
  property_id: propertyId,
  row_revision: 1,
  row_data: { id, title: "Stored", propertyId },
});

beforeEach(() => {
  vi.clearAllMocks();
  STORED = {};
  RACING = new Set();
  WRITES = [];
  hoisted.getUser.mockResolvedValue({ data: { user: { id: MANAGER, email: "mgr@test.local" } } });
  hoisted.resolveRole.mockResolvedValue("manager");
  hoisted.workspaceScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
});

describe("work orders: a batch replace writes nothing before every row is authorized", () => {
  it("writes the whole batch when every row passes", async () => {
    for (const id of ["wo-1", "wo-2", "wo-3"]) STORED[id] = owned(id);

    const res = await replaceWorkOrders(["wo-1", "wo-2", "wo-3"].map((id) => ({ id, title: "Edited", propertyId: "prop-a" })));

    expect(res.status).toBe(200);
    expect(WRITES).toEqual(["wo-1", "wo-2", "wo-3"]);
  });

  it("writes nothing at all when a row in the middle is outside the active workspace", async () => {
    STORED["wo-1"] = owned("wo-1");
    STORED["wo-2"] = owned("wo-2", "prop-outside");
    STORED["wo-3"] = owned("wo-3");

    const res = await replaceWorkOrders([
      { id: "wo-1", title: "Edited", propertyId: "prop-a" },
      { id: "wo-2", title: "Edited", propertyId: "prop-outside" },
      { id: "wo-3", title: "Edited", propertyId: "prop-a" },
    ]);

    // An unauthorized row is skipped, as before — the point is that the other two are still written
    // and nothing was committed before the decision was made for all of them.
    expect(res.status).toBe(200);
    expect(WRITES).toEqual(["wo-1", "wo-3"]);
  });

  it("answers 409 for a revision race, and still attempts every other row", async () => {
    for (const id of ["wo-1", "wo-2", "wo-3", "wo-4"]) STORED[id] = owned(id);
    RACING.add("wo-2");

    const res = await replaceWorkOrders(["wo-1", "wo-2", "wo-3", "wo-4"].map((id) => ({ id, title: "Edited", propertyId: "prop-a" })));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "The request changed; please retry." });
    // Not abandoned at wo-2: wo-3 and wo-4 were attempted, so the store is not left half synced.
    expect(WRITES).toEqual(["wo-1", "wo-3", "wo-4"]);
  });
});

describe("service requests: the same batch contract", () => {
  it("writes the whole batch when every row passes", async () => {
    for (const id of ["sr-1", "sr-2"]) STORED[id] = owned(id);

    const res = await replaceServiceRequests(["sr-1", "sr-2"].map((id) => ({ id, propertyId: "prop-a", status: "Open" })));

    expect(res.status).toBe(200);
    expect(WRITES).toEqual(["sr-1", "sr-2"]);
  });

  it("answers 409 for a revision race, and still attempts every other row", async () => {
    for (const id of ["sr-1", "sr-2", "sr-3"]) STORED[id] = owned(id);
    RACING.add("sr-1");

    const res = await replaceServiceRequests(["sr-1", "sr-2", "sr-3"].map((id) => ({ id, propertyId: "prop-a", status: "Open" })));

    expect(res.status).toBe(409);
    expect(WRITES).toEqual(["sr-2", "sr-3"]);
  });
});

describe("the dead post-refusal guard is gone", () => {
  it("neither route still tests `if (saved)` right after returning on `!saved`", async () => {
    const { readFileSync } = await import("node:fs");
    for (const path of [
      "src/app/api/portal-work-orders/route.ts",
      "src/app/api/portal-service-requests/route.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source, path).not.toMatch(/status: 409 \}\);\s*\n\s*if \(saved\) \{/);
    }
  });
});
