import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #103: GET /api/portal-promotions returned every co-managed owner's promotions and relied on the page to
 * filter them, and GET /api/portal/occupancy authorized whatever house list the client sent. Both now answer for the
 * viewer's ACTIVE workspace only, resolved on the server.
 */

const state = vi.hoisted(() => ({
  promotions: [] as { row_data: Record<string, unknown>; manager_user_id: string }[],
  rowScope: { propertyIds: ["house-b"] as string[] | null, untaggedOwnedVisible: false },
  houseScope: ["house-b"] as string[] | null,
  scopeUnavailable: false,
  snapshotArgs: null as null | { propertyIds: string[] },
}));

async function unavailable(): Promise<never> {
  const { WorkspaceScopeUnavailableError } = await import("@/lib/workspaces/scope-unavailable");
  throw new WorkspaceScopeUnavailableError();
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "staff-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "profile_roles") {
        return { select: () => ({ eq() { return this; }, maybeSingle: async () => ({ data: null, error: null }) }) };
      }
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        eq: () => builder,
        then: (resolve: (v: unknown) => unknown) => resolve({ data: state.promotions, error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock("@/lib/manager-route-guard.server", () => ({
  userHoldsManagerRole: async () => true,
  requireManagerRouteUser: async () => ({ userId: "staff-1", db: {} }),
}));
vi.mock("@/lib/auth/admin-oversight.server", () => ({ resolveAdminOversight: async () => false }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedOwnerForProperty: async () => null,
  linkedOwnerScopeForModule: async () => ({ ownerIds: new Set<string>() }),
  linkedPropertyIdsForModule: async () => new Set<string>(),
  resolveManagerWorkspaceRowScope: async () => (state.scopeUnavailable ? unavailable() : state.rowScope),
  rowInWorkspaceScope: (propertyId: string | null | undefined, scope: { propertyIds: string[] | null; untaggedOwnedVisible: boolean }) => {
    if (scope.propertyIds === null) return true;
    const pid = (propertyId ?? "").trim();
    return pid ? scope.propertyIds.includes(pid) : scope.untaggedOwnedVisible;
  },
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerHasCalendarAccessForProperty: async () => true }));
vi.mock("@/lib/workspaces/scope.server", () => ({
  activeWorkspacePropertyScope: async () => (state.scopeUnavailable ? unavailable() : state.houseScope),
}));
vi.mock("@/lib/occupancy/snapshot.server", () => ({
  occupancySnapshotForManager: async (_db: unknown, _user: string, args: { propertyIds: string[] }) => {
    state.snapshotArgs = args;
    return { propertyIds: args.propertyIds };
  },
}));

import { GET as promotionsGet } from "@/app/api/portal-promotions/route";
import { GET as occupancyGet } from "@/app/api/portal/occupancy/route";

const promo = (id: string, propertyId: string | null) => ({
  manager_user_id: "owner",
  row_data: { id, propertyId, title: id, inputs: {} },
});

beforeEach(() => {
  state.promotions = [promo("p-a", "house-a"), promo("p-b", "house-b"), promo("p-none", null)];
  state.rowScope = { propertyIds: ["house-b"], untaggedOwnedVisible: false };
  state.houseScope = ["house-b"];
  state.scopeUnavailable = false;
  state.snapshotArgs = null;
});

describe("GET /api/portal-promotions", () => {
  const ids = async () => {
    const res = await promotionsGet(new Request("http://localhost/api/portal-promotions"));
    return { status: res.status, ids: ((await res.json()) as { rows?: { id: string }[] }).rows?.map((r) => r.id) };
  };

  it("returns only the active workspace's promotions", async () => {
    expect(await ids()).toEqual({ status: 200, ids: ["p-b"] });
  });

  it("shows an account-level promotion only in the owned default workspace", async () => {
    state.rowScope = { propertyIds: ["house-a"], untaggedOwnedVisible: true };
    expect((await ids()).ids).toEqual(["p-a", "p-none"]);
  });

  it("returns nothing for a workspace with no houses", async () => {
    state.rowScope = { propertyIds: [], untaggedOwnedVisible: false };
    expect((await ids()).ids).toEqual([]);
  });

  it("answers 503, never the unfiltered list, when the workspace cannot be resolved", async () => {
    state.scopeUnavailable = true;
    expect(await ids()).toEqual({ status: 503, ids: undefined });
  });
});

describe("GET /api/portal/occupancy", () => {
  const get = (houses: string) =>
    occupancyGet(new Request(`http://localhost/api/portal/occupancy?propertyIds=${houses}&from=2026-11-01&to=2026-11-30`));

  it("drops client-sent houses that are outside the active workspace", async () => {
    const res = await get("house-a,house-b");
    expect(res.status).toBe(200);
    expect(state.snapshotArgs?.propertyIds).toEqual(["house-b"]);
  });

  it("reads nothing when every sent house belongs to another workspace", async () => {
    await get("house-a");
    expect(state.snapshotArgs?.propertyIds).toEqual([]);
  });

  it("does not narrow when the viewer has no workspace at all (scope null)", async () => {
    state.houseScope = null;
    await get("house-a,house-b");
    expect(state.snapshotArgs?.propertyIds).toEqual(["house-a", "house-b"]);
  });

  it("answers 503 when the workspace cannot be resolved", async () => {
    state.scopeUnavailable = true;
    expect((await get("house-a")).status).toBe(503);
    expect(state.snapshotArgs).toBeNull();
  });
});
