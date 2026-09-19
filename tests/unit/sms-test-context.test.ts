import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPortalAccessContext: vi.fn(),
  hasRole: vi.fn(),
  getPublicListings: vi.fn(),
  serviceDb: vi.fn(),
  resolveAgentContext: vi.fn(),
  resolveManagerSmsAccess: vi.fn(),
  managerTier: vi.fn(),
  isProductionRuntime: vi.fn(),
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: mocks.getPortalAccessContext,
  hasRole: mocks.hasRole,
}));
vi.mock("@/lib/public-listings.server", () => ({
  getPublicListings: mocks.getPublicListings,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.serviceDb,
}));
vi.mock("@/lib/tools/context", () => ({
  resolveAgentContext: mocks.resolveAgentContext,
}));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({
  resolveManagerSmsAccess: mocks.resolveManagerSmsAccess,
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerSubscriptionTierByManagerId: mocks.managerTier,
}));
vi.mock("@/lib/server-env", () => ({
  isProductionRuntime: mocks.isProductionRuntime,
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  isTestWorkspaceFeatureEnabled: (env: NodeJS.ProcessEnv = process.env) =>
    env.PROPLANE_TEST_WORKSPACES_ENABLED === "true",
  requireActiveTestWorkspaceActor: vi.fn().mockResolvedValue({
    kind: "classified",
    workspaceId: "workspace-a",
    role: "resident",
    state: "active",
  }),
}));

import {
  resolveSmsTestApplicationStage,
  resolveSmsTestContext,
  smsTestEnvironmentAllowed,
} from "@/lib/agent/sms-test-context.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER_OWNER = "33333333-3333-4333-8333-333333333333";

function applicationDb(rows: unknown[] = [], error: unknown = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error }),
  };
  return { from: vi.fn().mockReturnValue(query), query };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://xwszcafaontidfgznlxd.supabase.co");
  vi.stubEnv("PROPLANE_TEST_WORKSPACES_ENABLED", "true");
  mocks.isProductionRuntime.mockReturnValue(false);
  mocks.hasRole.mockReturnValue(true);
  mocks.getPortalAccessContext.mockResolvedValue({
    user: { id: ACTOR, email: "resident@example.com" },
    profile: { email: "resident@example.com", full_name: "Resident Test" },
    roles: ["resident"],
  });
  mocks.getPublicListings.mockResolvedValue([
    { id: "listing-a", managerUserId: OWNER, title: "Oak Home", address: "1 Oak St" },
    { id: "listing-b", managerUserId: OTHER_OWNER, title: "Pine Home", address: "2 Pine St" },
  ]);
  mocks.managerTier.mockResolvedValue("pro");
  mocks.resolveManagerSmsAccess.mockResolvedValue({
    mode: "owner",
    workNumberOwnerId: ACTOR,
    actorUserId: ACTOR,
    dataOwnerIds: [ACTOR],
    assignedPropertyIds: [],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SMS test environment gate", () => {
  it("allows only localhost and the approved dev/staging projects", () => {
    expect(smsTestEnvironmentAllowed({
      NODE_ENV: "development",
      PROPLANE_TEST_WORKSPACES_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(smsTestEnvironmentAllowed({
      NODE_ENV: "development",
      PROPLANE_TEST_WORKSPACES_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co",
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(smsTestEnvironmentAllowed({
      VERCEL_ENV: "preview",
      PROPLANE_TEST_WORKSPACES_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://xwszcafaontidfgznlxd.supabase.co",
    } as NodeJS.ProcessEnv)).toBe(true);
    expect(smsTestEnvironmentAllowed({
      NODE_ENV: "development",
      PROPLANE_TEST_WORKSPACES_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://qahnczmilgptcedaqype.supabase.co",
    } as NodeJS.ProcessEnv)).toBe(false);
    expect(smsTestEnvironmentAllowed({
      VERCEL_ENV: "production",
      VERCEL_GIT_COMMIT_REF: "production",
      PROPLANE_TEST_WORKSPACES_ENABLED: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://emstjswhotsnyksqhqyf.supabase.co",
    } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("resolveSmsTestApplicationStage", () => {
  it.each([
    [[], "prospect"],
    [[{ row_data: { bucket: "draft" } }], "prospect"],
    [[{ row_data: { bucket: "rejected" } }], "prospect"],
    [[{ row_data: { bucket: "withdrawn" } }], "prospect"],
    [[{ row_data: { bucket: "pending" } }], "submitted"],
    [[{ row_data: { bucket: "approved" } }], "approved"],
    [[{ row_data: { bucket: "pending" } }, { row_data: { bucket: "approved" } }], "approved"],
  ])("maps application rows %j to %s", async (rows, expected) => {
    const { from, query } = applicationDb(rows);
    await expect(resolveSmsTestApplicationStage({ from } as never, {
      residentEmail: " Resident@Example.com ",
      managerUserId: OWNER,
    })).resolves.toBe(expected);
    expect(query.eq).toHaveBeenCalledWith("resident_email", "resident@example.com");
    expect(query.eq).toHaveBeenCalledWith("manager_user_id", OWNER);
  });

  it("fails closed when the dedicated application lookup errors", async () => {
    const { from } = applicationDb([], { message: "database offline" });
    await expect(resolveSmsTestApplicationStage({ from } as never, {
      residentEmail: "resident@example.com",
      managerUserId: OWNER,
    })).rejects.toThrow("Could not verify the application stage");
  });
});

describe("resolveSmsTestContext", () => {
  it("removes portal workspace narrowing and installs workspace-bound combined co-manager scope", async () => {
    const db = applicationDb([]);
    const combined = {
      mode: "combined",
      workNumberOwnerId: ACTOR,
      actorUserId: ACTOR,
      dataOwnerIds: [ACTOR, OWNER],
      assignedPropertyIds: ["listing-a"],
      permissionsByOwner: { [OWNER]: { "listing-a": { applications: { read: true } } } },
    };
    mocks.serviceDb.mockReturnValue(db);
    mocks.getPortalAccessContext.mockResolvedValue({
      user: { id: ACTOR, email: "manager@example.com" },
      profile: { email: "manager@example.com", full_name: "Co-manager" },
      roles: ["manager"],
    });
    mocks.resolveAgentContext.mockResolvedValue({
      userId: ACTOR,
      landlordId: ACTOR,
      email: "manager@example.com",
      roles: ["manager"],
      isAdmin: false,
      db,
      testWorkspaceId: "workspace-a",
      workspace: { id: "portal-workspace", name: "Mine", isDefault: true, narrowing: true, propertyIds: [] },
      managerSmsAccess: combined,
    });
    mocks.resolveManagerSmsAccess.mockResolvedValue(combined);

    const context = await resolveSmsTestContext({ portal: "manager" });

    expect(mocks.resolveManagerSmsAccess).toHaveBeenCalledWith(db, {
      actorUserId: ACTOR,
      workNumberOwnerId: ACTOR,
      testWorkspaceId: "workspace-a",
    });
    expect(context?.managerContext).toMatchObject({ managerSmsAccess: combined, testWorkspaceId: "workspace-a" });
    expect(context?.managerContext?.workspace).toBeUndefined();
  });

  it("refuses a linked-owner scope that disappears under the active test workspace", async () => {
    const db = applicationDb([]);
    mocks.getPortalAccessContext.mockResolvedValue({
      user: { id: ACTOR, email: "manager@example.com" }, profile: {}, roles: ["manager"],
    });
    mocks.resolveAgentContext.mockResolvedValue({
      userId: ACTOR, landlordId: ACTOR, email: "manager@example.com", roles: ["manager"], isAdmin: false,
      db, testWorkspaceId: "workspace-a",
      managerSmsAccess: { mode: "combined", dataOwnerIds: [ACTOR, OTHER_OWNER], assignedPropertyIds: ["listing-b"] },
    });
    mocks.resolveManagerSmsAccess.mockResolvedValue({
      mode: "owner", workNumberOwnerId: ACTOR, actorUserId: ACTOR, dataOwnerIds: [ACTOR], assignedPropertyIds: [],
    });

    await expect(resolveSmsTestContext({ portal: "manager" })).resolves.toBeNull();
  });

  it("fails closed before authentication when the feature is disabled", async () => {
    vi.stubEnv("PROPLANE_TEST_WORKSPACES_ENABLED", "false");

    await expect(resolveSmsTestContext({
      portal: "resident",
      targetListingId: "listing-a",
    })).rejects.toThrow("unavailable");
    expect(mocks.getPortalAccessContext).not.toHaveBeenCalled();
    expect(mocks.getPublicListings).not.toHaveBeenCalled();
  });

  it("derives the prospect manager from the selected public listing", async () => {
    const db = applicationDb([]);
    mocks.serviceDb.mockReturnValue(db);

    const context = await resolveSmsTestContext({ portal: "resident", targetListingId: "listing-a" });

    expect(context).toMatchObject({
      mode: "prospect",
      stage: "prospect",
      managerUserId: OWNER,
      sessionKind: `leasing_sms_test:${OWNER}:listing-a`,
      actorEmail: "resident@example.com",
      target: { listingId: "listing-a", managerUserId: OWNER },
    });
    expect(db.query.eq).toHaveBeenCalledWith("manager_user_id", OWNER);
  });

  it("rejects a missing or forged target instead of accepting a client manager id", async () => {
    const db = applicationDb([]);
    mocks.serviceDb.mockReturnValue(db);
    await expect(resolveSmsTestContext({
      portal: "resident",
      targetListingId: OTHER_OWNER,
    })).resolves.toBeNull();
    // The only query is the capability's server-side application-scope read;
    // an invalid target never reaches a stage lookup.
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("switches only a submitted application for this listing owner to resident application scope", async () => {
    const db = applicationDb([{ row_data: { bucket: "pending" } }]);
    mocks.serviceDb.mockReturnValue(db);

    const context = await resolveSmsTestContext({ portal: "resident", targetListingId: "listing-a" });

    expect(context).toMatchObject({
      mode: "resident",
      stage: "submitted",
      managerUserId: OWNER,
      sessionKind: `resident_sms_test:${OWNER}:listing-a`,
      residentContext: {
        userId: ACTOR,
        email: "resident@example.com",
        managerIds: [OWNER],
        activeManagerId: OWNER,
        phase: "application",
      },
    });
  });

  it("limits an existing resident to the exact manager and listing linked by their active application", async () => {
    const db = {
      from: vi.fn((table: string) => {
        if (table === "manager_application_records") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [{
                manager_user_id: OWNER,
                property_id: "listing-a",
                assigned_property_id: null,
                row_data: { bucket: "approved", propertyId: "listing-a" },
              }],
              error: null,
            }),
          };
        }
        if (table === "manager_property_records") {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockResolvedValue({
              data: [{
                id: "listing-a",
                manager_user_id: OWNER,
                property_data: { title: "Oak Home", address: "1 Oak St" },
              }],
              error: null,
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };
    mocks.serviceDb.mockReturnValue(db);

    await expect(resolveSmsTestContext({
      portal: "resident",
      targetListingId: "listing-b",
    })).resolves.toBeNull();
    expect(db.from).toHaveBeenCalledTimes(1);
    expect(mocks.getPublicListings).toHaveBeenCalledWith({ testWorkspaceId: "workspace-a" });
  });

  it("rejects a turn when its stage re-check fails instead of degrading to prospect", async () => {
    const responses = [
      { data: [], error: null },
      { data: null, error: { message: "stage lookup offline" } },
    ];
    const db = {
      from: vi.fn(() => {
        const query = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          limit: vi.fn().mockImplementation(async () => responses.shift()),
        };
        return query;
      }),
    };
    mocks.serviceDb.mockReturnValue(db);

    await expect(resolveSmsTestContext({
      portal: "resident",
      targetListingId: "listing-a",
    })).rejects.toThrow("Could not verify the application stage");
  });
});
