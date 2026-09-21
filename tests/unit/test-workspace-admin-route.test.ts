import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  feature: vi.fn(),
  operator: vi.fn(),
  serviceDb: vi.fn(),
  postEmail: vi.fn(),
  ensureRole: vi.fn(),
}));

vi.mock("@/lib/test-workspaces/index.server", () => ({
  isTestWorkspaceFeatureEnabled: mocks.feature,
  requireTrustedTestWorkspaceOperator: mocks.operator,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.serviceDb }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: mocks.postEmail }));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: mocks.ensureRole }));

import { POST } from "@/app/api/admin/test-workspaces/route";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OPERATOR = "11111111-1111-4111-8111-111111111111";
const CREATED = "33333333-3333-4333-8333-333333333333";

function fakeDb() {
  const events: string[] = [];
  let createdProfileEmail: string | null = null;
  const members = {
    id: "member-a",
    workspace_id: WORKSPACE,
    user_id: CREATED,
    portal_role: "resident",
    state: "active",
    expires_at: "2099-01-01T00:00:00.000Z",
    created_at: "2026-09-18T00:00:00.000Z",
  };
  const db = {
    from(table: string) {
      type Query = {
        select(): Query;
        eq(): Query;
        insert(row: Record<string, unknown>): Query;
        maybeSingle(): Promise<{ data: unknown; error: unknown }>;
        single(): Promise<{ data: unknown; error: unknown }>;
      };
      const query: Query = {
        select() { return query; },
        eq() { return query; },
        insert(row: Record<string, unknown>) {
          if (table === "profiles" && typeof row.email === "string") createdProfileEmail = row.email;
          events.push(`${table}:insert`);
          return query;
        },
        maybeSingle: async () => {
          if (table === "test_workspaces") return { data: { id: WORKSPACE, status: "active" }, error: null };
          if (table === "test_workspace_members") return { data: { id: members.id }, error: null };
          if (table === "profiles") return { data: createdProfileEmail ? { email: createdProfileEmail } : null, error: null };
          return { data: null, error: null };
        },
        single: async () => {
          if (table === "test_workspace_members") return { data: members, error: null };
          return { data: { id: WORKSPACE, name: "QA", status: "active", created_at: "2026-09-18T00:00:00.000Z" }, error: null };
        },
      };
      return query;
    },
    auth: {
      admin: {
        listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })),
        createUser: vi.fn(async (input: Record<string, unknown>) => { events.push("auth:create"); return { data: { user: { id: CREATED, email: input.email } }, error: null }; }),
        generateLink: vi.fn(async () => { events.push("auth:generateLink"); return { data: { properties: { hashed_token: "invite-token-hash" } }, error: null }; }),
        updateUserById: vi.fn(async (_id: string, input: Record<string, unknown>) => { events.push(`auth:update:${input.ban_duration}`); return { data: { user: { id: CREATED } }, error: null }; }),
      },
    },
  };
  return { db, events };
}

function request() {
  return new Request("https://prop-lane.test/api/admin/test-workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "invite_member",
      workspaceId: WORKSPACE,
      email: "resident@example.com",
      fullName: "Resident Test",
      role: "resident",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  mocks.feature.mockReturnValue(true);
  mocks.operator.mockResolvedValue({ userId: OPERATOR });
  mocks.postEmail.mockResolvedValue({ ok: true, id: "email-1" });
});

describe("test workspace invite route", () => {
  it("creates and classifies the account before lifting the auth ban", async () => {
    const { db, events } = fakeDb();
    mocks.serviceDb.mockReturnValue(db);
    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(events.indexOf("test_workspace_members:insert")).toBeGreaterThan(events.indexOf("auth:create"));
    expect(events.indexOf("auth:update:none")).toBeGreaterThan(events.indexOf("test_workspace_members:insert"));
    expect(events).toContain("auth:update:none");
    expect(mocks.postEmail).toHaveBeenCalledOnce();
  });

  it("re-bans the account when private invite delivery fails", async () => {
    const { db, events } = fakeDb();
    mocks.serviceDb.mockReturnValue(db);
    mocks.postEmail.mockResolvedValue({ ok: false, error: "provider unavailable" });

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(events).toContain("auth:update:none");
    expect(events).toContain("auth:update:876000h");
    expect(events.lastIndexOf("auth:update:876000h")).toBeGreaterThan(events.indexOf("auth:update:none"));
  });
});
