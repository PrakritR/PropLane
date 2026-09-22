/**
 * Batch A — active-workspace scoping. `POST /api/portal-service-requests`
 * must refuse a manager's delete/upsert of a row whose house is outside the
 * active workspace, and refuse creating a new row under a property outside
 * it. Read scoping for this route is covered at the shared-loader level in
 * `manager-workspace-row-scope.test.ts` (the manager GET branch funnels
 * entirely through `fetchRowsForManagerWithLinked`); this file is the
 * write-path proof.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const isAdminUser = vi.fn(async () => false);
const resolveResidentScopedActorRole = vi.fn(async () => "manager");
const resolveManagerWorkspaceRowScope = vi.fn();

type Row = Record<string, unknown>;
const state = {
  profile: { email: "mgr@test.local", role: "manager" } as Row | null,
  rows: new Map<string, Row>(),
  upserted: [] as Row[],
  deletedIds: [] as string[],
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...(a as [])) }));
vi.mock("@/lib/auth/resident-role-access", () => ({
  resolveResidentScopedActorRole: (...a: unknown[]) => resolveResidentScopedActorRole(...(a as [])),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }),
}));
vi.mock("@/lib/resident-manager-scope", () => ({ resolveResidentFilingScope: async () => null }));
vi.mock("@/lib/repair-service-request-scopes.server", () => ({
  repairServiceRequestScopesForManager: async () => undefined,
  shouldRunScopeRepair: () => false,
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitServiceRequestTransition: async () => undefined }));
vi.mock("@/lib/work-order-notification.server", () => ({
  notifyManagerOfResidentFiledItem: async () => undefined,
  notifyManagersOfManagerAuthoredItem: async () => undefined,
  notifyResidentOfManagerAuthoredItem: async () => undefined,
}));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>();
  return {
    ...actual,
    fetchRowsForManagerWithLinked: async () => [],
    linkedPropertyIdsForModule: async () => new Set<string>(),
    resolveManagerWorkspaceRowScope: (...a: unknown[]) => resolveManagerWorkspaceRowScope(...(a as [])),
  };
});

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.profile }) }) }) };
      }
      if (table === "portal_service_request_records") {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({ data: state.rows.get(id) ?? null }),
            }),
          }),
          upsert: async (row: Row) => {
            state.upserted.push(row);
            state.rows.set(String(row.id), row);
            return { data: null, error: null };
          },
          delete: () => ({
            eq: async (_col: string, id: string) => {
              state.deletedIds.push(id);
              return { data: null, error: null };
            },
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const { POST } = await import("@/app/api/portal-service-requests/route");

const post = (body: unknown) =>
  POST(new Request("https://prop-lane.space/api/portal-service-requests", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  isAdminUser.mockResolvedValue(false);
  resolveResidentScopedActorRole.mockResolvedValue("manager");
  state.profile = { email: "mgr@test.local", role: "manager" };
  state.rows = new Map();
  state.upserted = [];
  state.deletedIds = [];
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "mgr@test.local" } } });
});

describe("delete — refuses a row outside the active workspace", () => {
  it("refuses to delete a request whose house is outside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    state.rows.set("sr-1", { id: "sr-1", manager_user_id: "mgr-1", property_id: "prop-outside", resident_email: null });

    const res = await post({ action: "delete", id: "sr-1" });

    expect(res.status).toBe(403);
    expect(state.deletedIds).toEqual([]);
  });

  it("allows the delete when the house is in the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });
    state.rows.set("sr-1", { id: "sr-1", manager_user_id: "mgr-1", property_id: "prop-a", resident_email: null });

    const res = await post({ action: "delete", id: "sr-1" });

    expect(res.status).toBe(200);
    expect(state.deletedIds).toEqual(["sr-1"]);
  });
});

describe("upsert — a new request must land in the active workspace", () => {
  it("refuses to create a request under a property outside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });

    const res = await post({
      row: { id: "sr-new", propertyId: "prop-outside", status: "pending" },
    });

    expect(res.status).toBe(403);
    expect(state.upserted).toEqual([]);
  });

  it("creates a request under a property inside the active workspace", async () => {
    resolveManagerWorkspaceRowScope.mockResolvedValue({ propertyIds: ["prop-a"], untaggedOwnedVisible: true });

    const res = await post({
      row: { id: "sr-new", propertyId: "prop-a", status: "pending" },
    });

    expect(res.status).toBe(200);
    expect(state.upserted.map((r) => r.id)).toEqual(["sr-new"]);
  });
});
