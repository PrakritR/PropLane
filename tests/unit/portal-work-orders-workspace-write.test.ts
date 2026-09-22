/**
 * Batch A — active-workspace scoping. `POST /api/portal-work-orders` must:
 *  - refuse to create a new work order under a property outside the active
 *    workspace ("a create must land in the active workspace"),
 *  - refuse an update/delete of an OWNED row whose house is outside it, and
 *  - leave the legacy "claimable, unassigned" bucket (`manager_user_id IS
 *    NULL`) UNSCOPED — it belongs to no workspace until claimed, matching the
 *    GET-side rule.
 *
 * Read scoping for this route's owned + co-manager branch is covered at the
 * shared-loader level in `manager-workspace-row-scope.test.ts`. `rowInWorkspaceScope`
 * is the REAL implementation here (only `resolveManagerWorkspaceRowScope` is
 * mocked, to control the active workspace without a full `loadWorkspaces` fixture).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const { getUser, resolveResidentScopedActorRole, linkedPropertyIdsForModule, resolveManagerWorkspaceRowScope } = vi.hoisted(
  () => ({
    getUser: vi.fn(),
    resolveResidentScopedActorRole: vi.fn(),
    linkedPropertyIdsForModule: vi.fn(),
    resolveManagerWorkspaceRowScope: vi.fn(),
  }),
);

let STORED_ROW: Record<string, unknown> | null;
let OWNED_PROPERTY_IDS: string[];
let UPSERTS: unknown[];
let DELETES: string[];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>();
  return {
    ...actual,
    fetchRowsForManagerWithLinked: async () => [],
    linkedPropertyIdsForModule: (...a: unknown[]) => linkedPropertyIdsForModule(...(a as [])),
    resolveManagerWorkspaceRowScope: (...a: unknown[]) => resolveManagerWorkspaceRowScope(...(a as [])),
  };
});
vi.mock("@/lib/auth/resident-role-access", () => ({
  resolveResidentScopedActorRole: (...a: unknown[]) => resolveResidentScopedActorRole(...(a as [])),
}));
vi.mock("@/lib/resident-manager-scope", () => ({ resolveResidentFilingScope: async () => null }));
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  repairWorkOrderScopesForManager: async () => undefined,
  shouldRunScopeRepair: () => false,
}));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({
  resolvePropertyScopedManagerRecipientIds: async () => [],
}));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: async () => undefined }));
vi.mock("@/lib/work-order-dispatch.server", () => ({ prepareDispatch: async () => undefined }));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncWorkOrderToGoogleCalendar: async (_d: unknown, _m: unknown, row: unknown) => row,
  workOrderGoogleCalendarSyncChanged: () => false,
}));
vi.mock("@/lib/resident-work-order-lifecycle.server", () => ({
  deleteWorkOrderRecord: async (_db: unknown, args: { id: string }) => {
    DELETES.push(args.id);
    return { error: null };
  },
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
        };
        return builder;
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), maybeSingle: async () => ({ data: null }) };
    },
  };
}

function postRow(row: Record<string, unknown>) {
  return workOrdersPost(jsonRequest("http://localhost/api/portal-work-orders", { method: "POST", body: { row } }));
}

function postDelete(id: string) {
  return workOrdersPost(jsonRequest("http://localhost/api/portal-work-orders", { method: "POST", body: { action: "delete", id } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  UPSERTS = [];
  DELETES = [];
  OWNED_PROPERTY_IDS = [];
  STORED_ROW = null;
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "caller@test.proplane.local" } } });
  resolveResidentScopedActorRole.mockResolvedValue("manager");
  linkedPropertyIdsForModule.mockResolvedValue(new Set<string>());
});

describe("create — a new work order must land in the active workspace", () => {
  it("refuses to create a work order under a property outside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });

    const res = await postRow({ id: "wo-new", title: "New leak", propertyId: "prop-outside" });

    expect(res.status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("creates a work order under a property inside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });

    const res = await postRow({ id: "wo-new", title: "New leak", propertyId: "prop-a" });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });
});

describe("update/delete of an OWNED row — refuses a house outside the active workspace", () => {
  it("refuses to edit an owned work order whose house is outside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    STORED_ROW = {
      manager_user_id: "mgr-1",
      resident_email: null,
      row_data: { id: "wo-1", title: "Old title", propertyId: "prop-outside" },
    };

    const res = await postRow({ id: "wo-1", title: "Edited by caller", propertyId: "prop-outside" });

    expect(res.status).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("allows editing an owned work order whose house is inside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    STORED_ROW = {
      manager_user_id: "mgr-1",
      resident_email: null,
      row_data: { id: "wo-1", title: "Old title", propertyId: "prop-a" },
    };

    const res = await postRow({ id: "wo-1", title: "Edited by caller", propertyId: "prop-a" });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("refuses to delete an owned work order whose house is outside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    STORED_ROW = {
      manager_user_id: "mgr-1",
      resident_email: null,
      row_data: { id: "wo-1", title: "Old title", propertyId: "prop-outside" },
    };

    const res = await postDelete("wo-1");

    expect(res.status).toBe(403);
    expect(DELETES).toHaveLength(0);
  });
});

describe("the legacy unassigned-claim bucket stays outside workspace narrowing", () => {
  it("lets a manager claim an ownerless legacy row on a workspace-OUTSIDE property they hold, exactly as before", async () => {
    // The active workspace holds only prop-a, but the caller separately OWNS
    // prop-victim (outside the active workspace) — the legacy claim path is
    // governed by ownership of the property the row names, never by the
    // active workspace, so this must still succeed.
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    OWNED_PROPERTY_IDS = ["prop-victim"];
    STORED_ROW = {
      manager_user_id: null,
      resident_email: "tenant@test.proplane.local",
      row_data: { id: "wo-legacy", title: "Legacy leaking roof", propertyId: "prop-victim" },
    };

    const res = await postRow({ id: "wo-legacy", title: "Claimed by caller" });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });
});
