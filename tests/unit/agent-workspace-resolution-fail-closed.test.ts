import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `AgentContext.workspace` used to go `undefined` whenever the workspace
 * resolution itself failed (`resolveActiveWorkspaceFromRequest` / `loadWorkspaces`
 * threw), inside `resolveAgentContext`'s catch block. Every tool's gate
 * (`propertyInAgentWorkspace`/`rowAllowedInAgentWorkspace`,
 * `src/lib/agent/manager-workspace-scope.ts`) already treats `undefined` as
 * "not narrowing" BY DESIGN for turns where workspace scoping genuinely does
 * not apply (a vendor/leasing agent turn, or a manager-SMS turn with no
 * workspace selected) — so a silent RESOLUTION FAILURE collapsing to that same
 * shape handed the assistant the whole, unpartitioned account instead of
 * refusing until the scope resolves. This proves the fix: a failure must
 * produce a scope that DENIES every property, never one that is
 * indistinguishable from "no scoping needed here".
 */

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: { id: "mgr-1" } as { id: string } | null,
  profile: { email: "mgr@axis.test", role: "manager" } as Row | null,
  roles: [{ role: "manager" }] as Row[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
  }),
}));

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));

function table(rows: Row[]) {
  const filters: [string, unknown][] = [];
  const api = {
    select: () => api,
    eq: (c: string, v: unknown) => {
      filters.push([c, v]);
      return api;
    },
    in: () => api,
    order: () => api,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
      resolve({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === undefined || r[c] === v)), error: null }),
  };
  return api;
}

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (name: string) => {
      if (name === "profiles") return table(state.profile ? [state.profile] : []);
      if (name === "profile_roles") return table(state.roles);
      return table([]);
    },
  }),
}));

// The resolution failure this test exists to prove is handled safely.
vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspaceFromRequest: async () => {
    throw new Error("workspace lookup failed");
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { id: "mgr-1" };
  state.profile = { email: "mgr@axis.test", role: "manager" };
  state.roles = [{ role: "manager" }];
});

describe("resolveAgentContext — a failed workspace resolution fails CLOSED", () => {
  it("stamps the deny-all sentinel, never `undefined`, when the workspace lookup throws", async () => {
    const { resolveAgentContext } = await import("@/lib/tools/context");
    const { UNRESOLVED_AGENT_WORKSPACE_SCOPE } = await import("@/lib/agent/manager-workspace-scope");

    const ctx = await resolveAgentContext();

    expect(ctx?.workspace).toBeDefined();
    expect(ctx?.workspace).toEqual(UNRESOLVED_AGENT_WORKSPACE_SCOPE);
  });

  it("denies every property AND every account-level row once stamped this way", async () => {
    const { resolveAgentContext } = await import("@/lib/tools/context");
    const { propertyInAgentWorkspace, rowAllowedInAgentWorkspace } = await import(
      "@/lib/agent/manager-workspace-scope"
    );

    const ctx = await resolveAgentContext();

    // Before the fix this was `true` for everything, because `ctx.workspace`
    // was `undefined` and `propertyInAgentWorkspace`'s `!workspace => true`
    // fallback read a resolution failure exactly like "not narrowing".
    expect(propertyInAgentWorkspace(ctx?.workspace, "some-property")).toBe(false);
    expect(propertyInAgentWorkspace(ctx?.workspace, undefined)).toBe(false);
    expect(rowAllowedInAgentWorkspace(ctx!, { propertyId: "some-property" })).toBe(false);
    expect(rowAllowedInAgentWorkspace(ctx!, {})).toBe(false);
  });
});
