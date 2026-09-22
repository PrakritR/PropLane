/**
 * `fetchLeasesForManagerUser` (src/lib/auth/manager-lease-scope.ts) is the
 * Leases tab's OWN list query, over `portal_lease_pipeline_records` — a
 * genuinely separate table from `manager_application_records` (which backs
 * Applications/Residents; see manager-applications-workspace-scope.test.ts).
 * Before this change it queried the manager's own rows with NO property
 * filter at all, so leases merged across every workspace the manager owns.
 *
 * Proves the same three shared rules: `null` (no workspaces / load failure)
 * never narrows; a resolved array restricts to those houses; an empty array
 * (the workspace holds none) yields no property-scoped rows. Also proves the
 * account-level rule for a lease not yet tied to a house (`property_id:
 * null`): visible only when the active workspace is the viewer's own
 * default, mirroring `conversation-visibility.server.ts`'s
 * `untaggedOwnedVisible`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

type LeaseRow = {
  id: string;
  manager_user_id: string | null;
  property_id: string | null;
  updated_at: string;
  row_data: unknown;
};

let LEASES: LeaseRow[];
let ACTIVE_WORKSPACE_SCOPE: string[] | null;
let ACTIVE_WORKSPACES: Array<{ id: string; owned: boolean; isDefault: boolean }>;
let SELECTED_WORKSPACE_ID: string | undefined;

vi.mock("@/lib/workspaces/scope.server", () => ({
  activeWorkspacePropertyScope: vi.fn(async () => ACTIVE_WORKSPACE_SCOPE),
}));
vi.mock("@/lib/workspaces/server", () => ({
  loadWorkspaces: vi.fn(async () => ACTIVE_WORKSPACES),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (_name: string) => (SELECTED_WORKSPACE_ID !== undefined ? { value: SELECTED_WORKSPACE_ID } : undefined),
  })),
}));

/** Minimal chainable Supabase stub for `portal_lease_pipeline_records` (own rows) and empty co-manager tables. */
function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      const state: { eqCol: string | null; eqVal: string | null; inCol: string | null; inVals: string[] | null } = {
        eqCol: null,
        eqVal: null,
        inCol: null,
        inVals: null,
      };
      const rows = (): unknown[] => {
        if (table !== "portal_lease_pipeline_records") return [];
        let out: LeaseRow[] = LEASES;
        if (state.eqCol === "manager_user_id") out = out.filter((r) => r.manager_user_id === state.eqVal);
        if (state.inCol === "property_id") out = out.filter((r) => r.property_id && state.inVals?.includes(r.property_id));
        return out;
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(col: string, val: unknown) {
          state.eqCol = col;
          state.eqVal = String(val);
          return builder;
        },
        in(col: string, vals: string[]) {
          state.inCol = col;
          state.inVals = vals;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve({ data: rows(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const MANAGER = "mgr-lease-multi-workspace";
const HOUSE_A = "house-a-lease-workspace";
const HOUSE_B = "house-b-lease-workspace";
const WS_OWN_DEFAULT = "ws-own-default";
const WS_OTHER = "ws-not-default";

function lease(id: string, propertyId: string | null): LeaseRow {
  return { id, manager_user_id: MANAGER, property_id: propertyId, updated_at: "2026-07-01T00:00:00.000Z", row_data: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  LEASES = [lease("LEASE-A", HOUSE_A), lease("LEASE-B", HOUSE_B)];
  ACTIVE_WORKSPACE_SCOPE = null;
  ACTIVE_WORKSPACES = [];
  SELECTED_WORKSPACE_ID = undefined;
});

describe("fetchLeasesForManagerUser — active-workspace narrowing", () => {
  it("shows only workspace A's leases while workspace A is active", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    const { fetchLeasesForManagerUser } = await import("@/lib/auth/manager-lease-scope");

    const rows = await fetchLeasesForManagerUser(fakeDb() as never, MANAGER);

    expect(rows.map((r) => r.id)).toEqual(["LEASE-A"]);
  });

  it("switching the active workspace to B shows only B's leases", async () => {
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_B];
    const { fetchLeasesForManagerUser } = await import("@/lib/auth/manager-lease-scope");

    const rows = await fetchLeasesForManagerUser(fakeDb() as never, MANAGER);

    expect(rows.map((r) => r.id)).toEqual(["LEASE-B"]);
  });

  it("an empty workspace (holds no houses) yields no leases, even though the manager owns leases elsewhere", async () => {
    ACTIVE_WORKSPACE_SCOPE = [];
    const { fetchLeasesForManagerUser } = await import("@/lib/auth/manager-lease-scope");

    const rows = await fetchLeasesForManagerUser(fakeDb() as never, MANAGER);

    expect(rows).toHaveLength(0);
  });

  it("a single-workspace manager (null scope) is unaffected — sees every owned lease, exactly as before", async () => {
    ACTIVE_WORKSPACE_SCOPE = null;
    const { fetchLeasesForManagerUser } = await import("@/lib/auth/manager-lease-scope");

    const rows = await fetchLeasesForManagerUser(fakeDb() as never, MANAGER);

    expect(rows.map((r) => r.id).sort()).toEqual(["LEASE-A", "LEASE-B"]);
  });

  it("shows an account-level lease (no property yet) only while the ACTIVE workspace is the viewer's own default", async () => {
    LEASES = [lease("LEASE-A", HOUSE_A), lease("LEASE-UNFILED", null)];
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    ACTIVE_WORKSPACES = [{ id: WS_OWN_DEFAULT, owned: true, isDefault: true }];
    SELECTED_WORKSPACE_ID = WS_OWN_DEFAULT;
    const { fetchLeasesForManagerUser } = await import("@/lib/auth/manager-lease-scope");

    const rows = await fetchLeasesForManagerUser(fakeDb() as never, MANAGER);

    expect(rows.map((r) => r.id).sort()).toEqual(["LEASE-A", "LEASE-UNFILED"]);
  });

  it("hides that same account-level lease once a NON-default (or non-owned) workspace is active", async () => {
    LEASES = [lease("LEASE-A", HOUSE_A), lease("LEASE-UNFILED", null)];
    ACTIVE_WORKSPACE_SCOPE = [HOUSE_A];
    ACTIVE_WORKSPACES = [{ id: WS_OTHER, owned: true, isDefault: false }];
    SELECTED_WORKSPACE_ID = WS_OTHER;
    const { fetchLeasesForManagerUser } = await import("@/lib/auth/manager-lease-scope");

    const rows = await fetchLeasesForManagerUser(fakeDb() as never, MANAGER);

    expect(rows.map((r) => r.id)).toEqual(["LEASE-A"]);
  });
});
