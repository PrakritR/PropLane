import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authUser: { id: "admin-actor", email: "admin@example.com", user_metadata: {} as Record<string, unknown> },
  admin: true,
  effectiveId: "manager-target",
  profiles: {
    "admin-actor": { email: "admin@example.com", role: "admin", full_name: "Ada Admin" },
    "manager-target": { email: "manager@example.com", role: "manager", full_name: "Mo Manager" },
  } as Record<string, { email?: string; role?: string; full_name?: string }>,
  effective: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: state.authUser } })) },
  })),
}));
vi.mock("@/lib/auth/admin-preview", () => ({
  isAdminUser: vi.fn(async () => state.admin),
}));
vi.mock("@/lib/auth/effective-session", () => ({
  getEffectiveUserIdForPortal: state.effective,
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
  assertTestWorkspacePrincipalCompatibility: vi.fn(async () => undefined),
}));

const db = {
  from: vi.fn((table: string) => {
    let ids: string[] | null = null;
    const chain = {
      select: () => chain,
      eq: (column: string, value: string) => {
        if (column === "id") ids = [value];
        return chain;
      },
      maybeSingle: async () => {
        const rows = Object.entries(state.profiles)
          .filter(([id]) => !ids || ids.includes(id))
          .map(([, profile]) => profile);
        return { data: rows[0] ?? null, error: null };
      },
    };
    if (table !== "profiles") throw new Error(`unexpected table ${table}`);
    return chain;
  }),
};

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(() => db),
}));

import { resolveInboxScopeUser } from "@/lib/portal-inbox-thread-scope";

beforeEach(() => {
  vi.clearAllMocks();
  state.admin = true;
  state.effectiveId = "manager-target";
  state.effective.mockResolvedValue(state.effectiveId);
});

describe("portal inbox effective viewer composition", () => {
  it("resolves an authenticated admin's manager scope to the effective manager identity", async () => {
    const resolved = await resolveInboxScopeUser("axis_portal_inbox_manager_v1");

    // The NAME follows the effective identity too: a turn appended to someone
    // else's row is attributed from it, so it must never stay the admin's.
    expect(resolved?.user).toEqual({
      id: "manager-target",
      email: "manager@example.com",
      role: "admin",
      name: "Mo Manager",
    });
    expect(state.effective).toHaveBeenCalledWith("manager");
    expect(db.from).toHaveBeenCalledWith("profiles");
  });

  it("keeps admin scope on the authenticated admin and does not compose a portal target", async () => {
    const resolved = await resolveInboxScopeUser("admin");

    expect(resolved?.user).toEqual({
      id: "admin-actor",
      email: "admin@example.com",
      role: "admin",
      name: "Ada Admin",
    });
    expect(state.effective).not.toHaveBeenCalled();
  });

  it("fails closed for an absent authenticated user before service lookup", async () => {
    state.authUser = null as never;
    const resolved = await resolveInboxScopeUser("axis_portal_inbox_manager_v1");

    expect(resolved).toBeNull();
    expect(db.from).not.toHaveBeenCalled();
  });
});
