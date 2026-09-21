import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  hasRole: vi.fn(),
  activeActor: vi.fn(),
  serviceDb: vi.fn(),
  publicListings: vi.fn(),
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: mocks.access,
  hasRole: mocks.hasRole,
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  isTestWorkspaceFeatureEnabled: (env: NodeJS.ProcessEnv = process.env) => env.PROPLANE_TEST_WORKSPACES_ENABLED === "true",
  requireActiveTestWorkspaceActor: mocks.activeActor,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceDb }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerSubscriptionTierByManagerId: vi.fn(async () => "pro") }));
vi.mock("@/lib/tools/context", () => ({ resolveAgentContext: vi.fn() }));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.publicListings }));

import {
  resolveSmsTestCapability,
  smsTestEnvironmentAllowed,
} from "@/lib/agent/sms-test-context.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANAGER = "22222222-2222-4222-8222-222222222222";

function scopedDb() {
  const calls: Array<[string, string, unknown]> = [];
  const from = vi.fn((table: string) => {
    const query: Record<string, unknown> = {};
    query.select = () => query;
    query.eq = (key: string, value: unknown) => { calls.push([table, key, value]); return query; };
    query.limit = async () => table === "manager_application_records"
      ? { data: [], error: null }
      : { data: [{ id: "listing-a", manager_user_id: MANAGER, property_data: { title: "Oak" } }], error: null };
    return query;
  });
  return { db: { from }, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PROPLANE_TEST_WORKSPACES_ENABLED", "true");
  vi.stubEnv("VERCEL_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://emstjswhotsnyksqhqyf.supabase.co");
  mocks.access.mockResolvedValue({ user: { id: ACTOR, email: "resident@example.com" }, profile: { full_name: "Resident" } });
  mocks.hasRole.mockReturnValue(true);
  mocks.activeActor.mockResolvedValue({ kind: "classified", workspaceId: WORKSPACE, role: "resident", state: "active" });
  mocks.publicListings.mockResolvedValue([{
    id: "listing-a",
    managerUserId: MANAGER,
    title: "Oak",
    address: "1 Oak St",
  }]);
});

describe("private SMS test workspace scope", () => {
  it("allows only the exact environment/database pairing", () => {
    expect(smsTestEnvironmentAllowed({ PROPLANE_TEST_WORKSPACES_ENABLED: "true", VERCEL_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co" } as NodeJS.ProcessEnv)).toBe(true);
    expect(smsTestEnvironmentAllowed({ PROPLANE_TEST_WORKSPACES_ENABLED: "true", VERCEL_ENV: "preview", NEXT_PUBLIC_SUPABASE_URL: "https://xwszcafaontidfgznlxd.supabase.co" } as NodeJS.ProcessEnv)).toBe(true);
    expect(smsTestEnvironmentAllowed({ PROPLANE_TEST_WORKSPACES_ENABLED: "true", VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://qahnczmilgptcedaqype.supabase.co" } as NodeJS.ProcessEnv)).toBe(true);
    expect(smsTestEnvironmentAllowed({ PROPLANE_TEST_WORKSPACES_ENABLED: "true", VERCEL_ENV: "development", NEXT_PUBLIC_SUPABASE_URL: "https://xwszcafaontidfgznlxd.supabase.co" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("scopes resident targets to the authenticated workspace", async () => {
    const { db, calls } = scopedDb();
    mocks.serviceDb.mockReturnValue(db);
    const capability = await resolveSmsTestCapability("resident");
    expect(capability).toMatchObject({ workspaceId: WORKSPACE, actorUserId: ACTOR, targets: [{ listingId: "listing-a" }] });
    expect(calls).toContainEqual(["manager_application_records", "test_workspace_id", WORKSPACE]);
    expect(mocks.publicListings).toHaveBeenCalledWith({ testWorkspaceId: WORKSPACE });
  });

  it("fails closed when active membership resolution rejects", async () => {
    mocks.activeActor.mockRejectedValue(new Error("Test workspace access is unavailable."));
    await expect(resolveSmsTestCapability("resident")).rejects.toThrow("Test workspace access is unavailable");
  });
});
