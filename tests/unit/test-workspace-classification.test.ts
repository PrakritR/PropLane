import { beforeEach, describe, expect, it, vi } from "vitest";

const authUser = vi.hoisted(() => vi.fn());
const adminCheck = vi.hoisted(() => vi.fn());
const serviceDb = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: authUser } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: adminCheck }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));

import {
  isTestWorkspaceFeatureEnabled,
  requireTrustedTestWorkspaceOperator,
  resolveAuthenticatedBusinessAccess,
  resolveTestWorkspaceClassification,
} from "@/lib/test-workspaces/index.server";

const USER = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function dbFor(row: unknown, error: unknown = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: row, error }),
  };
  return { from: vi.fn().mockReturnValue(query), query };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PROPLANE_TEST_WORKSPACES_ENABLED", "false");
  vi.stubEnv("PROPLANE_TEST_WORKSPACE_OPERATOR_IDS", USER);
  authUser.mockResolvedValue({ data: { user: { id: USER } } });
  adminCheck.mockResolvedValue(true);
});

describe("test workspace classification", () => {
  it.each([
    [{ state: "active", workspace: { status: "active" }, expires_at: null }, "active"],
    [{ state: "suspended", workspace: { status: "active" }, expires_at: null }, "suspended"],
    [{ state: "active", workspace: { status: "suspended" }, expires_at: null }, "suspended"],
    [{ state: "active", workspace: { status: "active" }, expires_at: "2020-01-01T00:00:00.000Z" }, "expired"],
  ])("resolves membership state as %s", async (membership, state) => {
    const db = dbFor({ workspace_id: WORKSPACE, portal_role: "resident", ...membership });
    await expect(resolveTestWorkspaceClassification(USER, db as never)).resolves.toEqual({
      kind: "classified",
      workspaceId: WORKSPACE,
      role: "resident",
      state,
    });
  });

  it("keeps durable classification independent of the feature flag", async () => {
    const db = dbFor({ workspace_id: WORKSPACE, portal_role: "manager", state: "active", workspace: { status: "active" }, expires_at: null });
    expect(isTestWorkspaceFeatureEnabled({ PROPLANE_TEST_WORKSPACES_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe(false);
    await expect(resolveTestWorkspaceClassification(USER, db as never)).resolves.toMatchObject({
      kind: "classified",
      workspaceId: WORKSPACE,
      state: "active",
    });
  });

  it.each([
    ["active", { state: "active", workspace: { status: "active" }, expires_at: null }, "true", "test"],
    ["suspended member", { state: "suspended", workspace: { status: "active" }, expires_at: null }, "true", "denied"],
    ["expired member", { state: "active", workspace: { status: "active" }, expires_at: "2020-01-01T00:00:00.000Z" }, "true", "denied"],
    ["feature disabled", { state: "active", workspace: { status: "active" }, expires_at: null }, "false", "denied"],
  ] as const)("keeps a %s classified session out of ordinary business access", async (_name, membership, enabled, expected) => {
    vi.stubEnv("PROPLANE_TEST_WORKSPACES_ENABLED", enabled);
    const db = dbFor({ workspace_id: WORKSPACE, portal_role: "resident", ...membership });
    await expect(resolveAuthenticatedBusinessAccess(USER, db as never)).resolves.toMatchObject({ kind: expected });
  });

  it("keeps ordinary authenticated accounts on the ordinary business path", async () => {
    const db = dbFor(null);
    await expect(resolveAuthenticatedBusinessAccess(USER, db as never)).resolves.toEqual({ kind: "normal" });
  });

  it("fails closed on membership storage errors", async () => {
    const db = dbFor(null, { message: "database offline" });
    await expect(resolveTestWorkspaceClassification(USER, db as never)).rejects.toThrow(
      "Could not resolve test workspace classification",
    );
  });

  it("does not allow a classified principal to become a trusted operator", async () => {
    serviceDb.mockReturnValue(dbFor({
      workspace_id: WORKSPACE,
      portal_role: "manager",
      state: "active",
      workspace: { status: "active" },
      expires_at: null,
    }));
    await expect(requireTrustedTestWorkspaceOperator()).rejects.toThrow("Test workspace access is unavailable");
  });

  it("does not allow a canonical sandbox principal to become a trusted operator", async () => {
    authUser.mockResolvedValue({ data: { user: { id: USER, email: "testeverything@test.proplane.local" } } });
    serviceDb.mockReturnValue(dbFor(null));
    await expect(requireTrustedTestWorkspaceOperator()).rejects.toThrow("Test workspace access is unavailable");
    expect(adminCheck).not.toHaveBeenCalled();
  });
});
